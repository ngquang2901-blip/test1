#!/usr/bin/env python3
"""Verify pinned public sources, native-RPC anchors and corrected helper types offline."""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
contract = json.loads((HERE / 'flow-native-public-contract.json').read_text())
manifest = json.loads((HERE / 'native-sources/manifest.json').read_text())
sources = {}
for entry in manifest['files']:
    data = (HERE / 'native-sources' / entry['name']).read_bytes()
    assert len(data) == entry['bytes'], entry['name']
    assert hashlib.sha256(data).hexdigest() == entry['sha256'], entry['name']
    sources[entry['name']] = data.decode('utf-8')

count = 0

def check(file, offset, anchor):
    global count
    assert offset >= 0 and anchor, (file, offset)
    assert sources[file][offset:offset + len(anchor)] == anchor, (file, offset)
    count += 1

part = contract['pass2']
for row in part['rows']:
    for file, anchors in row['anchors'].items():
        if anchors['def_off'] < 0:
            assert row['rpc_id'] == 'heTLee' and file == 'flow-boq-m_wO1vlb.js'
            continue
        check(file, anchors['def_off'], anchors['def_snip'])
        check(file, anchors['call_off'], anchors['call_snip'])
for helper in part['transport']['setter_legend']:
    check('flow-boq-m_b.js', helper['off'], helper['snip'])
for anchor in part['extra_anchors']:
    check(anchor['file'], anchor['off'], anchor['snip'])
correction = part['transport']['type_correction_by_parent']
for anchor in correction['anchors']:
    check(correction['source'], anchor['off'], anchor['snip'])
# Np checks strings via Tb; it is not an int64 parser. Dz/Yq validate enums via Bb.
base = sources['flow-boq-m_b.js']
assert '_.Np=function(a,b,c,d){return _.mz(a,b,Tb(c),d)}' in base
assert 'Tb=function(a){if(a!=null&&typeof a!=="string")throw Error();return a}' in base
assert '_.Dz=function(a,b,c){return _.Pc(a,b,c==null?c:_.Bb(c),0)}' in base
assert '_.Bb=function(a){if(!zb(a))throw Ia("enum");return a|0}' in base
assert all('int64' not in row['request_fields_from_callsite'] for row in part['rows'])
assert len({row['rpc_id'] for row in part['rows']}) == len(part['rows']) == 24
for file, expected in [('flow-boq-m_wO1vlb.js', 109), ('flow-boq-m_XRV0Af.js', 112)]:
    assert sources[file].count('Wa:"') == expected, file
print(f'PASS: {len(sources)} pinned files, {count} anchors, {len(part["rows"])} unique RPC mappings; helper-type checks passed')
