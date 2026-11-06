# 17. Flow native: frontend Google công khai (không đăng nhập)

**Ngày:** 05/11/2026. **Phạm vi:** chỉ GET vô danh URL công khai; phân tích tĩnh. Không đăng nhập, cookie, RPC, POST, generate. Evidence: [flow-native-public-contract.json](evidence/flow-native-public-contract.json). Nguồn bền: `evidence/native-sources/*.js` + `manifest.json` (sha256 pin).

## Kết luận
**PARTIAL — đã xác định native RPC ở mức nguồn tĩnh (pass 2).** Pass 1 chỉ có 1 cặp ID↔path. Pass 2 đọc 2 module lazy (project `wO1vlb`, media grid `XRV0Af`) và giải call graph tới descriptor `Wa`: **24 RPC ID ↔ hành động** (upload ảnh, generate ảnh/video, upsample, extend/edit, đính kèm, resolve/batch media, project) có anchor trực tiếp + field number request lấy từ setter ở callsite. **Chưa** có: tên field, layout message `ZB` (media)/`$B` (workflow)/`wR` (response video), poll RPC riêng, nghĩa entitlement/recaptcha. Không thực thi gì.

## Artifact (đã pin, đường dẫn bền)
| File | Bytes | sha256 |
|---|---|---|
| evidence/native-sources/flow-boq-m_b.js | 1190932 | `d38ec208798f030193d6e82482ab47b64b683fc1f037b309c376c8a02d14086d` |
| evidence/native-sources/flow-boq-m_GK5kFd.js | 104934 | `cdc9df3ac3707923eaff41381107e3cd41ef669286d07aabeb51fa89a04574fa` |
| evidence/native-sources/flow-boq-m_wO1vlb.js | 3514612 | `16607c80b4f85543850e475f1170b1dbf34cfc2c169337ce877111509096c83d` |
| evidence/native-sources/flow-boq-m_XRV0Af.js | 4483037 | `5ad3393f2d14411ddb1029fb67c7ef8229ce442c844a0cae2317f419cf9bb9e2` |

wO1vlb và XRV0Af có URL **dựng** từ preload URL thay `m=<literal>` (literal ở m_b @1172648 / @1172708), không liệt kê trong HTML. 109 / 112 literal `Wa:"…"` trong hai module (đã kiểm bằng verifier).

## Giao thức (known — có anchor)
- Descriptor: `{Wa:<rpcId>,Za,Ya,Xa:<**RESPONSE** class>,hb:<**REQUEST** class>}`. `TB(a,b,c)` ghi `Wa:e,hb:c,Xa:b` và `Qab=_.Ed(Pab)` với `hb:Pab` + response đọc bằng `Dx(M,_.ZB,1)` → `Xa`=response, `hb`=request (đảo so với trực giác).
- `new _.UB(desc)` = **unary → batchexecute**; `new _.VB(desc)` = server-streaming (có `qQ` path gRPC; các path thấy: `…flow.v1.FlowService/StreamGenerateContent`, `…flow.agent.v1.FlowAppletAgentService/RunAppletAgentSse`, `…flow.agent.v1.FlowCreationAgentService/StreamChat`).
- `f.req` = JSON của `vza{f1: repeated Qs}`; `Qs`: f1 = rpcId (string), f2 (oneof 2|5|6) = `JSON.stringify(request)` , f4 = client key. Request là protobuf **dạng mảng JSON** (field N → index N−1; `Ie()=JSON.stringify(xc(this))`). Response envelope `wrb.fr` (`Ts`): f1 rpcId, f2/9/10 payload, f5 lỗi. Query `rpcids`, `source-path`, `fcd.retries` như pass 1.
- Setter type (m_b helper, đã so lại validator): `Bz/Np` **string** (`Tb` kiểm kiểu chuỗi), `Cz` bytes, `Dz/Yq` **enum/integer** (`Bb`), `zz/Zq` int32 (`Db`), `$x` bool, `Ln` message, `Nn/Qn` oneof message/string, `sz` repeated message, `Ez` repeated string. Nhận định ban đầu `Np=int64` là sai và đã sửa toàn bộ bảng dưới; tên ngữ nghĩa của field vẫn chỉ là suy luận.
- **Upload video không phải batchexecute**: Scotty `POST /upload/v1/flow/upload/video/<projectId>` (header `X-Framework-Xsrf-Token`, `Slug`, `x-trim-start/end` ms), phản hồi JSON `workflow/media/mediaId/name` (@wO1vlb `gfb`, mutation `UPLOAD_VIDEO`).
- `GenerateImageInvocation/Result`, `GenerateVideoInvocation/Result` (`_.UWa/_.VWa/_.WWa/_.XWa` qua `_.mT`) là **schema UI event JSON** của agent (stream `StreamChat`), **không phải wire schema** batchexecute. Key quan sát: `reference_media_ids`, `video_media_id`, `placeholder_frontend_id`, `workflow_id`, `media_id`, `batch_id`, `collection_id`, `error_code`.

