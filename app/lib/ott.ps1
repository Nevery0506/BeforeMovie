# PreShow: open the OTT address in the browser and make the new window full screen right away.
# 1) Remember the browser windows that already exist.
# 2) Print READY and wait for one line on standard input (the "go" signal), unless -NoWait.
# 3) Start the browser, find the window that was not there before, bring it to the front,
#    and press F11 only if that window is not full screen yet (checked against its monitor).
param(
  [string]$Exe,
  [string]$Url,
  [string]$Proc = 'chrome',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [switch]$NoWait
)
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class PsWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cb; public RECT rcMonitor; public RECT rcWork; public uint flags; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  // Visible top-level browser windows that belong to one of the given process ids.
  public static long[] Windows(uint[] pids) {
    List<long> found = new List<long>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      StringBuilder sb = new StringBuilder(64);
      GetClassName(h, sb, 64);
      if (sb.ToString() != "Chrome_WidgetWin_1") return true;
      if (GetWindowTextLength(h) == 0) return true;
      found.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  // True when the window covers its whole monitor (that is what browser full screen does).
  public static bool IsFull(long hw) {
    IntPtr h = new IntPtr(hw);
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    MONITORINFO mi = new MONITORINFO();
    mi.cb = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
    return Math.Abs(r.L - mi.rcMonitor.L) <= 2 && Math.Abs(r.T - mi.rcMonitor.T) <= 2 &&
           Math.Abs(r.R - mi.rcMonitor.R) <= 2 && Math.Abs(r.B - mi.rcMonitor.B) <= 2;
  }
  public static void Front(long hw) {
    IntPtr h = new IntPtr(hw);
    BringWindowToTop(h);
    SetForegroundWindow(h);
  }
  public static void F11() {
    keybd_event(0x7A, 0, 0, UIntPtr.Zero);
    keybd_event(0x7A, 0, 2, UIntPtr.Zero);
  }
}
'@
Add-Type -TypeDefinition $src

function Say([string]$t) { [Console]::Out.WriteLine($t); [Console]::Out.Flush() }
function BrowserWindows {
  $ids = @(Get-Process -Name $Proc -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if ($ids.Count -eq 0) { return @() }
  return @([PsWin]::Windows([uint32[]]$ids))
}

$before = @(BrowserWindows)
Say 'READY'
if (-not $NoWait) { $null = [Console]::In.ReadLine() }

$list = @('--new-window')
if ($W -gt 0 -and $H -gt 0) { $list += "--window-position=$X,$Y"; $list += "--window-size=$W,$H" }
$list += ('"' + $Url + '"')
Start-Process -FilePath $Exe -ArgumentList $list
Say 'LAUNCHED'

# Wait (up to 20 seconds) for the window that was not there before.
$target = 0
for ($i = 0; $i -lt 200 -and $target -eq 0; $i++) {
  Start-Sleep -Milliseconds 100
  foreach ($w in @(BrowserWindows)) { if ($before -notcontains $w) { $target = $w; break } }
}
if ($target -eq 0) { Say 'NOWINDOW'; exit 2 }

Start-Sleep -Milliseconds 250
for ($try = 0; $try -lt 3; $try++) {
  if ([PsWin]::IsFull($target)) { break }
  [PsWin]::Front($target)
  Start-Sleep -Milliseconds 150
  [PsWin]::F11()
  Start-Sleep -Milliseconds 900
}
if ([PsWin]::IsFull($target)) { Say 'FULL' } else { Say 'NOTFULL' }
exit 0
