# Windows x64: install Tauri FFmpeg/ffprobe sidecars for this host.
#
# Prefer downloading CI-built Squeeze-minimal artifacts (small). Falls back to
# instructions if none are available — Windows source builds use the Linux
# mingw cross job in GitHub Actions (see .github/workflows/build-ffmpeg.yml).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/setup-ffmpeg.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/setup-ffmpeg.ps1 -Tag ffmpeg-sidecars-YYYYMMDD
#   powershell -ExecutionPolicy Bypass -File scripts/setup-ffmpeg.ps1 -Force

param(
    [string]$Tag = $env:SQUEEZE_FFMPEG_TAG,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows -and $env:OS -ne "Windows_NT") {
    Write-Error "setup-ffmpeg.ps1 is for Windows. On macOS/Linux use scripts/setup-ffmpeg.sh."
    exit 1
}

$TargetTriple = "x86_64-pc-windows-msvc"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$BinariesDir = Join-Path $RepoRoot "src-tauri\binaries"
$FfmpegOut = Join-Path $BinariesDir "ffmpeg-$TargetTriple.exe"
$FfprobeOut = Join-Path $BinariesDir "ffprobe-$TargetTriple.exe"

function Show-SidecarSizes {
    param([string]$FfmpegPath, [string]$FfprobePath)
    $ffMb = [math]::Round((Get-Item -LiteralPath $FfmpegPath).Length / 1MB, 1)
    $fpMb = [math]::Round((Get-Item -LiteralPath $FfprobePath).Length / 1MB, 1)
    Write-Host "  $FfmpegPath ($ffMb MB)"
    Write-Host "  $FfprobePath ($fpMb MB)"
}

if (-not $Force -and (Test-Path -LiteralPath $FfmpegOut) -and (Test-Path -LiteralPath $FfprobeOut)) {
    Write-Host "FFmpeg sidecars already present (Windows x64):"
    Show-SidecarSizes -FfmpegPath $FfmpegOut -FfprobePath $FfprobeOut
    exit 0
}

New-Item -ItemType Directory -Force -Path $BinariesDir | Out-Null

function Get-RepoSlug {
    try {
        $url = git -C $RepoRoot remote get-url origin 2>$null
        if ($url -match 'github\.com[:/](.+?)(?:\.git)?$') {
            return $Matches[1]
        }
    } catch {}
    return $null
}

function Install-FromGitHubRelease {
    $repo = Get-RepoSlug
    if (-not $repo) {
        return $false
    }

    $assetName = "squeeze-ffmpeg-$TargetTriple.zip"
    $apiBase = "https://api.github.com/repos/$repo"

    if ($Tag) {
        $releaseUrl = "$apiBase/releases/tags/$Tag"
    } else {
        # Prefer a dedicated ffmpeg-sidecars release; else latest release with the asset.
        $releases = Invoke-RestMethod -Uri "$apiBase/releases?per_page=20" -Headers @{
            "User-Agent" = "squeeze-setup-ffmpeg"
            "Accept"     = "application/vnd.github+json"
        }
        $match = $releases | Where-Object {
            $_.tag_name -like "ffmpeg-sidecars*" -or
            ($_.assets | Where-Object { $_.name -eq $assetName })
        } | Select-Object -First 1
        if (-not $match) {
            return $false
        }
        $releaseUrl = $match.url
    }

    Write-Host "Fetching release metadata: $releaseUrl"
    $release = Invoke-RestMethod -Uri $releaseUrl -Headers @{
        "User-Agent" = "squeeze-setup-ffmpeg"
        "Accept"     = "application/vnd.github+json"
    }
    $asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
    if (-not $asset) {
        Write-Host "Release has no asset named $assetName"
        return $false
    }

    $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("squeeze-ffmpeg-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
    try {
        $ZipPath = Join-Path $TempDir $assetName
        Write-Host "Downloading $($asset.browser_download_url) ..."
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $ZipPath -UseBasicParsing
        Expand-Archive -LiteralPath $ZipPath -DestinationPath $TempDir -Force

        $ExtractedFfmpeg = Get-ChildItem -Path $TempDir -Recurse -Filter "ffmpeg-$TargetTriple.exe" |
            Select-Object -First 1
        $ExtractedFfprobe = Get-ChildItem -Path $TempDir -Recurse -Filter "ffprobe-$TargetTriple.exe" |
            Select-Object -First 1

        if (-not $ExtractedFfmpeg -or -not $ExtractedFfprobe) {
            throw "Zip did not contain ffmpeg/ffprobe sidecars for $TargetTriple."
        }

        Copy-Item -LiteralPath $ExtractedFfmpeg.FullName -Destination $FfmpegOut -Force
        Copy-Item -LiteralPath $ExtractedFfprobe.FullName -Destination $FfprobeOut -Force
        return $true
    }
    finally {
        if (Test-Path -LiteralPath $TempDir) {
            Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$ok = $false
try {
    $ok = Install-FromGitHubRelease
} catch {
    Write-Host "Download failed: $_"
    $ok = $false
}

if (-not $ok) {
    Write-Host ""
    Write-Host "No prebuilt Squeeze-minimal FFmpeg sidecars were found for this repo yet."
    Write-Host "Build them via GitHub Actions:"
    Write-Host "  - Workflow: Build FFmpeg sidecars (.github/workflows/build-ffmpeg.yml)"
    Write-Host "  - Then re-run: npm run setup:ffmpeg"
    Write-Host ""
    Write-Host "Or copy CI artifacts manually into:"
    Write-Host "  $BinariesDir"
    Write-Host "    ffmpeg-$TargetTriple.exe"
    Write-Host "    ffprobe-$TargetTriple.exe"
    Write-Host ""
    Write-Host "Windows source builds are produced on Linux runners with mingw-w64"
    Write-Host "(see scripts/ffmpeg/build.sh). Local MSVC source builds are not supported."
    exit 1
}

Write-Host "Installed Windows x64 sidecars:"
Show-SidecarSizes -FfmpegPath $FfmpegOut -FfprobePath $FfprobeOut

# Quick capability check when the binary can run locally.
try {
    $encoders = & $FfmpegOut -hide_banner -encoders 2>&1 | Out-String
    if ($encoders -notmatch "libx264") {
        Write-Warning "libx264 encoder not listed — sidecar may be incomplete."
    }
    if ($encoders -notmatch "\baac\b") {
        Write-Warning "aac encoder not listed — sidecar may be incomplete."
    }
} catch {
    Write-Warning "Could not run capability check: $_"
}
