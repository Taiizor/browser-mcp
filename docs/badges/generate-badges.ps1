# Generates self-hosted SVG badges (GitHub camo chokes on very long shields data-URLs).
#
# Usage:
#   ./generate-badges.ps1
#
# Output:
#   edge-addons.svg   shields-style badge with embedded Edge logo (from svgl.app artwork)

$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$TmpEdge = Join-Path ([System.Environment]::GetEnvironmentVariable('TEMP', 'User')) 'opencode/edge-svgl.svg'

if (-not (Test-Path $TmpEdge)) {
  Invoke-WebRequest -Uri 'https://svgl.app/library/edge.svg' -OutFile $TmpEdge
}
$edge = [System.IO.File]::ReadAllText($TmpEdge)

# Fixed geometry with textLength so the badge fits regardless of font metrics.
# Widths follow shields.io's own metrics for these labels (77px / 31px at 11px
# Verdana, same center offsets shields uses for logo badges).
$lw = 104; $rw = 41; $W = $lw + $rw
$inner = $edge -replace '<svg([^>]*)>', "<svg x='5' y='3' width='14' height='14' viewBox='0 0 256 256'>"

$svg = "<svg xmlns='http://www.w3.org/2000/svg' width='$W' height='20' role='img' aria-label='Edge Add-ons: Get it'><title>Edge Add-ons: Get it</title><linearGradient id='s' x2='0' y2='100%'><stop offset='0' stop-color='#bbb' stop-opacity='.1'/><stop offset='1' stop-opacity='.1'/></linearGradient><clipPath id='r'><rect width='$W' height='20' rx='3'/></clipPath><g clip-path='url(#r)'><rect width='$lw' height='20' fill='#555'/><rect x='$lw' width='$rw' height='20' fill='#007ec6'/><rect width='$W' height='20' fill='url(#s)'/></g>$inner<g fill='#fff' text-anchor='middle' font-family='Verdana,Geneva,DejaVu Sans,sans-serif' font-size='11'><text x='61.5' y='14' textLength='77'>Edge Add-ons</text><text x='123.5' y='14' textLength='31'>Get it</text></g></svg>"

$Out = Join-Path $Here 'edge-addons.svg'
[System.IO.File]::WriteAllText($Out, $svg)
Write-Host "saved $Out (${W}x20)"
