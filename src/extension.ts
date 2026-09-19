import * as vscode from "vscode";
import { spawn, execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function scriptsDir(extensionPath: string): string {
  const cfg = vscode.workspace.getConfiguration("codegps").get<string>("scriptsDir");
  // Default to the helpers bundled inside the extension, so it works in any
  // workspace without the user copying verify_trace.py / symbol_at.py around.
  return cfg && cfg.length ? cfg : path.join(extensionPath, "scripts");
}

function slugify(start: string, end: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  return `${clean(start)}__${clean(end)}`.slice(0, 120);
}

// Run a python helper, resolve its stdout.
function runPython(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("python3", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

class CodegpsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lastRepoRoot?: string;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.ctx.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "trace") await this.trace(msg.start, msg.end, msg.intent);
      else if (msg.type === "openNode") this.openNode(msg.file, msg.line);
      else if (msg.type === "loadTrace") await this.loadTrace(msg.file);
      else if (msg.type === "listTraces") this.listTraces();
    });

    this.listTraces();
  }

  private scripts(): string {
    return scriptsDir(this.ctx.extensionPath);
  }

  private tracesDir(): string | undefined {
    const root = workspaceRoot();
    return root ? path.join(root, "traces") : undefined;
  }

  // Scan traces/ and send a summary list to the sidebar.
  private listTraces(): void {
    const dir = this.tracesDir();
    if (!dir || !fs.existsSync(dir)) {
      this.post({ type: "list", traces: [] });
      return;
    }
    const traces = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const file = path.join(dir, f);
        try {
          const rec = JSON.parse(fs.readFileSync(file, "utf8"));
          return { file, start: rec.query?.start, end: rec.query?.end, intent: rec.query?.intent };
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    this.post({ type: "list", traces });
  }

  // Open a saved record: verify it (catches drift), then render.
  private async loadTrace(file: string): Promise<void> {
    const root = workspaceRoot();
    if (!root || !fs.existsSync(file)) return;
    this.lastRepoRoot = root;
    const passed = await this.verify(file, root);
    this.post({
      type: "status",
      text: passed.ok ? "Loaded saved trace (verified)." : "Saved trace is stale — re-trace to refresh.",
    });
    this.deliver(file, passed.text);
  }

  // Capture the cursor's enclosing symbol and push it into the form.
  async setPoint(which: "start" | "end"): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const root = workspaceRoot();
    if (!editor || !root) {
      vscode.window.showWarningMessage("codegps: open a file and place the cursor inside a function.");
      return;
    }
    const line = editor.selection.active.line + 1; // 1-based
    try {
      const out = await runPython(
        [path.join(this.scripts(), "symbol_at.py"), root, editor.document.uri.fsPath, String(line)],
        root
      );
      const info = JSON.parse(out);
      if (info.error) throw new Error(info.error);
      this.view?.webview.postMessage({ type: "point", which, symbol: info.symbol });
    } catch (e: any) {
      vscode.window.showErrorMessage(`codegps: ${e.message}`);
    }
  }

  private async trace(start: string, end: string, intent: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) return;
    this.lastRepoRoot = root;

    const rel = path.join("traces", `${slugify(start, end)}.json`);
    const outPath = path.join(root, rel);

    // Reuse: if a verified record already exists, skip the LLM entirely.
    if (fs.existsSync(outPath)) {
      const passed = await this.verify(outPath, root);
      if (passed.ok) {
        this.post({ type: "status", text: "Reused saved trace (verified) — no tokens spent." });
        this.deliver(outPath, passed.text);
        return;
      }
    }

    this.post({ type: "status", text: "Tracing with Claude Code…" });
    const claude = vscode.workspace.getConfiguration("codegps").get<string>("claudePath") || "claude";
    const verifier = path.join(this.scripts(), "verify_trace.py");
    const prompt =
      `Use the tracer subagent to trace data flow from ${start} to ${end}. ` +
      `Intent: ${intent || "connect the two points"}. ` +
      `repo_root is ${root}. Write the record to ${rel}. ` +
      `Verify with: python3 "${verifier}" ${rel} --stamp && python3 "${verifier}" ${rel}. ` +
      `Fix any hop the verifier reports as "via BAD" or "STALE", then re-verify until it reports VERIFIED.`;

    const child = spawn(claude, ["-p", prompt, "--permission-mode", "acceptEdits"], { cwd: root });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => this.post({ type: "error", text: `Could not launch Claude Code: ${e.message}` }));
    child.on("close", async (code) => {
      if (!fs.existsSync(outPath)) {
        this.post({ type: "error", text: `Tracer produced no record (exit ${code}). ${stderr}` });
        return;
      }
      const passed = await this.verify(outPath, root);
      this.post({ type: "status", text: passed.ok ? "Traced and verified." : "Traced, but verification failed." });
      this.deliver(outPath, passed.text);
      this.listTraces();
    });
  }

  private async verify(outPath: string, root: string): Promise<{ ok: boolean; text: string }> {
    const script = path.join(this.scripts(), "verify_trace.py");
    try {
      await runPython([script, outPath, "--stamp"], root);
      const text = await runPython([script, outPath], root);
      return { ok: text.includes("VERIFIED"), text };
    } catch (e: any) {
      return { ok: false, text: e.message };
    }
  }

  private deliver(outPath: string, verifyText: string): void {
    const record = JSON.parse(fs.readFileSync(outPath, "utf8"));
    this.post({ type: "result", record, verifyText });
  }

  private openNode(file: string, line: number): void {
    const root = this.lastRepoRoot ?? workspaceRoot();
    if (!root) return;
    const uri = vscode.Uri.file(path.isAbsolute(file) ? file : path.join(root, file));
    vscode.window.showTextDocument(uri).then((editor) => {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    });
  }

  private post(msg: any): void {
    this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const uri = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", f));
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${uri("main.css")}"></head>
<body>
  <label>Start<input id="start" placeholder="pkg.mod:func"></label>
  <label>End<input id="end" placeholder="pkg.mod:Class.method"></label>
  <label>Intent<input id="intent" placeholder="what value are you following?"></label>
  <button id="trace">Trace</button>
  <div id="status"></div>
  <div id="path"></div>
  <div id="saved-head" class="section-head">Saved traces</div>
  <div id="saved"></div>
  <script src="${uri("main.js")}"></script>
</body></html>`;
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const provider = new CodegpsViewProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codegps.panel", provider),
    vscode.commands.registerCommand("codegps.setStart", () => provider.setPoint("start")),
    vscode.commands.registerCommand("codegps.setEnd", () => provider.setPoint("end"))
  );
}

export function deactivate(): void {}
