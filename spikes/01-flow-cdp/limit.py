# THROWAWAY spike: escalate concurrency until Flow refuses. Persists every step to a JSON file.
import re, time, json
import flow, burst
from flow import page, call

TOAST = '[role=alert], [role=status], .mat-mdc-snack-bar-label, mat-snack-bar-container, .toast'

def toasts():
    return [t for _, _, t in page('list', sel=TOAST) if t]

def run(prompts, log, send_timeout=20):
    st = {'rows': [], 'gen_done': [], 'done': {}}
    page('net')
    for i, pr in enumerate(prompts):
        prep = call('prep', tabId=flow.TAB, prompt=pr)['result']
        row = {'i': i, 'prompt': pr, 'prep_ok': prep['textMatches'] and not prep['submitDisabled']}
        if not row['prep_ok']:
            row['stage'] = 'rejected_before_dispatch'; row['state'] = page('state'); st['rows'].append(row); break
        s = page('trusted'); row['click_t'] = s.get('t'); t0 = time.time()
        while time.time() - t0 < send_timeout:
            time.sleep(0.25)
            for x in page('net'):
                if x['rpc'] in burst.GEN and x['phase'] == 'sent' and 'sent_t' not in row:
                    row['sent_t'] = x['t']; row['seed'], row['uuid'] = burst.seed_uuid(x['req'])
                if x['rpc'] in burst.GEN and x['phase'] == 'done':
                    st['gen_done'].append({'t': x['t'], 'status': x['status'], 'res': x['res'][:1500]})
            if 'sent_t' in row: break
        row['stage'] = 'accepted?' if 'sent_t' in row else 'uncertain'
        row['toasts'] = toasts()
        st['rows'].append(row); json.dump(st, open(log, 'w'), ensure_ascii=False)
        print(i, row['stage'], row.get('uuid', '')[:8] if row.get('uuid') else None, row['toasts'][:2])
        if row['stage'] == 'uncertain': break
    return st

def settle(log, wait=25):
    """after sending, gather generate responses (receipt or refusal) per uuid"""
    st = json.load(open(log)); t0 = time.time()
    while time.time() - t0 < wait:
        for x in page('net'):
            if x['rpc'] in burst.GEN and x['phase'] == 'done':
                st['gen_done'].append({'t': x['t'], 'status': x['status'], 'res': x['res'][:1500]})
        time.sleep(2)
    for r in st['rows']:
        hit = [g for g in st['gen_done'] if r.get('uuid') and r['uuid'] in g['res']]
        if hit:
            g = hit[0]; r['resp_status'] = g['status']
            m = re.findall(r'\\"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\"', g['res'])
            r['media'] = m[0] if m else None
            c = re.search(r'\[null,(\d+),', g['res']); r['credits'] = c and c.group(1)
            r['err'] = re.findall(r'PUBLIC_ERROR_[A-Z_]+|RESOURCE_EXHAUSTED|[A-Z_]{6,}LIMIT[A-Z_]*', g['res'])[:3]
    json.dump(st, open(log, 'w'), ensure_ascii=False)
    return st

def poll(log, limit=240):
    """mark finished videos by media id from jwpduf poll status"""
    st = json.load(open(log)); t0 = time.time()
    want = {r['media']: r for r in st['rows'] if r.get('media')}
    while time.time() - t0 < limit:
        for x in page('net'):
            if x['rpc'] != 'jwpduf' or x['phase'] != 'done': continue
            body = x['res'].replace('\\"', '"')
            for m, r in want.items():
                if m in r.get('_done', '') or str(m) in st['done']: continue
                i = body.find(f'"{m}"')
                if i < 0: continue
                seg = body[i:i + 1500]
                s = re.search(r'\],null,\[(\d)(?:,\[(\d+),"([A-Z_]+)"\])?', seg)
                if s and s.group(1) in ('3', '4'):
                    st['done'][m] = {'t': x['t'], 'code': s.group(1), 'why': s.group(3), 'after_s': round((x['t'] - r['sent_t']) / 1000)}
        json.dump(st, open(log, 'w'), ensure_ascii=False)
        if len(st['done']) >= len(want): break
        time.sleep(3)
    return st

def maxflight(st):
    ev = []
    for r in st['rows']:
        d = st['done'].get(r.get('media'))
        if d: ev += [(r['sent_t'], 1), (d['t'], -1)]
    c = m = 0
    for _, k in sorted(ev): c += k; m = max(m, c)
    return m
