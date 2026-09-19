#!/usr/bin/env python3
"""codegps trace verifier.

A codegps trace record is an LLM-produced path connecting a start point to an
end point in a codebase, hop by hop. This tool does two mechanical checks the
LLM cannot be trusted to do for itself:

  1. staleness  - each node stores a hash of its symbol's current source. If the
                  source changed since the trace was recorded, that hop is stale
                  and should be re-traced.
  2. via-check  - each hop claims a `via` expression at a `line`. We confirm that
                  text actually exists there. This is the cheap guard against a
                  plausible-looking but fabricated hop.

Usage:
    python verify_trace.py TRACE.json            # verify + render
    python verify_trace.py TRACE.json --stamp    # (re)compute node hashes in place
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import sys
from pathlib import Path


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _find_symbol(tree: ast.AST, qualname: str) -> ast.AST | None:
    """Locate a def/class by dotted qualname (e.g. 'AgentHarness.prompt')."""
    parts = qualname.split(".")

    def walk(node: ast.AST, remaining: list[str]) -> ast.AST | None:
        head, rest = remaining[0], remaining[1:]
        for child in ast.iter_child_nodes(node):
            if isinstance(
                child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
            ) and child.name == head:
                if not rest:
                    return child
                return walk(child, rest)
        return None

    return walk(tree, parts)


def _symbol_source(repo: Path, node: dict) -> tuple[str | None, str | None]:
    """Return (source_text, error) for a node's symbol."""
    file = repo / node["file"]
    if not file.exists():
        return None, f"file not found: {node['file']}"
    src = file.read_text()
    module, _, qualname = node["symbol"].partition(":")
    try:
        tree = ast.parse(src, filename=str(file))
    except SyntaxError as e:
        return None, f"could not parse {node['file']}: {e}"
    sym = _find_symbol(tree, qualname)
    if sym is None:
        return None, f"symbol not found: {qualname}"
    segment = ast.get_source_segment(src, sym)
    return segment, None


def stamp(record: dict, repo: Path) -> dict:
    for node in record["path"]:
        segment, err = _symbol_source(repo, node)
        if err:
            print(f"  ! step {node['step']}: {err}", file=sys.stderr)
            continue
        node["body_sha"] = _sha(segment)
    return record


def verify(record: dict, repo: Path) -> bool:
    ok = True
    print(f"query : {record['query']['start']}  ->  {record['query']['end']}")
    print(f"intent: {record['query'].get('intent', '')}\n")

    for node in record["path"]:
        step = node["step"]
        label = f"[{step}] {node['symbol']}"

        # staleness
        segment, err = _symbol_source(repo, node)
        if err:
            print(f"{label}\n    STALE   {err}")
            ok = False
            continue
        current = _sha(segment)
        if node.get("body_sha") and current != node["body_sha"]:
            print(f"{label}\n    STALE   source changed ({node['body_sha']} -> {current})")
            ok = False
        else:
            print(f"{label}   fresh")

        # via-check on the out edge
        edge = node.get("out_edge")
        if not edge:
            print(f"    (endpoint)")
            continue
        file = repo / node["file"]
        lines = file.read_text().splitlines()
        ln = edge["line"]
        line_text = lines[ln - 1] if 0 < ln <= len(lines) else ""
        if edge["via"] in line_text:
            print(f"    via OK  L{ln}: {edge['via']}  --{edge['kind']}--> [{edge['to_step']}]")
        else:
            print(f"    via BAD L{ln}: expected `{edge['via']}`, found: {line_text.strip()!r}")
            ok = False

    gaps = record.get("meta", {}).get("gaps", [])
    if gaps:
        print("\ngaps (LLM-flagged low-confidence hops):")
        for g in gaps:
            print(f"  - step {g['step']}: {g['why']}")

    print(f"\nresult: {'VERIFIED' if ok else 'FAILED'}")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("trace", type=Path)
    ap.add_argument("--stamp", action="store_true", help="recompute node hashes and save")
    args = ap.parse_args()

    record = json.loads(args.trace.read_text())
    repo = Path(record["meta"]["repo_root"]).expanduser()

    if args.stamp:
        record = stamp(record, repo)
        args.trace.write_text(json.dumps(record, indent=2) + "\n")
        print(f"stamped hashes into {args.trace}")
        return 0

    return 0 if verify(record, repo) else 1


if __name__ == "__main__":
    raise SystemExit(main())
