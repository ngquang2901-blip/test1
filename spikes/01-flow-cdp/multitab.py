# THROWAWAY spike: multi-tab concurrency probe. One collector per tab owns the net buffer.
import re, time, json, threading
from drive import call
import burst

UUID = r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'

def pg(tab, fn, **a):
    return call('page', tabId=tab, fn=fn, args=a).get('result')

def toasts(tab):
    r = pg(tab, 'list', sel='[role=alert], [role=status], .mat-mdc-snack-bar-label, mat-snack-bar-container')
    return [t for _, _, t in (r or []) if t]

class Probe:
    def __init__(self, tabs, log):
        self.tabs, self.log, self.lock, self.stop = tabs, log, threading.Lock(), False
        self.rows, self.sent, self.status = [], {t: [] for t in tabs}, {}  # status: media -> (code, why, t)

    def collect(self, tab):
        while not self.stop:
            try: recs = pg(tab, 'net') or []
            except Exception: recs = []
            with self.lock:
                for x in recs:
                    if x['rpc'] in burst.GEN and x['phase'] == 'sent':
                        self.sent[tab].append(x)
                    elif x['rpc'] in burst.GEN and x['phase'] == 'done':
                        for r in self.rows:
                            if r.get('uuid') and r['uuid'] in x['res'] and 'resp_t' not in r:
                                r['resp_t'], r['resp_status'] = x['t'], x['status']
                                m = re.findall(r'\\"' + UUID + r'\\"', x['res']); r['media'] = m[0] if m else None
                                c = re.search(r'\[null,(\d+),', x['res']); r['credits'] = c and int(c.group(1))
                        if x['status'] != 200 or 'PUBLIC_ERROR' in x['res'] or 'RESOURCE_EXHAUSTED' in x['res']:
                            self.rows.append({'tab': tab, 'refusal': x['res'][:800], 't': x['t'], 'status': x['status']})
                    elif x['rpc'] == 'jwpduf' and x['phase'] == 'done':
                        body = x['res'].replace('\\"', '"')
                        for m in re.findall(r'"' + UUID + r'",null,null,\[\[\d+', body):
                            seg = body[body.find(f'"{m}"'):][:2000]
                            s = re.search(r'null,1\],null,\[(\d)(?:,\[(\d+),"([A-Z_]+)"\])?', seg)
                            if s:
                                prev = self.status.get(m)
                                if not prev or prev[0] != s.group(1): self.status[m] = (s.group(1), s.group(3), x['t'])
                self.dump()
            time.sleep(1.5)

    def dump(self):
        json.dump({'rows': self.rows, 'status': self.status}, open(self.log, 'w'), ensure_ascii=False)

    def send(self, tab, prompts, wait_receipt=True):
        for pr in prompts:
            if getattr(self, 'halt', False) or any(r.get('refusal') for r in self.rows): return
            prep = call('prep', tabId=tab, prompt=pr)['result']
            row = {'tab': tab, 'prompt': pr}
            if prep is None or prep.get('submitDisabled') is None:  # submit replaced by "Cảnh báo về việc không đủ tín dụng"
                row['stage'] = 'insufficient_credit_client'; self.rows.append(row); self.halt = True; return
            for _ in range(20):  # submit can stay disabled a few seconds after typing (seen in background tabs)
                if not prep['submitDisabled']: break
                time.sleep(0.5); st = pg(tab, 'state'); prep['submitDisabled'] = st['submitDisabled']; prep['textMatches'] = st['text'].strip() == pr
            with self.lock: self.rows.append(row); n0 = len(self.sent[tab])
            if not prep['textMatches'] or prep['submitDisabled']:
                row['stage'] = 'rejected_before_dispatch'; return
            row['click_t'] = pg(tab, 'trusted').get('t'); t0 = time.time()
            while time.time() - t0 < 40:
                time.sleep(0.3)
                with self.lock:
                    if len(self.sent[tab]) > n0:
                        x = self.sent[tab][n0]; row['sent_t'] = x['t']; row['seed'], row['uuid'] = burst.seed_uuid(x['req']); break
            if 'sent_t' not in row:
                row['stage'] = 'uncertain'; row['toasts'] = toasts(tab); self.halt = True; return
            row['stage'] = 'sent'
            if not wait_receipt: continue  # images: Flow client does not serialise, the response is the result
            # wait for receipt or refusal before the next one (Flow client serialises anyway)
            t0 = time.time()
            while time.time() - t0 < 40 and 'resp_t' not in row: time.sleep(0.3)
            row['toasts'] = toasts(tab)
            if row.get('resp_status') != 200 or not row.get('media'):
                row['stage'] = 'refused'; self.halt = True; return
            if any(s[0] == '4' and s[1] != 'INTERNAL' for s in self.status.values()):
                self.halt = True; return

    def inflight(self):
        """max videos rendering at once (from receipt to poll status 3/4)"""
        ev = []
        for r in self.rows:
            s = self.status.get(r.get('media'))
            if r.get('resp_t') and s and s[0] in '34': ev += [(r['resp_t'], 1), (s[2], -1)]
        c = m = 0
        for _, k in sorted(ev): c += k; m = max(m, c)
        return m
