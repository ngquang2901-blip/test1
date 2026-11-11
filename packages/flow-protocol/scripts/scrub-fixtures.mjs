#!/usr/bin/env node
// Pseudonymizes the capture fixtures in test/fixtures, in place. The fixtures are real Flow traffic and the desktop app bundles some
// of them (fake driver), so nothing in them may come from the account they were captured on: every id (uuid) and every piece of
// account content (prompts, titles, translated prompts, upload file names) is replaced. Structure and relations are kept: the same
// value gets the same replacement in every file, so receipts still match the listing, a ref is still the uploaded media, and so on.
//
//   node scripts/scrub-fixtures.mjs [--check] [--map <file outside the repo>]
//
// Idempotent: values that already are replacements stay, new captures get the next numbers. --check changes nothing and exits 1 when
// something would be replaced (use it before a release). --map writes old → new for updating tests by hand; that file holds the
// originals, so it must never be committed. Chunk length lines of the envelope are not recomputed (the parser ignores them).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

const DIR = new URL('../test/fixtures/', import.meta.url)
const args = process.argv.slice(2), CHECK = args.includes('--check'), MAP = args.includes('--map') ? args[args.indexOf('--map') + 1] : null

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const FAKE_UUID = /^fa4e0000-0000-4000-8000-[0-9a-f]{12}$/i
const FAKE_TEXT = /^(?:Sample text|Văn bản mẫu) (\d{4})(?: "(?:sample|mẫu)")?(?:\n(?:second line|dòng hai))?$/
const FAKE_FILE = /^sample-file-(\d{4})\.\w+$/
const FILE_NAME = /^[\w.-]+\.(jpe?g|png|webp|gif|mp4|webm|wav|mp3)$/i
// What is Flow's own vocabulary, not account content. Anything else that is a string gets replaced (fail closed: an unknown token is
// treated as content; the run lists such tokens so a new structural one can be added here).
const VOICES = ['Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede', 'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome', 'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda', 'Orus', 'Puck',
  'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi']
const KEEP = new Set(['', '<long>', '<redacted>', 'wrb.fr', 'di', 'e', 'af.httprm', 'generic', 'abra', 'BELUGA', 'ogiZ0b', 'YhhmEf', 'jwpduf', 'maseQ', 'MZZa6b', 'Zzl0ze', 'eb1hJf', 'nprQif', ...VOICES, ...VOICES.map((v) => v.toLowerCase())])
const KEEP_RE = [
  /^-?\d+(\.\d+)?$/, // numbers kept as strings (envelope ids)
  /^<base64 removed: \d+ chars>$/, // a marker put in by hand at capture time, like <long> and <redacted>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // ids: replaced by the uuid pass
  /^type\.googleapis\.com\/[\w.]+$/, /^PUBLIC_ERROR_[A-Z_]+$/, /^(image|video|audio)\/[\w.+-]+$/, /^projects\/[0-9a-f-]{36}$/i,
  /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/, /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/, // model codes: veo_3_1_t2v_lite, HARBOR_SEAL, GEM_PIX_2
]
// URLs must already be harmless (signature / path redacted by hand at capture time); any other URL stops the run.
const URL_OK = [/^https:\/\/lh3\.googleusercontent\.com\/<redacted>$/, /^https:\/\/gstatic\.com\/aitestkitchen\/voices\/samples\/\w+\.wav$/,
  /^https:\/\/flow-content\.google\/(image|video)\/[0-9a-f-]{36}\?Expires=\d+&KeyName=[\w-]+&Signature=<redacted>$/]

const texts = new Map(), files = new Map(), uuids = new Map(), tokens = new Set() // old → new; tokens: one-word content, listed for review
let nText = 0, nFile = 0, nUuid = 0
const pad = (n) => String(n).padStart(4, '0')

