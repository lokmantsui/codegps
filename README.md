# codegps (VS Code extension)

GPS for code. Pick a **start** and an **end** point in a Python codebase; an LLM
traces how data flows between them and draws the path in the sidebar. Traces are
saved to `traces/*.json` and reused, so the next question over the same chain
costs no tokens.

## How it works

1. The sidebar sends your start/end/intent to the `tracer` Claude Code subagent
   (`.claude/agents/tracer.md`) via `claude -p`.
2. The subagent walks the code and writes a trace record to `traces/<slug>.json`.
3. `verify_trace.py` stamps content hashes and mechanically checks every hop's
   `via` expression really exists at its line — the guard against fabricated hops.
4. The verified path renders as clickable nodes; clicking jumps to `file:line`.
5. On the next run for the same start/end, if the saved record still verifies,
   it is returned directly — **no LLM call**.

## Requirements

- [Claude Code](https://claude.com/claude-code) CLI on `PATH` (or set
  `codegps.claudePath`).
- `python3` on `PATH`.

The Python helpers (`verify_trace.py`, `symbol_at.py`) are **bundled inside the
extension** (`scripts/`), so it works in any workspace. Point `codegps.scriptsDir`
elsewhere only if you want to override them.

## Run it (dev)

1. `npm install`
2. Open this `codegps` folder in VS Code, press **F5**. This launches an
   Extension Development Host with the same folder as the workspace (so the
   `pipy` symlink and `traces/` are visible to trace against).
3. Click the codegps icon in the activity bar.

## Set points

- Type symbol ids (`pkg.mod:func`, `pkg.mod:Class.method`) into the fields, **or**
- Put the cursor inside a function and run **codegps: Set Start at Cursor** /
  **Set End at Cursor** from the editor right-click menu.

## Saved traces

Every verified trace is written to `traces/*.json` in the workspace and listed at
the bottom of the sidebar. Click one to reload it — the extension re-verifies it
first, so a stale record (source changed since it was recorded) is flagged rather
than shown as if still true. Re-tracing a start/end that already has a fresh
record reuses it with **no LLM call**.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `codegps.claudePath` | `claude` | Claude Code CLI path |
| `codegps.scriptsDir` | (workspace root) | Where the `.py` helpers live |
