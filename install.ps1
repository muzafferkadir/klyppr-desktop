# Klyppr installer for Windows.
#   irm https://raw.githubusercontent.com/muzafferkadir/klyppr-desktop/main/install.ps1 | iex
# Downloads the latest signed NSIS installer from GitHub Releases and runs it.
# (The app downloads FFmpeg itself on first launch.)

$ErrorActionPreference = 'Stop'
$repo = 'muzafferkadir/klyppr-desktop'

Write-Host 'Fetching the latest Klyppr release…'
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'klyppr-installer' }

$asset = $release.assets | Where-Object { $_.name -like '*x64-setup.exe' } | Select-Object -First 1
if (-not $asset) { throw 'No Windows installer (.exe) found in the latest release.' }

$out = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name)…"
Invoke-WebRequest $asset.browser_download_url -OutFile $out -UseBasicParsing

Write-Host 'Running the installer…'
Start-Process -FilePath $out -Wait

Write-Host 'Klyppr installed. Launch it from the Start menu.'