## Bảng RPC ID ↔ hành động (unary; offset = def/callsite)
Field request = từ code dựng ở callsite (số field chắc; ngữ nghĩa tên chỉ suy ra từ biến UI, đánh dấu “(…)” là suy luận). Response chỉ ghi getter đã thấy.

| RPC id | Hành động | var | wO1vlb def/call | XRV0Af def/call | Request fields (callsite) | Response |
|---|---|---|---|---|---|---|
| `maseQ` | UPLOAD_IMAGE (inline bytes) | `Sab` | 1902863/1940374 | 1918402/1955913 | 1 msg(ctx: session/workflow/tool), 2 bytes(image), 3 string(mimeType), 4 bool, 7 msg(crop), 8 bool(isHidden), 9 string(fileName), 10 msg, 11 string(seed-like UI value; semantic name inferred), 12 string(seed-like UI value; semantic name inferred), 14 msg | resp f1=ZB media (Dx(M,_.ZB,1)) |
| `jeNy9c` | SAVE_VIDEO_FRAME -> image upload | `jab` | 1900183/1941252 | 1915722/1956791 | 1 string, 2 oneof msg(timestamp), 4 string, 5 string, 6 msg, 7 msg, 8 string(fileName) | resp f1=ZB media |
| `sAVZzc` | TRANSFORM_IMAGE | `oab` | 1900490/1941972 | 1916029/1957511 | 1 enum/integer, 2 string(mediaId), 4 oneof msg, 7 string | resp f1=ZB media |
| `ogiZ0b` | GENERATE_IMAGE (default path via sw/yeb) | `y9a` | 1893449/1942276 | 1908988/1957815 | 2 repeated msg(per-image udb: 3 rep msg refs, 4 int, 6 string, 8 msg ctx, 9 msg, 10 msg, 11/12 rep msg, 13/14 string, 15 int), 3 bool=true, 4 msg(ctx Jka), 5 msg(settings dR) | resp f1 rep ZB media, f2 rep $B workflow |
| `Z9cAtf` | GENERATE_IMAGE (alt path Deb/Aeb/zeb) | `m9a` | 1892557/1942505 | 1908096/1958044 | 1 repeated msg, 3 msg(ctx), 4 msg(settings) | same resp shape as ogiZ0b |
| `YhhmEf` | GENERATE_VIDEO text | `Ybb` | 1907986/1958357 | 1923525/1973896 | 1 rep msg(Sbb: 1 msg,2 string prompt,3 int aspect,5 msg placeholder{1,2,3 string;5,6 string},7 msg,8 msg resolution), 2 msg(ctx), 3 msg(settings) | resp shared wR |
| `MZZa6b` | GENERATE_VIDEO references | `Dbb` | 1906372/1958614 | 1921911/1974153 | per item(xbb): 1 msg,3 string(prompt),6 msg(placeholder),2/8/10/11 rep msg,9 msg,12 msg; list-level f2 rep item,f3?,x via Abb/zbb/ybb (not resolved) | resp f1 rep xbb |
| `eb1hJf` | GENERATE_VIDEO start frame | `Rbb` | 1907448/1958983 | 1922987/1974522 | per item(Lbb): 1 msg,2 string(prompt),5 msg(frame),6 msg(placeholder),9 msg,10 msg | resp f1 rep Lbb |
| `nprQif` | GENERATE_VIDEO start+end frames | `Kbb` | 1906910/1959300 | 1922449/1974839 | per item(Ebb): 1 msg,2 string(prompt),5 msg(start),6 msg(end),7 msg(placeholder),9 msg | resp f1 rep Ebb |
| `jIps6` | EDIT_VIDEO | `ibb` | 1904757/1959649 | 1920296/1975188 | per item (bbb): 2 msg, 3 string(prompt), 4 enum/integer(aspect), 5 msg(placeholder), 6 msg, 9 msg | UI switch |
| `fZytfe` | EXTEND_VIDEO | `wbb` | 1905834/1960045 | 1921373/1975584 | per item (qbb): 2 msg, 3 string(prompt), aspect via setAspectRatio | UI switch |
| `p0UkFb` | UPSAMPLE_VIDEO | `ecb` | 1908524/1960443 | 1924063/1975982 | per item(Zbb): 1 msg (oneof 1/2 from y6a), 32 string; list-level builders $bb/acb/bcb | UI switch |
| `SPrCad` | UPSAMPLE_IMAGE (sync) | `Xab` | 1903159/1945109 | 1918698/1960648 | 1 string(mediaId), 2 enum/integer, 3 msg(ctx) | resp f1 ZB media, f2 bytes |
| `LcEY2c` | ASYNC_UPSAMPLE_IMAGE | `O8a` | 1891076/1945401 | 1906615/1960940 | 1 string(mediaId), 2 enum/integer, 3 msg(ctx) | resp f1 ZB media |
| `QZasKb` | GENERATE_GIF (step 1) | `mcb` | 1909053/1953639 | 1924592/1969178 | 2 string | resp: only optional $Z (f3 / f2); payload fields not resolved |
| `GjQLTd` | GENERATE_GIF (get) | `Acb` | 1909956/1953887 | 1925495/1969426 | 1 repeated msg | resp: only optional $Z (f3 / f2); payload fields not resolved |
| `GSkHsd` | UPLOAD_SESSION_ATTACHMENT (creation agent) | `$wb` | 2726531/2906810 | 2742070/2922349 | 1 string(session), 2 string(fileName), 3 string(mimeType), 4 bytes(data), 6 string | resp f1 msg(OX attachment) |
| `MVz44c` | UPLOAD_SESSION_ATTACHMENT (applet) | `Mwb` | 2725236/2907032 | 2740775/2922571 | 1 string, 2 string(name), 3 string(mime), 4 bytes, 5 string | resp f1 msg |
| `as29s` | Media/video URL resolve by id | `_.q3a` | 1672862/1802867 | 1688401/1818406 | 1 string(mediaId), 2 msg(ctx) | resp is _.ZB; A8a then reads sub-message f6 (oneof 1/2/3) from a wrapper — exact class chain not fully resolved |
| `bOKtO` | Batch media get by names (poll/resolve) | `C8a` | 1801366/1889477 | 1816905/1905016 | 1 msg(ctx), 2 repeated string(names d), 3 msg | resp f1 repeated ZB media (hg()) |
| `wDg3C` | Batch workflow/entity get (Jeb) | `Vcb` | 1919331/1946349 | 1934870/1961888 | 2 repeated string | resp f1 rep Tcb (mC()) |
| `Zzl0ze` | Get project | `W$a` | 1899208/1977326 | 1914747/1992865 | 1 string `projects/<id>` (S$a), 5 msg (T$a, optional ctx) | resp f4 rep z9a (workflow), hg() |
| `UpteDb` | List/search projects | `_.l2a` | 1672947/1675713 | 1688486/1691252 | 2 int(page), 3 string(token), 4 msg ; uses _.g2a(_.f2a(21),e) filter | resp f1 rep nN |
| `heTLee` | Search media (grid) | `ECb` | — | 2948948/2950016 | oneof(1,2) msg(xCb), 3 int32(yCb), 4 string(zCb), 5 msg(ACb) | resp f4 rep CCb |

