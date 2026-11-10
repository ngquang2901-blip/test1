# Packaging (P4): building the installers

All three installers build on the Linux dev machine from `apps/desktop`:

```sh
export PATH=~/.local/opt/wine-11.21-amd64-wow64/bin:~/.local/node22/bin:$PATH
export WINEPREFIX=~/.local/share/toolflow-wine WINEDEBUG=-all
npm run build && xvfb-run -a npx electron-builder --linux --win
```

Output in `apps/desktop/dist/`: `ToolFlow-<v>-Setup.exe` (NSIS, per-user, choosable folder), `ToolFlow-<v>-x86_64.AppImage`, `ToolFlow-<v>-amd64.deb`. Linux targets alone need no wine (`--linux`).

How it is put together (`electron-builder.yml`, `electron.vite.config.ts`):
- electron-vite bundles main (including `@toolflow/flow-protocol`, `ws`, `@electron-toolkit/utils`), preload and renderer into `out/`. The only runtime `node_modules` entry is `better-sqlite3`, which ships N-API prebuilds for every platform (`prebuilds/<platform>-<arch>.node`, chosen at runtime), so there is no native rebuild and Windows can be packaged from Linux. `.node` files are unpacked from the asar.
- `apps/extension` (without tests, `pair.json` and `package.json`) goes to `resources/extension`; the packaged app copies it into `<userData>/extension` and writes `pair.json` there, which is the folder the user loads in Chrome. The first-run panel in S1 shows that path.
- `productName: ToolFlow` makes userData `%APPDATA%\ToolFlow` / `~/.config/ToolFlow`.
- Windows: unsigned. The NSIS uninstaller step and the exe resource edit run under wine. The portable wine build (Kron4ek `wine-11.21-amd64-wow64`, unpacked in `~/.local/opt`) works once the prefix is fully initialised (`wineboot -i; wineserver -w`; a cut-short init leaves `syswow64` empty and every 32-bit exe fails with `could not load kernel32.dll`).

Checked on 2026-11-11 (see docs/progress-p2.md, P4 section): the packaged Linux app on a fresh userData shows the setup panel, creates the db and the extension folder; with the live userData it paired with the real Chrome profiles in 3 s and showed saved thumbnails; the .deb has the right desktop entry and dependencies; the AppImage runs; `win-unpacked/ToolFlow.exe` under wine creates the db (win32 sqlite prebuild loads) and the extension folder. The NSIS installer itself was not run end to end (under wine it stops at its PowerShell "is the app running" check); install on real Windows is the open check.

## Auto-update

`src/main/updates.ts` (electron-updater): the installed app checks 15 s after start and every 6 h, downloads a newer version in the background (progress in the top bar), then shows the bar "Bản mới X đã tải xong — Khởi động lại để cập nhật". The click is refused while any attempt is between prepare and its result (`BATCH_RUNNING`: a restart there could turn it uncertain); a downloaded update also installs when the user quits. Settings → Cập nhật shows the version, the state and "Kiểm tra bản mới".

**Extension after an update**: `installExtension` (connector/pairing.ts) copies the bundled extension into `<userData>/extension` at every start and writes the app version into that copy's `manifest.json`. Chrome keeps running the copy it loaded (and the old content script in open tabs) until the card is reloaded; the page reports the loaded version, so the self-check fails with `RELOAD_TAB`, S1 shows "Extension cần tải lại" with the steps, and auto-send stays off until it matches. Checked live on 2026-11-11 with both Chrome profiles (0.1.0 loaded → notice; reload card + F5 → Self-check: đạt).

**Host**: `publish` in `apps/desktop/electron-builder.yml`. Since 0.5.1: GitHub Releases of the public repo `ngquang2901-blip/test1` (temporary, chosen by the owner; it holds only release files, no source). Releases page: https://github.com/ngquang2901-blip/test1/releases/latest. Builds up to 0.5.0 carry the placeholder `https://updates.toolflow.invalid/toolflow/` and never update by themselves: install 0.5.1+ by hand once. Moving to another host = change that block (any https folder works with `provider: generic` + `url`), publish there, and ship one release from the old host that points to the new one. The files are checked against the sha512 in `latest*.yml`; the Windows installer is unsigned.

**Publishing a version** (the files that were tested are the files that ship; the release is a draft until they are all up):
1. Bump `version` in `apps/desktop/package.json`, run the gate, build with `--publish never` (command at the top).
2. Smoke-test the packaged app: Playwright `_electron.launch({ executablePath: 'dist/linux-unpacked/toolflow' })` with `TOOLFLOW_FAKE_DRIVER=1`.
3. Create a draft release `v<version>` (GitHub API `POST /repos/<owner>/<repo>/releases` with `draft: true`; `electron-builder publish` does not create one by itself and silently skips every file).
4. Upload: `GH_TOKEN="$(cat ~/.config/toolflow/github-token)" npx electron-builder publish -v <version> -f dist/ToolFlow-<v>-Setup.exe dist/ToolFlow-<v>-Setup.exe.blockmap dist/ToolFlow-<v>-x86_64.AppImage dist/ToolFlow-<v>-amd64.deb dist/latest-linux.yml dist/latest.yml`
5. List the release assets (6, `state: uploaded`, sizes equal to `dist/`), then `PATCH` the release with `draft: false`.
6. Check the real thing: download the previous version's AppImage from the releases page, run it, and watch it update itself.

The token (user `ngquang2901-blip`, scope `repo`, from a GitHub device login) lives in `~/.config/toolflow/github-token` (0600); never print it or pass it as an argument (the server is shared and argv shows in `ps`). Revoke it in GitHub → Settings → Applications. `TOOLFLOW_UPDATE_URL=http(s)://…` overrides the source at run time (testing).

Checked on 2026-11-11 with a local `python3 -m http.server` holding a 0.5.1 build: the 0.5.0 AppImage found it, downloaded it in 15 s, the click replaced the AppImage at its own path (sha256 equal to the served file) and the same file then started as 0.5.1 and reported "Bạn đang dùng bản mới nhất". Same loop against the real host: a 0.5.0 AppImage built with the GitHub config found v0.5.1 on `ngquang2901-blip/test1`, downloaded it in 25 s, replaced itself (sha256 = the published asset) and relaunched as 0.5.1. 0.5.2 was published this way: the 0.5.1 AppImage downloaded from the releases page updated itself to 0.5.2 in 25 s (sha256 = the published asset). Not yet run: the Windows (NSIS) and .deb update paths on real machines (.deb updates ask for the admin password via pkexec).
