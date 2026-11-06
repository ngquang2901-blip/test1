# THROWAWAY spike helpers for the content-script + D-12 path (no debugger).
import json, re, time
from drive import call

TAB = None
LEDGER = '/home/nthieuu/code/ToolFlow/spikes/01-flow-cdp/FINDINGS.md'

def page(fn, **a):
    r = call('page', tabId=TAB, fn=fn, args=a)
    return r.get('result', r)

def find_flow_tab(project='b89ba0b5'):
    global TAB
    TAB = next(t['id'] for t in call('tabs')['result'] if project in t['url'])
    return TAB

def wait_ext(n=20):
    for _ in range(n):
        try:
            if call('ping').get('result') == 'pong': return True
        except Exception: pass
        time.sleep(2)
    return False

def settings_open():
    if page('radios') == 'no panel':
        page('click', sel='flow-prompt-box button.settings-trigger-button')
        for _ in range(10):  # background tabs render the panel slower
            time.sleep(0.5)
            if page('radios') != 'no panel': break

def settings_close():
    if page('radios') != 'no panel':
        page('click', sel='flow-prompt-box button.settings-trigger-button'); time.sleep(0.8)

def pick(label):
    """click the settings radio whose text contains label; return checked labels after"""
    settings_open()
    r = page('radios')
    idx = [i for i, row in enumerate([x for x in r if x[1] == 'radio']) if label in row[2]]
    if not idx: return f'NO {label}'
    page('click', sel='flow-prompt-box-settings button[role=radio]', idx=idx[0]); time.sleep(0.8)
    return [x[2] for x in page('radios') if x[3] == 'true']

def note(row):
    s = open(LEDGER).read()
    s = s.replace('\n## KẾT LUẬN SPIKE', row.rstrip() + '\n\n## KẾT LUẬN SPIKE', 1)
    open(LEDGER, 'w').write(s)

def resolve_note(marker, outcome):
    s = open(LEDGER).read()
    s = s.replace(marker, outcome, 1); open(LEDGER, 'w').write(s)

def wait_new(n0, kinds=('image', 'video', 'error'), expect=1, timeout=240, step=4):
    t0 = time.time(); new = []
    while time.time() - t0 < timeout:
        time.sleep(step); cur = page('tiles'); new = cur[:max(0, len(cur) - n0)]
        if len(new) >= expect and all(n['kind'] in kinds for n in new): break
    return round(time.time() - t0), new

def download(url, name, wait=60):
    d = call('download', url=url, filename=name)['result']
    for _ in range(wait):
        time.sleep(1); s = call('downloads', query={'id': d})['result'][0]
        if s['state'] != 'in_progress': break
    return {k: s.get(k) for k in ('state', 'filename', 'mime', 'fileSize', 'error')}

def video_url(idx=0):
    h = page('video', n=idx + 1, len=4000)[idx]['html']
    m = re.search(r'class="thumbnail" src="([^"]+)"', h)
    return m and m.group(1) + '=mm,22,15'
