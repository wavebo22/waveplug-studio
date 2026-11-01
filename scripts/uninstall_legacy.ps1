# Removes the old WavePlug (com.waveplug.psai 0.6.1), OpenLayer and SD-PPP from Photoshop and
# ComfyUI, plus the old WavePlug development files in F:\waveplug (everything except studio).
#
# Nothing is deleted: every file/folder is MOVED into F:\waveplug_uninstalled_<time>\ so it can
# be restored. Delete that folder yourself once everything works.
# Kept on purpose:
#   - WavePlug Studio (com.waveplug.studio / .dev) and F:\waveplug\studio
#   - ComfyUI custom_nodes\waveplug_author_compat (provides nodes Gu Hai's workflows use)
#   - D:\App\Adobe-UPIA-Extract (the installer WavePlug Studio uses)

$ErrorActionPreference = "Continue"
$stamp = Get-Date -Format "yyyyMMdd_HHmm"
$Q = "F:\waveplug_uninstalled_$stamp"
New-Item -ItemType Directory -Force $Q | Out-Null
Start-Transcript -Path "$Q\uninstall.log" | Out-Null

if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) { Write-Host "Photoshop is running. Save your work, close it, and run this again."; Stop-Transcript | Out-Null; exit 1 }
$comfy = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match "ComfyUI" }
if ($comfy) { Write-Host "ComfyUI is running. Close it, and run this again."; Stop-Transcript | Out-Null; exit 1 }

$UPIA = "D:\App\Adobe-UPIA-Extract\UPI64-unpacked\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
$COMFY = "J:\AI things\ComfyUI\ComfyUI_windows_portable\ComfyUI"
$LEGACY = '^(com\.waveplug\.psai(_.*)?|1e827d3d(_.*)?|.*sd-?ppp.*)$'   # never matches com.waveplug.studio

function Park([string]$path, [string]$label) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $dest = Join-Path $Q $label
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  try { Move-Item -LiteralPath $path -Destination $dest -Force -ErrorAction Stop; Write-Host "moved   $path"; Write-Host "     -> $dest" }
  catch { Write-Host "FAILED  $path : $($_.Exception.Message)" }
}

if (-not (Test-Path -LiteralPath $UPIA)) { Write-Host "UPIA not found at $UPIA"; Stop-Transcript | Out-Null; exit 1 }

Write-Host "=== 1. Unregister from Photoshop (Adobe UPIA) ==="
Set-Location $env:USERPROFILE          # UPIA fails with -198 when started from F:/J:
& $UPIA /list all
foreach ($name in @("OpenLayer", "WavePlug - PS AI Studio")) { & $UPIA /remove "$name" }
& $UPIA /list all

Write-Host "=== 2. Plugin folders left behind ==="
$roots = @("C:\Program Files\Common Files\Adobe\UXP\Plugins\External", "$env:APPDATA\Adobe\UXP\Plugins\External", "F:\App Data\Adobe\UXP\Plugins\External")
foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $LEGACY } |
    ForEach-Object { Park $_.FullName ("uxp_plugins\" + ($root -replace '[:\\ ]', '_') + "\" + $_.Name) }
}

Write-Host "=== 3. Plugin data (settings, caches) ==="
Get-ChildItem "$env:APPDATA\Adobe\UXP\PluginsStorage" -Directory -Recurse -Depth 3 -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match $LEGACY -and $_.Parent.Name -in @("External", "Developer") } |
  ForEach-Object { Park $_.FullName ("uxp_data\" + $_.Parent.Parent.Name + "_" + $_.Parent.Name + "\" + $_.Name) }

Write-Host "=== 4. Registry entries that UPIA did not remove (side-loaded SD-PPP etc.) ==="
$infos = @("C:\Program Files\Common Files\Adobe\UXP\PluginsInfo\v1\PS.json", "$env:APPDATA\Adobe\UXP\PluginsInfo\v1\PS.json", "F:\App Data\Adobe\UXP\PluginsInfo\v1\PS.json")
foreach ($info in $infos) {
  if (-not (Test-Path -LiteralPath $info)) { continue }
  $raw = [IO.File]::ReadAllText($info)
  try { $json = $raw | ConvertFrom-Json } catch { Write-Host "skip (not JSON): $info"; continue }
  if (-not $json.plugins) { continue }
  $keep = @($json.plugins | Where-Object { -not ($_.pluginId -match $LEGACY -or $_.name -match 'OpenLayer|PS AI Studio|sd-?ppp') })
  if ($keep.Count -eq @($json.plugins).Count) { Write-Host "clean   $info"; continue }
  $backup = Join-Path $Q ("registry_backup\" + ($info -replace '[:\\ ]', '_'))
  New-Item -ItemType Directory -Force (Split-Path $backup) | Out-Null
  Copy-Item -LiteralPath $info -Destination $backup
  $json.plugins = $keep
  [IO.File]::WriteAllText($info, ($json | ConvertTo-Json -Depth 32), (New-Object Text.UTF8Encoding $false))
  Write-Host "edited  $info (backup: $backup)"
}

Write-Host "=== 5. ComfyUI custom nodes ==="
Park "$COMFY\custom_nodes\sd-ppp" "comfyui_custom_nodes\sd-ppp"
Park "$COMFY\custom_nodes\waveplug_link_v2" "comfyui_custom_nodes\waveplug_link_v2"
Write-Host "kept    $COMFY\custom_nodes\waveplug_author_compat (used by Gu Hai workflows)"

Write-Host "=== 6. Old WavePlug development files (F:\waveplug, except studio) ==="
Get-ChildItem -LiteralPath "F:\waveplug" -Force | Where-Object { $_.Name -ne "studio" } |
  ForEach-Object { Park $_.FullName ("waveplug_old\" + $_.Name) }

Write-Host ""
Write-Host "Done. Everything removed was moved to: $Q"
Write-Host "Start Photoshop and check Plugins menu; delete $Q yourself when all is fine."
Stop-Transcript | Out-Null
