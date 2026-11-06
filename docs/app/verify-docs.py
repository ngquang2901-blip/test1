#!/usr/bin/env python3
"""Check the ToolFlow design documents only. No browser or network access."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

BASE = Path(__file__).resolve().parent
PROJECT = BASE.parent.parent
CHAPTERS = [
    "00-product-scope.md", "01-screens-and-flows.md", "02-domain-and-state.md",
    "03-architecture-and-contracts.md", "04-flow-driver.md", "05-chatgpt-driver.md",
    "06-assets-and-downloads.md", "07-safety-and-recovery.md",
    "08-acceptance-and-delivery.md", "09-evidence-and-decisions.md",
]


def stripped(text):
    text = re.sub(r"^```[^\n]*\n.*?^```[^\n]*$", "", text, flags=re.M | re.S)
    return re.sub(r"`[^`\n]*`", "", text)


def check(base=BASE, project=PROJECT):
    errors = []
    required = [base / "README.md", *(base / name for name in CHAPTERS),
                project / "README.md", project / "docs/research/README.md"]
    for path in required:
        if not path.is_file():
            errors.append(f"Missing required file: {path}")
    if errors:
        return {"status": "FAIL", "errors": errors}
    docs = sorted(base.rglob("*.md")) + [project / "README.md", project / "docs/research/README.md"]
    texts = {p: p.read_text(encoding="utf-8") for p in docs}
    links = 0
    for path, text in texts.items():
        if not text.startswith("# "):
            errors.append(f"Missing document title: {path.name}")
        if len(re.findall(r"^```", text, re.M)) % 2:
            errors.append(f"Unclosed code fence: {path.name}")
        for match in re.finditer(r"\[[^\]\n]*\]\(([^)\n]+)\)", stripped(text)):
            raw = match.group(1)
            url = urlsplit(raw)
            if url.scheme or url.netloc or not url.path:
                continue
            target = (path.parent / unquote(url.path)).resolve()
            links += 1
            if not target.is_relative_to(project.resolve()):
                errors.append(f"Link outside project: {path.name}: {raw}")
            elif not target.exists():
                errors.append(f"Missing link target: {path.name}: {raw}")
    scope = texts[base / CHAPTERS[0]]
    acceptance = texts[base / CHAPTERS[8]]
    decisions = texts[base / CHAPTERS[9]]
    reqs = re.findall(r"^\|\s*(TF-\d+)\s*\|", scope, re.M)
    rows = re.findall(r"^\|\s*(AC-\d+)\s*\|\s*([^|]+)\|", acceptance, re.M)
    cases = [case for case, _ in rows]
    expected = {f"TF-{i:02d}" for i in range(1, 23)}
    if set(reqs) != expected or len(reqs) != len(expected):
        errors.append("Requirements must define TF-01 through TF-22 exactly once")
    if any(n != 1 for n in Counter(cases).values()):
        errors.append("Duplicate acceptance case ID")
    if set(cases) != {f"AC-{i:02d}" for i in range(1, 36)}:
        errors.append("Acceptance cases must define AC-01 through AC-35")
    coverage = {req: [] for req in reqs}
    for case, field in rows:
        refs = re.findall(r"TF-\d+", field)
        if not refs:
            errors.append(f"No requirement mapped: {case}")
        for ref in refs:
            if ref not in coverage:
                errors.append(f"Unknown requirement in {case}: {ref}")
            else:
                coverage[ref].append(case)
    for req, refs in coverage.items():
        if not refs:
            errors.append(f"Requirement has no acceptance case: {req}")
    for path, text in texts.items():
        unknown = set(re.findall(r"\bTF-\d+\b", text)) - expected
        if unknown:
            errors.append(f"Unknown requirement references in {path.name}: {sorted(unknown)}")
    checks = {
        "acceptance_not_run": "CHƯA CHẠY" in acceptance,
        "proposal_not_implementation": "chưa được cấp quyền triển khai" in acceptance,
        "confirmed_and_proposed_decisions_distinguished": all(
            term in decisions for term in ["XÁC NHẬN", "ĐỀ XUẤT", "CẦN CHỌN", "CHƯA KIỂM"]),
        "platform_decided_by_user": all(f"| D-{n} | XÁC NHẬN |" in decisions for n in (13, 14, 15, 16, 17)) and "Đã chốt: D-13" in decisions,
        "research_points_to_app": "../app/README.md" in texts[project / "docs/research/README.md"],
        "bridge_deferred_in_research": "Bridge/Max Speed: tạm gác" in texts[project / "docs/research/README.md"],
    }
    for name, passed in checks.items():
        if not passed:
            errors.append(f"Scope/status assertion failed: {name}")
    hashes = {str(p.relative_to(project)): hashlib.sha256(p.read_bytes()).hexdigest() for p in docs}
    validator = base / "verify-docs.py"
    if validator.is_file():
        hashes[str(validator.relative_to(project))] = hashlib.sha256(validator.read_bytes()).hexdigest()
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "status": "FAIL" if errors else "PASS",
        "scope": "DOCUMENTS_ONLY",
        "markdown_files_checked": len(docs),
        "app_chapters": len(CHAPTERS),
        "local_links_checked": links,
        "requirements": len(reqs), "acceptance_cases_specified": len(cases),
        "requirements_without_acceptance": [req for req, refs in coverage.items() if not refs],
        "coverage": coverage, "scope_checks": checks, "errors": errors,
        "product_implementation": "NOT STARTED",
        "product_tests": "NOT RUN", "provider_generation": "NOT RUN",
        "file_sha256": hashes,
        "limits": "Checks file/link existence, IDs, coverage and selected text assertions only; no semantic proof, external-link verification or live provider compatibility.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-receipt", action="store_true", help="Write the document-check receipt")
    args = parser.parse_args()
    result = check()
    if args.write_receipt:
        path = BASE / "evidence/verification.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if result["status"] == "FAIL":
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1
    print(f"PASS: {result['app_chapters']} app chapters; {result['requirements']} requirements; "
          f"{result['acceptance_cases_specified']} specified acceptance cases; "
          f"{result['local_links_checked']} local links. DOCUMENTS ONLY; product tests NOT RUN.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
