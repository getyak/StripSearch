#!/usr/bin/env python3
"""Offline TypeScript import/size/churn inventory; not runtime coverage."""
import argparse
import json
import re
import subprocess
from collections import Counter
from pathlib import Path


def inventory(root: Path, history_limit: int = 40) -> dict:
    source = root / "apps/web/src"
    paths = sorted(source.rglob("*.ts"))
    names = {p.resolve(): p.relative_to(root).as_posix() for p in paths}
    imports = re.compile(r"\bfrom\s*['\"]([^'\"]+)['\"]|\bimport\s*(?:\(\s*)?['\"]([^'\"]+)['\"]")
    graph, nodes = {}, []
    churn = Counter(subprocess.run(
        ["git", "log", "--first-parent", f"-{history_limit}", "--format=", "--name-only", "--", "apps/web/src"],
        cwd=root, check=True, capture_output=True, text=True,
    ).stdout.splitlines())
    for path in paths:
        name = names[path.resolve()]
        text = path.read_text()
        dependencies = set()
        for match in imports.finditer(text):
            specifier = match[1] or match[2]
            if not specifier.startswith("."):
                continue
            target = path.parent / specifier
            candidates = [target, target.with_suffix(".ts"), target / "index.ts"]
            for candidate in candidates:
                resolved = candidate.resolve()
                if resolved in names:
                    dependencies.add(names[resolved])
                    break
        graph[name] = sorted(dependencies)
        nodes.append({"path": name, "lines": len(text.splitlines()),
                      "history_touches": churn[name], "imports": sorted(dependencies)})
    incoming = Counter(dep for dependencies in graph.values() for dep in dependencies)
    tests = [name for name in graph if "/tests/" in name and name.endswith(".test.ts")]
    reach = Counter()
    for test in tests:
        pending, seen = [test], set()
        while pending:
            name = pending.pop()
            if name in seen:
                continue
            seen.add(name)
            pending.extend(graph.get(name, []))
        reach.update(seen - {test})
    for node in nodes:
        node["incoming_imports"] = incoming[node["path"]]
        node["test_files_reaching"] = reach[node["path"]]
    production = [node for node in nodes if "/tests/" not in node["path"] and "/evals/" not in node["path"]]
    return {"schema": "stripsearch/architecture-inventory/v1",
            "base_revision": subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True).stdout.strip(),
            "history_limit": history_limit,
            "method": "Regex-resolved relative TS imports, including type imports; reach is not executed coverage. Churn counts first-parent file touches, not defects. Comments may match and computed imports are omitted.",
            "counts": {"typescript_files": len(nodes), "production_files": len(production), "test_files": len(tests)},
            "largest_modules": sorted(production, key=lambda n: (-n["lines"], n["path"]))[:15],
            "nodes": nodes}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--history-limit", type=int, default=40)
    args = parser.parse_args()
    if args.history_limit < 1:
        parser.error("history-limit must be positive")
    result = inventory(Path(__file__).resolve().parents[1], args.history_limit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"counts": result["counts"], "largest_modules": [
        {key: node[key] for key in ("path", "lines", "history_touches", "incoming_imports", "test_files_reaching")}
        for node in result["largest_modules"]]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
