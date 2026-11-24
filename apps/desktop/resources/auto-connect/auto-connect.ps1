param(
  [ValidateSet('setup', 'restart')][string]$mode = 'setup',
  [string]$chrome, [string]$ext, [string]$url = 'https://labs.google/fx/tools/flow', [string]$flags = '',
  [string]$profileDir = '' # tests only: a throwaway Chrome profile instead of the user's own Chrome
)
# "Kết nối tự động" (ToolFlow): adds ToolFlow's extension folder to the user's own Chrome with no click from the user.
#  setup:   close Chrome, start it again with its last session + accessibility on, open chrome://extensions in a new tab,
#           turn on Developer mode, press Load unpacked, fill the folder dialog.
#  restart: close Chrome and start it again with its last session plus Google Flow, without the accessibility switch (it slows heavy pages).
# Measured on Chrome 157: Chrome's page is readable through MSAA only when started with --force-renderer-accessibility; pressing
# a page button through MSAA opens the folder dialog; the dialog's Folder box (id 1152) + Select Folder (id 1) load the folder.
# Prints one line per step for ToolFlow: "STEP <name>", then "LOADED" / "DONE", or "FAIL <CODE>".
$ErrorActionPreference = 'Stop'
function say($m) { [Console]::Out.WriteLine($m); [Console]::Out.Flush() }
$t0 = Get-Date
function dbg($m) { if ($env:TF_AC_DEBUG) { [Console]::Error.WriteLine(('{0,5:N1}s {1}' -f ((Get-Date) - $t0).TotalSeconds, $m)) } } # page labels and window titles only
function fail($code) { say "FAIL $code"; exit 1 }
trap { [Console]::Error.WriteLine("$($_.InvocationInfo.ScriptLineNumber): $_"); say "FAIL SCRIPT_ERROR"; exit 1 } # the line and message go to stderr for the log, never a page text
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies Accessibility -Path (Join-Path $PSScriptRoot 'native.cs')
$UA = [System.Windows.Automation.AutomationElement]
function until($secs, [scriptblock]$f) { $end = (Get-Date).AddSeconds($secs); do { $r = & $f; if ($r) { return $r }; Start-Sleep -Milliseconds 250 } while ((Get-Date) -lt $end); $null }

