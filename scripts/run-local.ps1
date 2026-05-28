# run-local.ps1
# Pipeline completo: Profit RTD -> analise -> GitHub Pages
# Agende no Task Scheduler a cada 15min durante o pregao

$Root = Resolve-Path "$PSScriptRoot\.."
Set-Location $Root

function Log {
    param([string]$msg)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $msg"
}

Log "=== Pipeline Analise Tecnica ==="

# 1. Le RTD do Profit
Log "Lendo dados do Profit..."
& "$PSScriptRoot\profit-bridge.ps1"
if ($LASTEXITCODE -ne 0) {
    Log "AVISO: Profit indisponivel. Usando Yahoo Finance como fallback."
}

# 2. Gera HTMLs
Log "Gerando analises..."
npm run generate
if ($LASTEXITCODE -ne 0) {
    Log "ERRO na geracao. Abortando."
    exit 1
}

# 3. Commit e push
Log "Publicando no GitHub..."
git add public/
git diff --staged --quiet
if ($LASTEXITCODE -ne 0) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm UTC"
    git commit -m "chore: analise $timestamp"
    git push origin main
    Log "Publicado com sucesso."
} else {
    Log "Sem mudancas para publicar."
}

Log "=== Concluido ==="