Ghi chú chuỗi bằng chứng: mutationKey UI (`UPLOAD_IMAGE`, `GENERATE_IMAGE`, `GENERATE_VIDEO`, `UPSAMPLE_*`, `GENERATE_GIF`, `UPLOAD_SESSION_ATTACHMENT`) cùng hàm với `.Db(` của descriptor → ID. GENERATE_VIDEO chọn ID theo `switch(c.Rt)`: TEXT=`YhhmEf`, REFERENCES=`MZZa6b`, START_FRAME=`eb1hJf`, START_END_FRAMES=`nprQif`, EDIT_VIDEO=`jIps6`, EXTEND_VIDEO=`fZytfe`, UPSAMPLE_VIDEO=`p0UkFb`. GENERATE_IMAGE: path chính `ogiZ0b` (qua `sw`→`yeb`, hàng đợi 1 req/s), nhánh phụ `Z9cAtf` (`Deb`→`Aeb`→`zeb`).

## Poll / resolve
Không chứng minh được RPC poll riêng. Có: response GENERATE_* chứa danh sách media với trạng thái (`failed`/`canceled` trong `$eb`); lấy lại/làm mới qua `bOKtO` (batch media theo `names` — repeated string f2), `as29s` (URL theo mediaId), `Zzl0ze` (project), `wDg3C`. `heTLee` (media grid search) chỉ có ở XRV0Af, **không** có trong wO1vlb.