# The user's own Chrome: browser processes of this chrome.exe started without a profile folder of their own (test or automation Chromes are left alone)
function browserPids() {
  @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | ? { $_.ExecutablePath -eq $chrome -and $_.CommandLine -notmatch '--type=' -and $(if ($profileDir) { $_.CommandLine -like "*$profileDir*" } else { $_.CommandLine -notmatch '--user-data-dir' }) } | % { [uint32]$_.ProcessId })
}
function closeChrome() {
  $pids = browserPids
  if (-not $pids.Count) { return }
  # shortcut: each window gets its own close, so with several windows Chrome's last session keeps the last one closed; one window is the usual case
  foreach ($h in [TfWin]::Windows($pids)) { [TfWin]::Close($h) }
  if (-not (until 20 { -not [TfWin]::Windows((browserPids)).Count })) { fail 'CHROME_WONT_CLOSE' } # a "Leave site?" question, or Chrome busy
  if (-not (until 8 { -not (browserPids).Count })) { browserPids | % { Stop-Process -Id $_ -Force -ea 0 } } # windows gone, process kept by "continue running background apps": its session is already saved
  if (-not (until 5 { -not (browserPids).Count })) { fail 'CHROME_WONT_CLOSE' }
}
function launch([string[]]$more) {
  $a = @(($flags -split ' ') | ? { $_ }) + $more
  if ($profileDir) { $a = @("--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check') + $a }
  Start-Process $chrome -ArgumentList $a | Out-Null
}
function go($w, [string]$to) {
  $box = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($UA::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
  if (-not $box) { return $false }
  $box.SetFocus(); Start-Sleep -Milliseconds 200
  $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($to)
  Start-Sleep -Milliseconds 300
  [TfWin]::Enter([IntPtr]$w.Current.NativeWindowHandle)
  $true
}

say 'STEP closing'
closeChrome
if ($mode -eq 'restart') {
  say 'STEP opening'
  launch @('--restore-last-session', $url)
  if (-not (until 20 { [TfWin]::Windows((browserPids)).Count })) { fail 'CHROME_NOT_STARTED' }
  say 'DONE'; exit 0
}

say 'STEP opening'
launch @('--force-renderer-accessibility', '--restore-last-session', 'about:blank')
$hwnd = until 25 { [TfWin]::Windows((browserPids)) | ? { [TfWin]::Title($_) -like 'about:blank*' } | select -First 1 }
if (-not $hwnd) { fail 'CHROME_NOT_STARTED' }
$w = $UA::FromHandle($hwnd)

say 'STEP loading'
$page = $null
for ($k = 0; $k -lt 5 -and -not $page; $k++) {
  if ([TfWin]::Title($hwnd) -like 'about:blank*') { [void](go $w 'chrome://extensions') } # only while the address bar has the focus: a later Enter would land on the page
  dbg "go extensions: title '$([TfWin]::Title($hwnd))'"
  # the extensions page: the visible page area whose tree has a check box (Developer mode) and a button
  $page = until 6 { if ([TfWin]::Title($hwnd) -notlike 'about:blank*') { foreach ($r in [TfWin]::Children($hwnd, 'Chrome_RenderWidgetHostHWND')) { if ([TfAcc]::Dev($r) -ge 0) { return $r } } } }
}
if (-not $page) { fail 'PAGE_NOT_READY' }
dbg "page ready, dev $([TfAcc]::Dev($page)), title '$([TfWin]::Title($hwnd))'"
if ([TfAcc]::Dev($page) -eq 0) {
  $before = [TfAcc]::ButtonsAfterDev($page)
  [void][TfAcc]::PressDev($page)
  # wait for the row Developer mode adds (3 buttons); until then the first button after it is an extension card's Details
  if (-not (until 6 { [TfAcc]::Dev($page) -eq 1 -and [TfAcc]::ButtonsAfterDev($page) -ge $before + 3 })) { fail 'DEV_MODE' }
}
if ([TfAcc]::Dev($page) -ne 1) { fail 'DEV_MODE' }
$dlg = $null
for ($k = 0; $k -lt 2 -and -not $dlg; $k++) { dbg "press load: $([TfAcc]::LoadName($page))"; [void][TfAcc]::PressLoad($page); $dlg = until 8 { $d = [TfWin]::OwnedDialog($hwnd); if ($d -ne [IntPtr]::Zero) { $d } } }
if (-not $dlg) { fail 'NO_FOLDER_DIALOG' }
$box = until 5 { $e = [TfWin]::DlgItem($dlg, 1152, 'Edit'); if ($e -ne [IntPtr]::Zero) { $e } }
$ok = [TfWin]::DlgItem($dlg, 1, 'Button')
if (-not $box -or $ok -eq [IntPtr]::Zero) { fail 'NO_FOLDER_DIALOG' }
dbg 'dialog up'; [TfWin]::SetText($box, $ext); Start-Sleep -Milliseconds 300
[TfWin]::Click($ok)
if (-not (until 4 { -not [TfWin]::IsWindow($dlg) })) { [TfWin]::Click($ok); if (-not (until 4 { -not [TfWin]::IsWindow($dlg) })) { fail 'FOLDER_NOT_TAKEN' } }
dbg "dialog closed, title '$([TfWin]::Title($hwnd))'"
if (-not (until 10 { foreach ($r in [TfWin]::Children($hwnd, 'Chrome_RenderWidgetHostHWND')) { if ([TfAcc]::Mentions($r, 'ToolFlow')) { return $true } } })) { fail 'LOAD_FAILED' } # Chrome refused the folder (its error box is on the page)
say 'LOADED'
