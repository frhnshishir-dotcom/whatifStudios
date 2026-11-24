# Installs the studio fonts for the current user (no admin needed). Run:
#   powershell -ExecutionPolicy Bypass -File install_fonts.ps1
$dest = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$reg = "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts"
Get-ChildItem -Path $PSScriptRoot -Include *.otf,*.ttf -Recurse | ForEach-Object {
  $target = Join-Path $dest $_.Name
  Copy-Item $_.FullName $target -Force
  $kind = if ($_.Extension -eq ".otf") { "OpenType" } else { "TrueType" }
  New-ItemProperty -Path $reg -Name "$($_.BaseName) ($kind)" -Value $target -PropertyType String -Force | Out-Null
  Write-Host "installed $($_.Name)"
}
Write-Host "Done. Restart PowerPoint so it sees the new fonts."
