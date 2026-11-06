# THROWAWAY spike: send N prompts back-to-back (auto D-12), correlate by seed/UUID from the network observer.
import re, time, json
import flow
from flow import page, call

GEN = ('ogiZ0b', 'YhhmEf', 'MZZa6b', 'eb1hJf', 'nprQif')

def seed_uuid(req):
    m = re.search(r'\[null,null,null,(\d+),\d+,', req)  # field after seed: 1 for 1:1, 2 for 9:16 (likely aspect code)
    u = re.findall(r'([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})', req)
    return (m.group(1) if m else None), (u[-1] if u else None)

def burst(prompts, send_timeout=15):
    """returns attempts list + every net record seen"""
    page('net'); allnet = []; attempts = []
    for i, pr in enumerate(prompts):
        prep = call('prep', tabId=flow.TAB, prompt=pr)['result']
        if not prep['textMatches'] or prep['submitDisabled']:
            attempts.append({'i': i, 'stage': 'rejected_before_dispatch', 'prep': prep}); continue
        s = page('trusted'); t0 = time.time(); sent = None
        while time.time() - t0 < send_timeout:
            time.sleep(0.25); g = page('net'); allnet += g
            got = [x for x in g if x['phase'] == 'sent' and x['rpc'] in GEN]
            if got: sent = got[0]; break
        a = {'i': i, 'prompt': pr, 'called': s.get('called'), 'click_t': s.get('t')}
        if sent:
            a.update(stage='accepted', rpc=sent['rpc'], sent_t=sent['t'])
            a['seed'], a['uuid'] = seed_uuid(sent['req'])
        else:
            a['stage'] = 'uncertain'; a['composer'] = page('state')
        attempts.append(a)
        print(i, a['stage'], a.get('seed'), a.get('uuid', '')[:8] if a.get('uuid') else None, 'Δsend', (a.get('sent_t', 0) - (a['click_t'] or 0)) / 1000 if a.get('sent_t') else None)
    return attempts, allnet

def collect(attempts, allnet, timeout=240, step=3):
    t0 = time.time(); want = {a['uuid'] for a in attempts if a.get('uuid')}
    res = {}
    while time.time() - t0 < timeout:
        allnet += page('net')
        for x in allnet:
            if x['phase'] == 'done' and x['rpc'] in GEN:
                for a in attempts:
                    if a.get('uuid') and a['uuid'] in x['res'] and a['uuid'] not in res:
                        ids = re.findall(r'\\"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\"', x['res'])
                        err = re.findall(r'PUBLIC_ERROR_[A-Z_]+|[A-Z_]*FILTERED', x['res'])
                        res[a['uuid']] = {'t': x['t'], 'status': x['status'], 'media': ids[0] if ids else None, 'err': err[:2], 'raw': x['res'][:300]}
        if want <= set(res): break
        time.sleep(step)
    return round(time.time() - t0), res
