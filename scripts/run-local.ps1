# run-local.ps1
# Pipeline completo: Profit RTD -> analise -> GitHub Pages (gh-pages branch)
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

# 3. Publica no gh-pages
Log "Publicando no GitHub Pages (gh-pages)..."

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm UTC"
$pubDir    = Join-Path $Root "public"
$tmpBranch = "gh-pages"

# Guarda os HTMLs gerados temporariamente
$tmpDir = Join-Path $env:TEMP "analise-pages-$([System.IO.Path]::GetRandomFileName())"
Copy-Item -Recurse -Force $pubDir $tmpDir

# Troca para o branch gh-pages (cria se nao existir)
$ghExists = git ls-remote --heads origin $tmpBranch 2>&1
if ($ghExists -match $tmpBranch) {
    git fetch origin $tmpBranch 2>&1 | Out-Null
    git checkout $tmpBranch 2>&1 | Out-Null
    git pull origin $tmpBranch 2>&1 | Out-Null
} else {
    git checkout --orphan $tmpBranch 2>&1 | Out-Null
    git rm -rf . 2>&1 | Out-Null
}

# Copia HTMLs para a raiz do branch
Copy-Item -Force "$tmpDir\public\*" $Root
Remove-Item -Recurse -Force $tmpDir

git config user.name "Alan Soares"
git config user.email "alaansop@gmail.com"
git add *.html index.html 2>&1 | Out-Null
git add . 2>&1 | Out-Null
git diff --staged --quiet
if ($LASTEXITCODE -ne 0) {
    git commit -m "chore: analise $timestamp"
    git push origin $tmpBranch
    Log "Publicado em gh-pages."
} else {
    Log "Sem mudancas para publicar."
}

# Volta para main
git checkout main 2>&1 | Out-Null

Log "=== Concluido ==="
