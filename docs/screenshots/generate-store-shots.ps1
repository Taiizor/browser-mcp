# Generates Edge Add-ons store screenshots (1280x800 PNG) from popup captures.
#
# Usage:
#   ./generate-store-shots.ps1
#
# Inputs (same folder):
#   popup-permissions.png      360px-wide popup capture (Permissions tab)
#   popup-recent-commands.png  360px-wide popup capture (Recent Commands tab)
# Outputs (same folder):
#   store-1-permissions.png    1280x800 store screenshot
#   store-2-auditlog.png       1280x800 store screenshot
#
# Requires: Windows PowerShell 5.1+ (uses System.Drawing).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent (Split-Path -Parent $Here)
$IconFile = Join-Path $Repo 'extension/icons/icon64.png'

function New-StoreShot($PopupFile, $Title, $Lines, $OutFile) {
  $W = 1280; $H = 800
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.Clear([System.Drawing.Color]::FromArgb(19, 19, 22))
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $popup = [System.Drawing.Image]::FromFile($PopupFile)
    try {
      $scale = 660.0 / $popup.Height
      $pw = [int]($popup.Width * $scale)
      $g.DrawImage($popup, 90, 70, $pw, 660)
    } finally { $popup.Dispose() }

    $white = [System.Drawing.Brushes]::White
    $gray = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(161, 161, 170))
    $accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(96, 165, 250))
    try {
      $fTitle = New-Object System.Drawing.Font('Segoe UI', 44, [System.Drawing.FontStyle]::Bold)
      $fSub = New-Object System.Drawing.Font('Segoe UI', 24)
      $fBody = New-Object System.Drawing.Font('Segoe UI', 22)
      $fSmall = New-Object System.Drawing.Font('Segoe UI', 20)
      try {
        $x = 620
        $g.DrawString('Browser MCP Bridge', $fSub, $accent, $x, 120)
        $g.DrawString($Title, $fTitle, $white, $x, 165)
        $y = 300
        foreach ($ln in $Lines) {
          $g.DrawString(([char]0x2022 + '  ' + $ln), $fBody, $gray, $x, $y)
          $y += 52
        }
        $icon = [System.Drawing.Image]::FromFile($IconFile)
        try {
          $g.DrawImage($icon, $x, 640, 64, 64)
        } finally { $icon.Dispose() }
        $bullet = [char]0x2022
        $g.DrawString(('Local-first  ' + $bullet + '  111 MCP tools  ' + $bullet + '  MIT'), $fSmall, $gray, ($x + 80), 658)
      } finally {
        $fTitle.Dispose(); $fSub.Dispose(); $fBody.Dispose(); $fSmall.Dispose()
      }
    } finally {
      $gray.Dispose(); $accent.Dispose()
    }
  } finally { $g.Dispose() }
  $bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  $check = [System.Drawing.Image]::FromFile($OutFile)
  try {
    if ($check.Width -ne 1280 -or $check.Height -ne 800) {
      throw "Unexpected dimensions for $OutFile : $($check.Width)x$($check.Height)"
    }
    Write-Host "saved $OutFile ($($check.Width)x$($check.Height))"
  } finally { $check.Dispose() }
}

New-StoreShot (Join-Path $Here 'popup-permissions.png') 'Full control.' @(
  'Live connection status',
  '18 permission categories',
  'Master + per-tool toggles',
  'Instant sync, no reload'
) (Join-Path $Here 'store-1-permissions.png')

New-StoreShot (Join-Path $Here 'popup-recent-commands.png') 'Full transparency.' @(
  'Live audit log of AI commands',
  'Durations and timestamps',
  'Per-command status',
  'One-click clear'
) (Join-Path $Here 'store-2-auditlog.png')

# GitHub social preview (1280x640, upload via repo Settings > Social preview)
$SW = 1280; $SH = 640
$sbmp = New-Object System.Drawing.Bitmap($SW, $SH)
$sg = [System.Drawing.Graphics]::FromImage($sbmp)
try {
  $sg.Clear([System.Drawing.Color]::FromArgb(19, 19, 22))
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $sicon = [System.Drawing.Image]::FromFile((Join-Path $Repo 'extension/icons/icon256.png'))
  try {
    $sg.DrawImage($sicon, 120, 192, 256, 256)
  } finally { $sicon.Dispose() }
  $swhite = [System.Drawing.Brushes]::White
  $sgray = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(161, 161, 170))
  $saccent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(96, 165, 250))
  try {
    $sfTitle = New-Object System.Drawing.Font('Segoe UI', 72, [System.Drawing.FontStyle]::Bold)
    $sfSub = New-Object System.Drawing.Font('Segoe UI', 30)
    $sfSmall = New-Object System.Drawing.Font('Segoe UI', 24)
    try {
      $sg.DrawString('Browser MCP', $sfTitle, $swhite, 420, 190)
      $sg.DrawString('Full-authority browser bridge for AI assistants', $sfSub, $sgray, 424, 310)
      $sg.DrawString('111 MCP tools  ' + [char]0x2022 + '  Chromium MV3  ' + [char]0x2022 + '  MIT', $sfSmall, $saccent, 424, 380)
    } finally {
      $sfTitle.Dispose(); $sfSub.Dispose(); $sfSmall.Dispose()
    }
  } finally {
    $sgray.Dispose(); $saccent.Dispose()
  }
} finally { $sg.Dispose() }
$SocialOut = Join-Path $Here 'social-preview-1280x640.png'
$sbmp.Save($SocialOut, [System.Drawing.Imaging.ImageFormat]::Png)
$sbmp.Dispose()
$scheck = [System.Drawing.Image]::FromFile($SocialOut)
try {
  if ($scheck.Width -ne 1280 -or $scheck.Height -ne 640) {
    throw "Unexpected dimensions for $SocialOut : $($scheck.Width)x$($scheck.Height)"
  }
  Write-Host "saved $SocialOut ($($scheck.Width)x$($scheck.Height))"
} finally { $scheck.Dispose() }
