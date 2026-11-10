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
