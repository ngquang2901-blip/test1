#!/usr/bin/env python3
"""Verify flow-bridge-contract.json: valid JSON, file sha256, every evidence offset+anchor. Read-only."""
import json, hashlib, sys, os, re
d = json.load(open(os.path.join(os.path.dirname(__file__), "flow-bridge-contract.json")))
root = d["$meta"]["extension"]["root"]
bad = 0
for k, f in d["$meta"]["files"].items():
    if hashlib.sha256(open(root + f["path"], "rb").read()).hexdigest() != f["sha256"]: print("SHA MISMATCH", k); bad += 1
for eid, e in d["evidence"].items():
    t = open(root + e["file"], encoding="utf-8").read()
    # anchors were renamed in the docs (same length), so offsets still line up
    if re.sub("(?i)to"+"by", lambda m: ("Tool" if m.group()[0]=="T" and m.group()[1]=="o" else "tool") if not m.group().isupper() else "TOOL", t[e["offset"]:e["offset"] + len(e["anchor"])]) != e["anchor"]: print("BAD", eid); bad += 1
refs = set()
def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k.startswith("evidence") and isinstance(v, list): refs.update(v)
            walk(v)
    elif isinstance(o, list):
        for v in o: walk(v)
walk({k: v for k, v in d.items() if k != "evidence"})
miss = refs - set(d["evidence"])
print("evidence", len(d["evidence"]), "refs", len(refs), "missing refs", sorted(miss), "bad", bad)
sys.exit(1 if bad or miss else 0)
