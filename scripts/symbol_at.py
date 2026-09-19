#!/usr/bin/env python3
"""Resolve a codegps symbol id (module:qualname) from a file + line.

Used by the VS Code extension's "capture cursor as start/end" command: given the
active file and the cursor's 1-based line, print the enclosing def/class as a
`module:qualname` id, plus the symbol's line span, as JSON.

    python symbol_at.py REPO_ROOT path/to/file.py 42
    -> {"symbol": "pkg.mod:Class.method", "file": "path/to/file.py", "lines": [40, 58]}
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path


def module_path(repo: Path, file: Path) -> str:
    rel = file.resolve().relative_to(repo.resolve())
    parts = list(rel.with_suffix("").parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def enclosing(tree: ast.AST, line: int) -> tuple[str, int, int] | None:
    """Deepest def/class whose body spans `line`. Returns (qualname, start, end)."""
    best: tuple[str, int, int] | None = None

    def walk(node: ast.AST, prefix: list[str]) -> None:
        nonlocal best
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                start = child.lineno
                end = getattr(child, "end_lineno", start)
                qual = prefix + [child.name]
                if start <= line <= end:
                    best = (".".join(qual), start, end)  # deeper wins, later overwrite
                walk(child, qual)

    walk(tree, [])
    return best


def main() -> int:
    repo, file_arg, line_arg = sys.argv[1], sys.argv[2], int(sys.argv[3])
    repo_path = Path(repo)
    file_path = Path(file_arg)
    src = file_path.read_text()
    tree = ast.parse(src, filename=str(file_path))
    found = enclosing(tree, line_arg)
    if found is None:
        print(json.dumps({"error": "no enclosing def/class at that line"}))
        return 1
    qualname, start, end = found
    rel = str(file_path.resolve().relative_to(repo_path.resolve()))
    lines = src.splitlines()
    line_text = lines[line_arg - 1].strip() if 0 < line_arg <= len(lines) else ""
    print(json.dumps({
        "symbol": f"{module_path(repo_path, file_path)}:{qualname}",
        "file": rel,
        "lines": [start, end],
        "cursor_line": line_arg,
        "line_text": line_text,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
