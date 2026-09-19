const vscode = acquireVsCodeApi();

const $ = (id) => document.getElementById(id);

$("trace").addEventListener("click", () => {
  const start = $("start").value.trim();
  const end = $("end").value.trim();
  if (!start || !end) {
    setStatus("Set a start and an end point.");
    return;
  }
  setStatus("Working…");
  $("path").innerHTML = "";
  vscode.postMessage({ type: "trace", start, end, intent: $("intent").value.trim() });
});

function setStatus(text) {
  $("status").textContent = text;
}

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "point") {
    $(msg.which).value = msg.symbol;
  } else if (msg.type === "status") {
    setStatus(msg.text);
  } else if (msg.type === "error") {
    setStatus("⚠ " + msg.text);
  } else if (msg.type === "result") {
    setStatus(msg.verifyText.includes("VERIFIED") ? "✓ verified" : "✗ verification failed");
    renderPath(msg.record);
  } else if (msg.type === "list") {
    renderSaved(msg.traces);
  }
});

function renderSaved(traces) {
  const box = $("saved");
  box.innerHTML = "";
  $("saved-head").style.display = traces.length ? "block" : "none";
  traces.forEach((t) => {
    const row = document.createElement("div");
    row.className = "saved-row";
    row.title = t.intent || "";
    row.innerHTML = `<span class="saved-sym">${t.start}</span><span class="saved-arrow"> → </span><span class="saved-sym">${t.end}</span>`;
    row.addEventListener("click", () => {
      $("start").value = t.start || "";
      $("end").value = t.end || "";
      setStatus("Loading…");
      vscode.postMessage({ type: "loadTrace", file: t.file });
    });
    box.appendChild(row);
  });
}

function renderPath(record) {
  const container = $("path");
  container.innerHTML = "";

  record.path.forEach((node, i) => {
    const step = document.createElement("div");
    step.className = "node";

    const head = document.createElement("div");
    head.className = "sym";
    head.textContent = node.symbol;
    head.title = `${node.file}:${node.lines[0]}`;
    head.addEventListener("click", () =>
      vscode.postMessage({ type: "openNode", file: node.file, line: node.lines[0] })
    );
    step.appendChild(head);

    const carries = document.createElement("div");
    carries.className = "carries";
    carries.textContent = "carries: " + node.carries;
    step.appendChild(carries);

    container.appendChild(step);

    if (node.out_edge) {
      const edge = document.createElement("div");
      edge.className = "edge";
      edge.textContent = `↓ ${node.out_edge.kind}  L${node.out_edge.line}: ${node.out_edge.via}`;
      edge.title = node.out_edge.rationale;
      edge.addEventListener("click", () =>
        vscode.postMessage({ type: "openNode", file: node.file, line: node.out_edge.line })
      );
      container.appendChild(edge);
    }
  });

  const gaps = record.meta && record.meta.gaps ? record.meta.gaps : [];
  if (gaps.length) {
    const g = document.createElement("div");
    g.className = "gaps";
    g.textContent = "gaps: " + gaps.map((x) => `step ${x.step}: ${x.why}`).join(" · ");
    container.appendChild(g);
  }
}
