$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $ProjectRoot "data"
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$Russia = Join-Path $DataDir "russia.geojson"
$World = Join-Path $DataDir "world.geojson"

Write-Host "Downloading Russia ADM1 vector map..."
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://raw.githubusercontent.com/codeforgermany/click_that_hood/48ba05ad4c6969e3b3c25735492169227ae411f1/public/data/russia.geojson" `
  -OutFile $Russia

Write-Host "Downloading Natural Earth world vector map..."
Invoke-WebRequest -UseBasicParsing `
  -Uri "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson" `
  -OutFile $World

$r = Get-Content -Raw -Encoding UTF8 $Russia | ConvertFrom-Json
$w = Get-Content -Raw -Encoding UTF8 $World | ConvertFrom-Json
if ($r.type -ne "FeatureCollection" -or $r.features.Count -lt 70) { throw "Russia GeoJSON validation failed" }
if ($w.type -ne "FeatureCollection" -or $w.features.Count -lt 150) { throw "World GeoJSON validation failed" }

Write-Host ("Russia features: " + $r.features.Count)
Write-Host ("World features: " + $w.features.Count)
Write-Host "Vector basemap installed successfully."
