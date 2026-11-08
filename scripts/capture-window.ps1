<#
Captures one window by process name or title, at 1920x1080 by default. It uses PrintWindow so only that window is asked
to draw; if the window refuses, it falls back to the screen rectangle of that window only. Run from WSL:
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/capture-window.ps1 -ProcessName notepad -Output C:\temp\shot.png
#>
param(
    [int]$ProcessId = 0,
    [string]$ProcessName = "",
    [string]$WindowTitle = "",
    [Parameter(Mandatory = $true)][string]$Output,
    [int]$Width = 1920,
    [int]$Height = 1080
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class JigCapture {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
$window = $null
if ($ProcessId -ne 0) {
    $window = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
} elseif ($ProcessName -ne "") {
    $window = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and [JigCapture]::IsWindowVisible($_.MainWindowHandle) } |
        Select-Object -First 1
} elseif ($WindowTitle -ne "") {
    $window = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$WindowTitle*" } |
        Select-Object -First 1
}
if ($null -eq $window) { throw "No visible window matched." }
$hwnd = [IntPtr]$window.MainWindowHandle
$rect = New-Object JigCapture+RECT
if (-not [JigCapture]::GetWindowRect($hwnd, [ref]$rect)) { throw "GetWindowRect failed." }
$sourceWidth = $rect.Right - $rect.Left
$sourceHeight = $rect.Bottom - $rect.Top
if ($sourceWidth -le 0 -or $sourceHeight -le 0) { throw "The window has no size." }
$source = New-Object System.Drawing.Bitmap $sourceWidth, $sourceHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($source)
$hdc = $graphics.GetHdc()
try {
    $printed = [JigCapture]::PrintWindow($hwnd, $hdc, 2)
} finally {
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
}
if (-not $printed) {
    $source.Dispose()
    $source = New-Object System.Drawing.Bitmap $sourceWidth, $sourceHeight
    $graphics = [System.Drawing.Graphics]::FromImage($source)
    try { $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $sourceWidth, $sourceHeight)) }
    finally { $graphics.Dispose() }
}
$target = New-Object System.Drawing.Bitmap $Width, $Height
$targetGraphics = [System.Drawing.Graphics]::FromImage($target)
$targetGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$targetGraphics.DrawImage($source, 0, 0, $Width, $Height)
$targetGraphics.Dispose()
$source.Dispose()
$dir = Split-Path -Parent $Output
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$target.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
$target.Dispose()
Write-Output $Output
