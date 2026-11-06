# Live run ledger — TobyFlow Gen, Flow video with reference image

**Budget authorized by user:** exactly 1 generation (one prompt, quantity 1). No retry, no second attempt without a new user instruction.
**Outcome:** budget used = 1 generation, 0 retries. Run closed.

| Field | Value |
|---|---|
| Date | 2026-11-06 (+07) |
| Browser profile | Chrome `Profile 2` (owner's running Chrome, display :10) |
| Flow project | `b89ba0b5-d5e3-44d9-8d86-1851dd147159` |
| Driver | TobyFlow 1.3.142, side panel → Gen (plan observed in local storage: Free; `flow_api_enabled=null`; `gen_run_max` 20/day, used 0) |
| Mode | Flow → Video → input type **Frames** (Toby model config: Veo 3.1 Lite rejects refs with Ingredients; ref forces 8s) |
| Model | Veo 3.1 - Lite |
| Ratio / quantity | 9:16 / 1 |
| Reference image | `~/Downloads/toolflow-start-frame.png`, synthetic, sha256 `a5ce544d9e7e1d98d677fc1911ba9b4a31f45646bc49edf5cab6e9f91e911836` |
| Prompt | `The red paper boat drifts slowly to the right across calm blue water, gentle ripples, soft morning light, static camera.` |
| Who clicks | Agent, on the owner's request ("dùng computeruse tự thao tác cho tôi"), through XTEST input on display :10. Planned before that: the owner clicks. |
| Capture | DevTools on the Flow tab, Keep log, **Export HAR (sanitized)** → agent redaction → `rea inspect-web-network-capture` (rea-agents 6.8.0). |

## Events

| Time (+07) | Event |
|---|---|
| 00:25 | Intent recorded; waiting for owner to click Tạo. Generation NOT yet sent. |
| 00:34 | Owner asked agent to operate. Agent drives owner display :10 via XTEST (managed computer_use is bound to bot screen :20). DevTools Network on Flow tab, Keep log on. Settings verified on screenshot: Flow · Video · Veo 3.1 - Lite · Frames · 9:16 · ×1 · START=toolflow-start-frame.png (status "Chờ upload") · END empty · auto-download on · Max Speed off. |
| 00:34:08 | **Agent clicks Tạo once** (intent written before click). |
| 00:34 | Tạo opened confirmation modal "Xác nhận chạy": 1 prompt · Flow Video "Sẵn sàng" · 9:16 · ×1 · download 720p · Flow submit mode **Tự động submit** (alternative: Manual). No generation yet. |
| 00:34:31 | **Agent clicks Chạy once** — this is the generation dispatch point. |
| 00:34:32 | `maseQ` upload of the start frame (Flow file-picker path, renamed `toby_<uuid>.png`) → media `b7e9bb1d-…`. |
| 00:34:46 | `eb1hJf` submit, model key `veo_3_1_i2v_lite`. |
| 00:34:50–00:35:25 | `jwpduf` poll every 5 s, 8 calls. Status `[2]` pending → `[3]` done. |
| 00:35:26–31 | `as29s` resolves URLs; page GET `flow-content.google/video/827ca4d4-…` 200. |
| 00:35:32 | File saved: `~/Downloads/tobyflow_output/tobyflow-01/001_The_red_paper_boat_drifts_slowly_to_the_2026-11-05.mp4`. |
| 00:37:38 | HAR exported to `~/Downloads/flow-video.har`; run closed. |

## Result

| Field | Value |
|---|---|
| Output video | h264 720×1280 24 fps + AAC, 7.93 s, 1 256 130 bytes |
| Output sha256 | `7a44282c7850ac3f6110bc791412ba5b29d03063a15ca10820c372f3342f622b` |
| Visual check | First frame matches the synthetic start frame; the boat moves right by the last frame ([first-vs-last-frame.png](first-vs-last-frame.png)). |
| Submit → done | ≈39 s (eb1hJf 00:34:46 → final jwpduf 00:35:25) |
| Size cross-check | Final `jwpduf`/`as29s` report 1256130, identical to the downloaded file size. |
| Credit | Response field `[1]` = `1028` on `eb1hJf` and on the final `jwpduf`. **Confirmed later as the Flow credit balance**: the balance RPC `nzlxg` returns the same number, and it drops by 10 after each later Veo Lite video ([feature sweep](../live-2026-11-06-features/LEDGER.md)). So this run most likely cost 10 credits. The balance before it was not captured. |
| Errors | None. No captcha prompt was shown; reCAPTCHA Enterprise ran silently (`reload`/`clr`). |

## Files in this folder

- [FINDINGS.md](FINDINGS.md): the native contract observed live, compared with the static map.
- [network-timeline.redacted.json](network-timeline.redacted.json): all 66 entries, with every batchexecute `f.req` and response decoded. The tokens, the signed URLs, the UA and the experiment IDs are stripped.
- [rea-inspect-web-network-capture.summary.json](rea-inspect-web-network-capture.summary.json): REA receipt, rc=0.
- [first-vs-last-frame.png](first-vs-last-frame.png)

**Not committed here:** the HAR itself still contains reCAPTCHA tokens and the signed media URLs. It stays at `~/Downloads/flow-video.har` (the owner's copy) and in agent scratch.
