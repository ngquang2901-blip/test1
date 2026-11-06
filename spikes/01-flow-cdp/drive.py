# THROWAWAY spike helpers: talk to server.mjs relay.
import json, time, urllib.request, urllib.error
TOK = open('/home/nthieuu/code/ToolFlow/spikes/01-flow-cdp/.token').read().strip()
TAB = None

def call(op, **args):
    req = urllib.request.Request('http://127.0.0.1:17777/cmd', data=json.dumps({'op': op, 'args': args}).encode(), headers={'X-Token': TOK})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=70).read())
    except urllib.error.HTTPError as e:
        return {'http': e.code, 'body': e.read().decode()}

def cdp(method, **params):
    return call('cdp', tabId=TAB, method=method, params=params)

def ev(expr):
    r = cdp('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
    if r.get('error'): return {'ERR': r['error']}
    res = r['result']
    if 'exceptionDetails' in res: return {'EXC': res['exceptionDetails'].get('exception', {}).get('description')}
    return res['result'].get('value')

def rect(sel, idx=0):
    # finding: overlays (cookie banner) cover part of fixed controls -> pick a point that hit-tests to the target
    return ev(f"""(()=>{{const e=document.querySelectorAll({json.dumps(sel)})[{idx}]; if(!e) return null; e.scrollIntoView({{block:'center'}}); const r=e.getBoundingClientRect();
      for (const fy of [0.5,0.3,0.7,0.15,0.85]) for (const fx of [0.5,0.3,0.7]) {{ const x=r.x+r.width*fx, y=r.y+r.height*fy; if (e.contains(document.elementFromPoint(x,y))) return [x,y]; }}
      return null}})()""")

def click(sel, idx=0):
    r = rect(sel, idx)
    if not r: return 'NOTFOUND ' + sel
    for t in ('mouseMoved', 'mousePressed', 'mouseReleased'):
        p = {'type': t, 'x': r[0], 'y': r[1]}
        if t != 'mouseMoved': p.update(button='left', clickCount=1)
        cdp('Input.dispatchMouseEvent', **p)
    return r

def key(k, code, vk):
    for t in ('keyDown', 'keyUp'):
        cdp('Input.dispatchKeyEvent', type=t, key=k, code=code, windowsVirtualKeyCode=vk)

ED = 'flow-prompt-box .ProseMirror[contenteditable="true"]'
SUBMIT = 'flow-prompt-box button[type="submit"]'
TILES = '''(()=>[...document.querySelectorAll('flow-grid-tile-container')].map(t=>{const m=t.querySelector('[data-media-id]'); return {id:m&&m.getAttribute('data-media-id'), kind:t.querySelector('flow-pending-tile')?'pending':t.querySelector('flow-error-tile')?'error':t.querySelector('flow-video-tile')?'video':t.querySelector('flow-image-tile')?'image':'?', pct:(t.querySelector('.loading-percentage')||{}).innerText, label:t.getAttribute('aria-label'), err:(t.querySelector('flow-error-tile')||{}).innerText}}))()'''

def type_prompt(text):
    click(ED); time.sleep(0.3)
    cdp('Input.insertText', text=text); time.sleep(0.5)
    return ev(f"document.querySelector({json.dumps(ED)}).innerText").strip() == text

def rpc_log(evs, names=('ogiZ0b',)):
    out = []
    for e in evs:
        if e['method'] == 'Network.requestWillBeSent' and any(n in e['params']['request']['url'] for n in names):
            b = cdp('Network.getResponseBody', requestId=e['params']['requestId'])
            out.append(str(b.get('result', b))[:600])
    return out

def find_tab(prefix='https://flow.google.com/project/'):
    global TAB
    TAB = next(t['id'] for t in call('tabs')['result'] if t['url'].startswith(prefix))
    return TAB
