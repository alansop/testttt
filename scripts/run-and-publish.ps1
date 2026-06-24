# run-and-publish.ps1
# Gera as paginas (lendo RTD do Excel/Profit aberto) e publica no GitHub
# se houver mudanca em public/*.html. Pensado para rodar via Task Scheduler.
#
# Pre-requisito: Excel aberto com rtd.xlsx e RTD do Profit conectado.

$RootDir = Resolve-Path "$PSScriptRoot\.."
Set-Location $RootDir

$LogDir = Join-Path $RootDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "run-and-publish.log"

function Log {
    param([string]$msg)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

Log "Iniciando geracao e publicacao"

npm run generate 2>&1 | ForEach-Object { Log $_ }
Log "npm run generate finalizado"

$changes = git status --porcelain public
if (-not $changes) {
    Log "Nenhuma mudanca em public/ - nada para publicar."
    exit 0
}

git add public
$commitMsg = "auto: atualizacao RTD $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
git commit -m $commitMsg | Out-String | ForEach-Object { Log $_ }
git push origin main 2>&1 | ForEach-Object { Log $_ }

if ($LASTEXITCODE -ne 0) {
    Log "ERRO: git push falhou."
    exit 1
}

Log "Publicado com sucesso"
