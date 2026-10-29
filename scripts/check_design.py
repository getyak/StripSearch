#!/usr/bin/env python3
"""Offline integrity checks for authored artifacts, not research evaluations."""

import json
import os
import re
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]


def read_json(relative):
    return json.loads((ROOT / relative).read_text())


def require(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


def unique_index(items, key):
    result = {item[key]: item for item in items}
    require(len(result) == len(items), f"duplicate {key}")
    return result


fixtures = read_json("evals/fixtures.json")
require(fixtures["network_access"] is False, "fixtures must be offline")
sources = unique_index(fixtures["sources"], "source_id")
cases = [json.loads(line) for line in (ROOT / "evals/cases.jsonl").read_text().splitlines() if line]
unique_index(cases, "case_id")
require(len(cases) == 12 and len(sources) == 12, "update dataset card when counts change")
for source in sources.values():
    require(urlparse(source["url"]).hostname == "example.org", "fixture URL must be synthetic")
    require(source["redistribution"] == "Apache-2.0-original-synthetic", "missing fixture license")
    require(source["source"] == "synthetic", "non-synthetic source")
    if source["fetch_status"] == "inaccessible":
        require(source["body"] is None, "inaccessible source cannot contain a fetched body")
for case in cases:
    require(set(case["available_source_ids"]) <= sources.keys(), f"unknown source in {case['case_id']}")
    require((case["source"], case["split"], case["review_status"]) ==
            ("synthetic", "discovery", "unreviewed"), "seed provenance or review status changed")
    require(case["required_assertions"] and case["forbidden_assertions"], "empty case rubric")

request = read_json("examples/request.json")
require(request["execution"] == {"mode": "fixture", "network_access": False}, "example must be offline")
report = read_json("examples/report.json")
data = report["data"]
require(data["synthetic"] and data["usage"]["measurement_status"] == "not_run", "example is not an evaluation")
people = unique_index(data["people_index"], "person_id")
report_sources = unique_index(data["sources"], "source_id")
evidence = unique_index(data["evidence"], "evidence_id")
claims = unique_index(data["claims"], "claim_id")
events = unique_index(data["events"], "event_id")
links = {(link["person_id"], link["source_id"]): link for link in data["identity_links"]}
md = (ROOT / "examples/report.md").read_text()
require(report["run_id"] in md, "Markdown/JSON run mismatch")
for person in people.values():
    require(f'id="{person["report_anchor"]}"' in md, "missing person anchor")
    require(set(person["identity_evidence_ids"]) <= evidence.keys(), "unknown identity evidence")
    for link in person["profile_links"]:
        require(link["url"] in md and set(link["evidence_ids"]) <= evidence.keys(), "bad profile link")
for item in evidence.values():
    require(item["source_id"] in report_sources, "unknown evidence source")
    require(item["excerpt"] in sources[item["source_id"]]["body"], "excerpt absent from fixture")
for link in links.values():
    require(link["person_id"] in people and link["source_id"] in report_sources, "bad identity link")
    require(set(link["basis_evidence_ids"]) <= evidence.keys(), "bad identity basis")
for claim in claims.values():
    require(claim["person_id"] in people, "unknown claim person")
    require(claim["claim_id"] in md and claim["statement"] in md, "Markdown omitted or changed claim")
    for eid in claim["support_evidence_ids"] + claim["refute_evidence_ids"]:
        require(eid in evidence, "unknown claim evidence")
        source_id = evidence[eid]["source_id"]
        require(links[(claim["person_id"], source_id)]["state"] == "linked", "claim uses unlinked source")
for source in report_sources.values():
    require(source["canonical_url"] in md, "Markdown missing canonical source URL")
for event in events.values():
    require(event["person_id"] in people, "unknown event person")
    require(set(event["action_claim_ids"] + event["outcome_claim_ids"]) <= claims.keys(), "bad event claim")
for unknown in data["unknowns"]:
    require(unknown in md, "Markdown missing uncertainty")

def authored_markdown():
    # Installed packages and local research archives are not design artifacts.
    # Prune before descent, so installing a probe cannot invalidate this check.
    ignored = {".git", "node_modules", ".venv", "__pycache__", "dist", "coverage",
               "data", "workspace", "runs", "archives", "_private", ".symphony", ".cursor", ".impeccable"}
    for directory, subdirs, filenames in os.walk(ROOT):
        subdirs[:] = [name for name in subdirs if name not in ignored]
        for filename in filenames:
            if filename.endswith(".md"):
                yield Path(directory) / filename


for path in authored_markdown():
    text = path.read_text()
    for href in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
        if urlparse(href).scheme or href.startswith("#"):
            continue
        target = (path.parent / unquote(href.split("#", 1)[0])).resolve()
        require(target.exists(), f"broken local link: {path.relative_to(ROOT)} -> {href}")
    require("/Users/" not in text and "app.notion.com/p/" not in text, "private path/page in public docs")

print("PASS: local links, 12 synthetic cases, 12 sources, report references and authored format parity.")
print("This static check does not measure network, model, provider, MCP runtime or benchmark behavior.")
