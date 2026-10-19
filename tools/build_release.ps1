#requires -Version 5.1
<#
.SYNOPSIS
    Build the ComfyDeck portable archive and Windows installer.

.EXAMPLE
    pwsh -File tools\build_release.ps1
    pwsh -File tools\build_release.ps1 -Version 2.1.0 -SkipToolInstall
#>
[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$Python = "",
    [switch]$SkipInstaller,
    [switch]$SkipToolInstall,
    [switch]$NoVenv
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$env:PYTHONUTF8 = "1"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Find-Python([string]$Explicit) {
    if ($Explicit) {
        if (-not (Test-Path -LiteralPath $Explicit)) { throw "指定的 Python 不存在：$Explicit" }
        return (Resolve-Path -LiteralPath $Explicit).Path
    }
    $command = Get-Command python -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $portable = Join-Path (Split-Path -Parent $root) "python_embeded\python.exe"
    if (Test-Path -LiteralPath $portable) { return $portable }
    throw "没有找到 Python。请安装 Python 3.10+ 或用 -Python 指定路径。"
}

function Find-Iscc {
    $command = Get-Command iscc -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return $null
}

if (-not $Version) {
    $initFile = Join-Path $root "comfydeck\__init__.py"
    $initText = Get-Content -Raw -LiteralPath $initFile
    if ($initText -match '__version__\s*=\s*"([^"]+)"') {
        $Version = $Matches[1]
    } else {
        throw "无法从 comfydeck/__init__.py 读取版本号。"
    }
}

Write-Step "版本 $Version"

# ---------------------------------------------------------------- Python / venv
$basePython = Find-Python $Python
Write-Host "Python: $basePython"
$buildPython = $basePython
if (-not $NoVenv) {
    $venvDir = Join-Path $root ".buildvenv"
    $venvPython = Join-Path $venvDir "Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $venvPython)) {
        Write-Step "创建构建虚拟环境"
        & $basePython -m venv $venvDir
        if ($LASTEXITCODE -ne 0) { throw "创建虚拟环境失败。" }
    }
    $buildPython = $venvPython
}
Write-Host "构建解释器: $buildPython"

Write-Step "安装构建依赖"
& $buildPython -m pip install --upgrade pip
& $buildPython -m pip install -r (Join-Path $root "requirements.txt") "pyinstaller>=6.6,<7"
if ($LASTEXITCODE -ne 0) { throw "安装构建依赖失败。" }

# ------------------------------------------------------------------- PyInstaller
Write-Step "PyInstaller 打包"
$distRoot = Join-Path $root "dist"
$workRoot = Join-Path $root "build"
$releaseDir = Join-Path $distRoot "release"
foreach ($path in @((Join-Path $distRoot "ComfyDeck"), (Join-Path $releaseDir "ComfyDeck-$Version-portable-win64"))) {
    if (Test-Path -LiteralPath $path) { Remove-Item -Recurse -Force -LiteralPath $path }
}
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$pyInstallerArgs = @(
    "-m", "PyInstaller",
    "--noconfirm", "--clean", "--onedir", "--windowed",
    "--name", "ComfyDeck",
    "--icon", (Join-Path $root "installer\comfydeck.ico"),
    "--add-data", "$(Join-Path $root 'web');web",
    "--collect-all", "uvicorn",
    "--collect-submodules", "comfydeck",
    "--hidden-import", "psutil",
    "--distpath", $distRoot,
    "--workpath", $workRoot,
    "--specpath", $workRoot,
    (Join-Path $root "comfydeck_entry.py")
)
& $buildPython @pyInstallerArgs
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 打包失败。" }

$appDir = Join-Path $distRoot "ComfyDeck"
if (-not (Test-Path -LiteralPath (Join-Path $appDir "ComfyDeck.exe"))) {
    throw "没有生成 dist\ComfyDeck\ComfyDeck.exe"
}

# ------------------------------------------------------------------- portable zip
Write-Step "生成便携版"
$portableDir = Join-Path $releaseDir "ComfyDeck-$Version-portable-win64"
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path $appDir "*") -Destination $portableDir

$portableReadme = @"
ComfyDeck $Version 便携版
========================

1. 双击 ComfyDeck.exe 启动，浏览器会自动打开 http://127.0.0.1:8288
2. 首次启动会尝试自动查找 ComfyUI；找不到时到“设置 > 安装位置”手动选择：
   - ComfyUI 目录（必须包含 main.py）
   - Python 解释器（通常是 ComfyUI 目录上一层的 python_embeded\python.exe）
3. 所有设置与缓存保存在本目录下的 data 文件夹，整个文件夹可以随时移动。
4. 退出：设置页最下方的“退出 ComfyDeck”。

ComfyUI 本身不会被停止；关闭 ComfyDeck 只停止管理面板。
"@
Set-Content -LiteralPath (Join-Path $portableDir "使用说明.txt") -Value $portableReadme -Encoding UTF8

$launcher = "@echo off`r`ncd /d `"%~dp0`"`r`nstart `"`" `"ComfyDeck.exe`"`r`n"
Set-Content -LiteralPath (Join-Path $portableDir "ComfyDeck.bat") -Value $launcher -Encoding ASCII

$zipPath = Join-Path $releaseDir "ComfyDeck-$Version-portable-win64.zip"
Compress-Archive -Path $portableDir -DestinationPath $zipPath -CompressionLevel Optimal -Force
Write-Host "便携版: $zipPath"

# ---------------------------------------------------------------------- installer
if (-not $SkipInstaller) {
    Write-Step "生成安装包"
    $iscc = Find-Iscc
    if (-not $iscc -and -not $SkipToolInstall) {
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
            Write-Host "通过 winget 安装 Inno Setup 6 ..."
            & $winget.Source install --id JRSoftware.InnoSetup --exact --silent --accept-package-agreements --accept-source-agreements
        }
        $iscc = Find-Iscc
    }
    if (-not $iscc -and -not $SkipToolInstall) {
        $choco = Get-Command choco -ErrorAction SilentlyContinue
        if ($choco) {
            Write-Host "通过 Chocolatey 安装 Inno Setup 6 ..."
            & $choco.Source install innosetup -y --no-progress
        }
        $iscc = Find-Iscc
    }
    if (-not $iscc) {
        throw "没有找到 ISCC.exe。请安装 Inno Setup 6，或使用 -SkipInstaller 仅生成便携版。"
    }
    & $iscc "/DVersion=$Version" (Join-Path $root "installer\comfydeck.iss")
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup 编译失败。" }
    $setup = Join-Path $root "installer\Output\ComfyDeck-$Version-setup.exe"
    if (-not (Test-Path -LiteralPath $setup)) { throw "没有生成安装包：$setup" }
    Copy-Item -Force -LiteralPath $setup -Destination $releaseDir
    Write-Host "安装包: $(Join-Path $releaseDir (Split-Path -Leaf $setup))"
}

# ------------------------------------------------------------------------ summary
Write-Step "生成校验文件"
$assets = Get-ChildItem -LiteralPath $releaseDir -File | Where-Object { $_.Name -ne "SHA256SUMS.txt" }
$lines = foreach ($asset in $assets) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $asset.FullName).Hash.ToLowerInvariant()
    "$hash  $($asset.Name)"
}
Set-Content -LiteralPath (Join-Path $releaseDir "SHA256SUMS.txt") -Value $lines -Encoding ASCII

Write-Host ""
Write-Host "构建完成，发布文件位于：" -ForegroundColor Green
Get-ChildItem -LiteralPath $releaseDir -File | ForEach-Object {
    Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
}
