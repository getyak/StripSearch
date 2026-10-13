#!/usr/bin/env python3
"""Generate an offline first-parent history draft without implying release."""
import argparse
import subprocess
from pathlib import Path


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="Excluded baseline commit/ref")
    parser.add_argument("--until", default="HEAD", help="Included commit/ref")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    base = git(root, "rev-parse", "--verify", "--end-of-options", args.since + "^{commit}")
    head = git(root, "rev-parse", "--verify", "--end-of-options", args.until + "^{commit}")
    subprocess.run(["git", "merge-base", "--is-ancestor", base, head], cwd=root, check=True)
    rows = git(root, "log", "--first-parent", "--reverse", "--date=short",
               "--format=%H%x09%ad%x09%s", base + ".." + head).splitlines()
    lines = ["# Git history changelog draft", "",
             f"范围：`{base[:7]}..{head[:7]}`，仅 first-parent 历史，起点不包含、终点包含。", "",
             "这是已提交变更清单，不证明对应功能已通过真人/外部 provider/部署验收。日期来自 git commit，复合提交标题不代表其全部验收范围。", "",
             "| 提交日期 | 提交 | 变更标题 |", "|---|---|---|"]
    for row in rows:
        sha, date, subject = row.split("\t", 2)
        subject = subject.replace("|", "\\|").replace("<", "&lt;").replace(">", "&gt;")
        lines.append(f"| {date} | [{sha[:7]}](https://github.com/getyak/StripSearch/commit/{sha}) | {subject} |")
    lines.extend(["", f"合计 {len(rows)} 个 first-parent 提交。当前冲刺工作见 [发布草稿](release-draft.md)与 [STATUS](../../../STATUS.md)。", ""])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines))
    print(f"Wrote {len(rows)} first-parent commits; {base[:7]}..{head[:7]}")


if __name__ == "__main__":
    main()
