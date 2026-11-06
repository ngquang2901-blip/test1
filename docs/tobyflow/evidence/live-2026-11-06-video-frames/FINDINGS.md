# Findings: Flow start frame → video, observed live (2026-11-06)

Source: [LEDGER.md](LEDGER.md) and [network-timeline.redacted.json](network-timeline.redacted.json) (entry index `i` is cited below). Static map being checked: [research/17](../../../research/17-flow-native-public-frontend.md).
Labels: **XÁC NHẬN** = seen in this capture · **SUY LUẬN** = inferred, not yet tested · **CHƯA KIỂM**.

## 1. RPC chain for one run (XÁC NHẬN)

| Step | RPC | Request (shape) | Response (relevant part) | i |
|---|---|---|---|---|
| Upload start frame | `maseQ` | `[clientCtx, <base64 image>, "image/png", 1, …, "toby_<uuid>.png", null, <uuid>, <uuid>]` | `[[mediaId, projectId, workflowId, …, [[w,h]=[720,1280]] , mime "image/jpeg"], …]` | 7 |
| Submit | `eb1hJf` | `[[[[null,null,[[[prompt]]]], "veo_3_1_i2v_lite", 1, null, [null, startMediaId, null,null,null, [null,null,1,1]], [..., uuid, uuid]]], clientCtx, [batchUuid, 2]]` | `[null, 1028, [[workflowId, …, [title, ts, …, outMediaId, batchUuid, ts]]], [[outMediaId, …, status [6], …, seed 111319, …, duration [8]]]]` | 40 |
| Poll | `jwpduf` | `[null, null, [[outMediaId]]]`, every 5 s | status `[2]` while generating → `[3]` + byte size `1256130` when done | 45–53 |
| Resolve | `as29s` | `[outMediaId, null, [1]]` then `[outMediaId]` | first an `lh3…/asb/…` URL, then `flow-content.google/video/<id>` + `/image/<id>` | 55, 59 |
| Fetch | GET | `flow-content.google/video/<outMediaId>?<signed>` | 200, the MP4 that TobyFlow saved | 63 |

Also seen, not part of generation: `UpteDb` (project list, `["projects/*",21,…]`), `ngNC2` (`tools/PINHOLE/projects/<id>`), `WuwhI` (telemetry events `FLOW_UPLOAD`, `FLOW_CONTEXT_MENU`, `FLOW_DOWNLOAD`, `ASSET_DOWNLOAD`, carrying `MEDIA_GENERATION_PAYGATE_TIER = PAYGATE_TIER_ONE`).

## 2. Compared with the static map

| Static claim | Live | Verdict |
|---|---|---|
| START_FRAME → `eb1hJf` | `eb1hJf` was used | XÁC NHẬN |
| Upload image → `maseQ` | `maseQ` was used | XÁC NHẬN |
| Resolve URL → `as29s` | `as29s` was used | XÁC NHẬN |
| Poll/resolve via `bOKtO` | not called; Flow polled with **`jwpduf`** | The static map is incomplete. Add `jwpduf` as the per-media status poll. |
| Model key | `veo_3_1_i2v_lite` (UI label "Veo 3.1 - Lite", Frames mode) | XÁC NHẬN for this mode only |

## 3. Facts for the ToolFlow Flow driver

- **Status codes (XÁC NHẬN for 1 run):** `6` right after submit, `2` while generating, `3` when done. Failure codes were not observed (CHƯA KIỂM).
- **Completion signal (XÁC NHẬN):** the status changes to `3` and a byte size appears. That size matched the downloaded file exactly, so the driver can use it as a download integrity check.
- **Timing (XÁC NHẬN, n=1):** submit → done took ≈39 s. Polling ran at 5 s.
- **Upload path (XÁC NHẬN):** TobyFlow feeds the file through Flow's own file picker (`FLOW_UPLOAD_SOURCE = FILE_PICKER`). It renames the file to `toby_<uuid>.png`, and the server stores it as JPEG 720×1280. This is DOM automation, not a direct native call.
- **Prompt (XÁC NHẬN):** sent verbatim. The server wraps it in a `<root><context/><instruction><prompt>…` template, and Flow auto-titles the result ("Red paper boat drifts").
- **Every generate-type call carries a fresh reCAPTCHA Enterprise token** inside `clientCtx` (`[null, 22, …, projectId, …, [<token ~2.6k chars>, 1]]`), and there are `recaptcha/enterprise/reload`/`clr` calls right before `maseQ` and `eb1hJf` (XÁC NHẬN). This is the practical reason a direct-RPC driver is harder than DOM automation: the token is minted by page JS. Do not replay it.
- **`1028` in response field `[1]`** of `eb1hJf` and the final `jwpduf`: **XÁC NHẬN** as the Flow credit balance in the later feature sweep. The balance RPC `nzlxg` returns the same number. It drops by 10 per Veo Lite video, by 20 for Veo Fast + refs, and by 0 for Nano Banana images.
- **TobyFlow → Toby server traffic is not in this HAR.** The capture covers the Flow tab only, so nothing here shows what the extension reports to `labs.toby.vn` (CHƯA KIỂM).

## 4. Capture method notes (for reuse)

- Chrome's sanitized HAR still holds `x-client-data`, the batchexecute `at=` XSRF value inside `f.req` bodies, the reCAPTCHA tokens and signed media URLs. Redact them before storing anything.
- REA's HAR validator rejects Chrome's `serverIPAddress` values (`[2404:…]` IPv6 in brackets, and `""`). Drop non-IPv4 values (the field is optional in HAR 1.2) and REA then runs with rc=0, covering 66/66 records.