## Anchor phụ
- `flow-boq-m_b.js`@400709: `_.UB=class extends TB{constructor(a){super(a);this[Eza]="unary"}}` — UB=unary (batchexecute); VB=server_streaming
- `flow-boq-m_b.js`@400094: `Wa:e,hb:c,Xa:b,Za:a}` — TB(id,Xa,hb): Xa=RESPONSE class, hb=REQUEST class (confirmed by Qab=_.Ed(Pab), hb:Pab, response read by Dx(M,_.ZB,1))
- `flow-boq-m_b.js`@383382: `Qs=class extends _.m{constructor(a){super(a)}Pg(){return _.n(this,1)}},uza=[2,5,6]` — envelope item: f1=rpc id string; f2 (oneof 2/5/6)=request payload string; f4=client key
- `flow-boq-m_b.js`@707723: `la=_.Np(Oa,4,la),la=_.Np(la,1,aa.Pg()[_.SB].Wa),_.ns(aa)&&lqa(la,Ha),_.Yc(e,1,Qs,la)` — builder: Qs.f4=key, f1=Wa id, f2=ns(req).Ie(), appended to vza f1
- `flow-boq-m_b.js`@689288: `iI(k,"f.req",f.Ie())` — f.req = JSON.stringify(array form of vza); m.Ie()=JSON.stringify(xc(this))
- `flow-boq-m_b.js`@383907: `Ts.Ue="wrb.fr"` — response envelope Ts: f1 id, f2/9/10 oneof payload, f5 error(fu)
- `flow-boq-m_b.js`@708016: `${_.Nd("eptZe")}data/batchexecute` — URL
- `flow-boq-m_wO1vlb.js`@3115747: `new _.VB(IRb)` — VB streaming: qQ path FlowAppletAgentService/RunAppletAgentSse
- `flow-boq-m_wO1vlb.js`@3159621: `FlowCreationAgentService/StreamChat` — streaming agent chat, not batchexecute
- `flow-boq-m_wO1vlb.js`@1952171: URL template `/upload/v1/flow/upload/video/${e}` — `UPLOAD_VIDEO` không dùng batchexecute: Scotty uploader POST, headers `X-Framework-Xsrf-Token`, `Slug`; JSON response được đọc ở `workflow/media/name/mediaId`.
- `flow-boq-m_wO1vlb.js`@3177701: `_.mT({schema:_.UWa,data:b.payload,no:"GenerateImageInvocation",Eq:!0})` — UI/agent event JSON schema (UWa/VWa/WWa/XWa) for tool-events, NOT wire schema of batchexecute generate
- `flow-boq-m_wO1vlb.js`@3185316: `_.mT({schema:_.WWa,data:c.payload,no:"GenerateVideoInvocation",Eq:!0})` — same, video
- `flow-boq-m_wO1vlb.js`@1958357: `case "TEXT":return b.ha.mutate(Ybb.Db(` — video mode switch

## So sánh ToolFlow
Không map mặc nhiên `protocol.rpc.*` (symbolic) sang ID trên. Chỉ dùng tên hành động + ID ở bảng khi ghi rõ nguồn; các ID là build `boq_labs-ai-sandbox-frontend_20261104.00_p0`, có thể đổi mỗi build.

## Chưa biết
- Tên field, layout `ZB`/`$B`/`wR`/`Z`; nghĩa số field mang (…) ; response đầy đủ của upsample/gif.
- Auth/recaptcha/entitlement; hành vi server.
- Phần pass 1 vẫn đúng: HTML `WIZ_global_data` (eptZe, hCQbU, YmyN0b), REST `/v1/chooseServer`, `/v1/refreshCreds`, kênh agent stream; `/fx/api/trpc`/`getMediaUrlRedirect` 0 khớp.

## Verify (static consistency)
`python3 docs/research/evidence/verify-flow-native-public-contract.py` (chạy từ gốc ToolFlow) — kiểm sha256/bytes 4 file, mọi anchor (def/call/legend/transport), các validator kiểu đã sửa, ID duy nhất và số literal `Wa:` = 109/112. Script và nguồn đã giữ bền trong `evidence/`, không phụ thuộc scratch.
