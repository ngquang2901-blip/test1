// Native helpers for auto-connect.ps1: MSAA (the accessibility API screen readers use) to read and press Chrome's page,
// Win32 for Chrome's windows and the folder dialog. Nothing here uses the real keyboard or mouse.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Accessibility;

public static class TfAcc {
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object o);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible p, int start, int count, [Out] object[] kids, out int got);
  static Guid IID = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
  public const int CHECKBOX = 44, BUTTON = 43, CHECKED = 0x10;

  public class Node { public IAccessible A; public int Child; }
  public static List<Node> Walk(IntPtr hwnd, int max) {
    var list = new List<Node>();
    object o; if (AccessibleObjectFromWindow(hwnd, 0xFFFFFFFC, ref IID, out o) != 0 || !(o is IAccessible)) return list;
    Rec((IAccessible)o, 0, list, max); return list;
  }
  static void Rec(IAccessible a, int d, List<Node> list, int max) {
    if (list.Count >= max || d > 80) return;
    int n = 0; try { n = a.accChildCount; } catch { }
    if (n <= 0) return;
    var kids = new object[n]; int got;
    if (AccessibleChildren(a, 0, n, kids, out got) != 0) return;
    for (int i = 0; i < got; i++) {
      var k = kids[i] as IAccessible;
      if (k != null) { list.Add(new Node { A = k }); Rec(k, d + 1, list, max); }
      else if (kids[i] is int) list.Add(new Node { A = a, Child = (int)kids[i] });
    }
  }
  public static string Name(Node x) { try { return x.A.get_accName(x.Child) ?? ""; } catch { return ""; } }
  public static int Role(Node x) { try { var r = x.A.get_accRole(x.Child); return r is int ? (int)r : -1; } catch { return -1; } }
  public static int State(Node x) { try { var r = x.A.get_accState(x.Child); return r is int ? (int)r : 0; } catch { return 0; } }
  public static bool Press(Node x) { try { x.A.accDoDefaultAction(x.Child); return true; } catch { return false; } }
  // The page's own order: the first check box is Developer mode; the first button after it is Load unpacked (both in any UI language).
  public static int IndexOf(List<Node> l, int role, int from) { for (int i = Math.Max(0, from); i < l.Count; i++) if (Role(l[i]) == role) return i; return -1; }
  public static bool Mentions(IntPtr page, string s) { foreach (var x in Walk(page, 4000)) if (Name(x).IndexOf(s, StringComparison.OrdinalIgnoreCase) >= 0) return true; return false; }
  // Developer mode: -1 not on the page, 0 off, 1 on (and its Load unpacked button shown)
  public static int Dev(IntPtr page) {
    var l = Walk(page, 4000); int i = IndexOf(l, CHECKBOX, 0);
    if (i < 0 || IndexOf(l, BUTTON, 0) < 0) return -1;
    return (State(l[i]) & CHECKED) != 0 && IndexOf(l, BUTTON, i + 1) > i ? 1 : 0;
  }
  // Buttons after Developer mode: turning it on adds its own row (Load unpacked, Pack, Update) ahead of the extension cards' buttons
  public static int ButtonsAfterDev(IntPtr page) { var l = Walk(page, 4000); int i = IndexOf(l, CHECKBOX, 0), n = 0; if (i < 0) return -1; for (int k = i + 1; k < l.Count; k++) if (Role(l[k]) == BUTTON) n++; return n; }
  public static bool PressDev(IntPtr page) { var l = Walk(page, 4000); int i = IndexOf(l, CHECKBOX, 0); return i >= 0 && Press(l[i]); }
  public static string LoadName(IntPtr page) { var l = Walk(page, 4000); int i = IndexOf(l, CHECKBOX, 0); int b = i < 0 ? -1 : IndexOf(l, BUTTON, i + 1); return b > i ? Name(l[b]) : "(none)"; }
  public static bool PressLoad(IntPtr page) { var l = Walk(page, 4000); int i = IndexOf(l, CHECKBOX, 0); int b = i < 0 ? -1 : IndexOf(l, BUTTON, i + 1); return b > i && Press(l[b]); }
}

public static class TfWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Cls(IntPtr h) { var sb = new StringBuilder(128); GetClassName(h, sb, 128); return sb.ToString(); }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }

  // Visible top-level Chrome windows of these processes (browser windows, not popups' hidden helpers)
  public static IntPtr[] Windows(uint[] pids) {
    var set = new HashSet<uint>(pids ?? new uint[0]); /* PowerShell hands an empty list over as null */ var r = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (set.Contains(p) && IsWindowVisible(h) && Cls(h) == "Chrome_WidgetWin_1" && Title(h).Length > 0) r.Add(h); return true; }, IntPtr.Zero);
    return r.ToArray();
  }
  public static IntPtr[] Children(IntPtr top, string cls) {
    var r = new List<IntPtr>();
    EnumChildWindows(top, (h, l) => { if (Cls(h) == cls && IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero);
    return r.ToArray();
  }
  // The folder picker Chrome opens for Load unpacked: a #32770 dialog owned by the browser window
  public static IntPtr OwnedDialog(IntPtr owner) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { if (Cls(h) == "#32770" && IsWindowVisible(h) && GetWindow(h, 4) == owner) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static IntPtr DlgItem(IntPtr dlg, int id, string cls) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dlg, (h, l) => { if (GetDlgCtrlID(h) == id && Cls(h) == cls) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static void SetText(IntPtr h, string s) { SendMessage(h, 0x000C, IntPtr.Zero, s); }
  public static void Click(IntPtr h) { SendMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
  public static void Close(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); }
  // Enter posted to the window: reaches Chrome's focused view (the address bar) without the window being in front
  public static void Enter(IntPtr h) {
    PostMessage(h, 0x100, (IntPtr)0x0D, (IntPtr)0x001C0001); PostMessage(h, 0x102, (IntPtr)0x0D, (IntPtr)0x001C0001); PostMessage(h, 0x101, (IntPtr)0x0D, unchecked((IntPtr)(int)0xC01C0001));
  }
}