function text(s) {
  if (!texts.has(s)) {
    const vn = /[^\x00-\x7f]/.test(s) // keep what the parsers have to cope with: non-ASCII, a quote, a line break
    texts.set(s, `${vn ? 'Văn bản mẫu' : 'Sample text'} ${pad(++nText)}${s.includes('"') ? (vn ? ' "mẫu"' : ' "sample"') : ''}${s.includes('\n') ? (vn ? '\ndòng hai' : '\nsecond line') : ''}`)
    if (!/\s/.test(s) && !vn) tokens.add(s)
  }
  return texts.get(s)
}
function file(s) {
  if (!files.has(s)) files.set(s, `sample-file-${pad(++nFile)}.${s.split('.').pop().toLowerCase()}`)
  return files.get(s)
}
function leaf(s) {
  if (KEEP.has(s) || KEEP_RE.some((r) => r.test(s)) || FAKE_TEXT.test(s) || FAKE_FILE.test(s)) return s
  if (/^https?:\/\//.test(s)) { if (URL_OK.some((r) => r.test(s))) return s; throw new Error(`a URL that is not redacted: ${s.slice(0, 60)}…`) }
  if (FILE_NAME.test(s)) return file(s)
  if (s.startsWith('<root>')) return s.replace(/>([^<>]*[^<>\s][^<>]*)</g, (_m, inner) => `>${leaf(inner.trim())}<`) // Flow's own wrapper around a prompt: only the text inside is content
  return text(s)
}
/** Every string leaf, looking inside strings that are themselves JSON (payloads are JSON in JSON in JSON). */
function walk(v) {
  if (Array.isArray(v)) return v.map(walk)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
  if (typeof v !== 'string') return v
  if (v.startsWith('[') || v.startsWith('{')) { try { return JSON.stringify(walk(JSON.parse(v))) } catch { /* plain text */ } }
  return leaf(v)
}
const json = (s) => JSON.stringify(walk(JSON.parse(s)))
const FIELD = {
  req(s) { // "f.req=<json>&at=<redacted>&", already URL-decoded
    const end = s.indexOf('&at=')
    if (!s.startsWith('f.req=')) throw new Error('req: not an f.req body')
    return `f.req=${json(s.slice(6, end < 0 ? undefined : end))}${end < 0 ? '' : s.slice(end)}`
  },
  raw(s) { // the same body as it went over the wire (URL-encoded)
    const end = s.indexOf('&'), enc = s.slice(6, end < 0 ? undefined : end)
    const wire = (t) => encodeURIComponent(t).replaceAll('%3Clong%3E', '<long>').replaceAll('%3Credacted%3E', '<redacted>') // the redaction markers were put into the encoded body as they are
    if (!s.startsWith('f.req=')) throw new Error('raw: not an f.req body')
    if (wire(decodeURIComponent(enc)) !== enc) throw new Error('raw: an encoding this script cannot reproduce')
    return `f.req=${wire(json(decodeURIComponent(enc)))}${end < 0 ? '' : s.slice(end)}`
  },
  res: (s) => s.split('\n').map((l) => (l.startsWith('[') ? json(l) : l)).join('\n'), // envelope: JSON lines between length lines
}
const fakeUuid = (m) => {
  if (FAKE_UUID.test(m)) return m
  const k = m.toLowerCase()
  if (!uuids.has(k)) uuids.set(k, `fa4e0000-0000-4000-8000-${(++nUuid).toString(16).padStart(12, '0')}`)
  return m === k ? uuids.get(k) : uuids.get(k).toUpperCase() // batch ids are upper case on the wire
}

const names = readdirSync(DIR).filter((n) => n.endsWith('.json')).sort()
const before = names.map((n) => readFileSync(new URL(n, DIR), 'utf8'))
// numbering continues after the replacements that are already there
for (const t of before) {
  for (const m of t.matchAll(/(?:Sample text|Văn bản mẫu) (\d{4})/g)) nText = Math.max(nText, Number(m[1]))
  for (const m of t.matchAll(/sample-file-(\d{4})\./g)) nFile = Math.max(nFile, Number(m[1]))
  for (const m of t.matchAll(/fa4e0000-0000-4000-8000-([0-9a-f]{12})/gi)) nUuid = Math.max(nUuid, parseInt(m[1], 16))
}
const after = before.map((t, i) => {
  const doc = JSON.parse(t)
  for (const r of doc.records) for (const k of Object.keys(FIELD)) if (typeof r[k] === 'string' && r[k]) {
    try { r[k] = FIELD[k](r[k]) } catch (e) { throw new Error(`${names[i]} (${r.rpc} ${r.phase} ${k}): ${e.message}`) }
  }
  return JSON.stringify(doc, null, t.startsWith('{\n') ? 1 : undefined).replace(UUID, fakeUuid)
})

const changed = names.filter((_, i) => after[i] !== before[i])
console.log(`${names.length} fixtures: ${texts.size} texts, ${files.size} file names, ${uuids.size} ids to replace; ${changed.length} file(s) ${CHECK ? 'would change' : 'changed'}${changed.length ? ': ' + changed.join(', ') : ''}`)
if (tokens.size) console.log(`one-word values treated as content (add to KEEP when one is Flow vocabulary): ${[...tokens].length}`)
if (MAP) writeFileSync(MAP, JSON.stringify({ uuids: Object.fromEntries(uuids), texts: Object.fromEntries(texts), files: Object.fromEntries(files), tokens: [...tokens] }, null, 1))
if (CHECK) process.exit(changed.length ? 1 : 0)
after.forEach((t, i) => { if (t !== before[i]) writeFileSync(new URL(names[i], DIR), t) })
