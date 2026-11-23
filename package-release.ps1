param([string]$OutputDirectory = 'artifacts')
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    & git diff --quiet HEAD --
    if ($LASTEXITCODE -ne 0) { throw 'Commit the reviewed source changes before packaging.' }
    $version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
    if ($version -notmatch '^\d+\.\d+\.\d+-codex\.\d+$') { throw 'Unexpected release version.' }
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    $archive = Join-Path $OutputDirectory "lark-cli-bridge-$version.zip"
    & git archive --format=zip --prefix=lark-cli-bridge/ "--output=$archive" HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Git archive failed.' }
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($archive))" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
    Write-Output "Packaged $archive"
    Write-Output "SHA256 $hash"
} finally {
    Pop-Location
}
