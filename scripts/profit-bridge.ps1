# profit-bridge.ps1
# Le dados RTD do Profit via Excel e salva em data/rtd-cache.json
# Requer: Excel aberto com rtd.xlsx conectado ao Profit

param(
    [string]$ExcelFile = "rtd.xlsx",
    [string]$OutputDir = "$PSScriptRoot\..\data"
)

$OutputPath = Join-Path $OutputDir "rtd-cache.json"
$RootDir    = Resolve-Path "$PSScriptRoot\.."
$FullExcel  = Join-Path $RootDir $ExcelFile

# Colunas (base 1, iniciando em D=4):
# D=4  Asset
# E=5  Data
# F=6  Hora
# G=7  Ultimo (close)
# H=8  Abertura (open)
# I=9  Maximo (high)
# J=10 Minimo (low)
# K=11 Fechamento Anterior (prev_close)
# L=12 Strike
# M=13 Variacao %
# N=14 Variacao pts
# O=15 Nome do Ativo
# P=16 Negocios
# Q=17 Volume
# AD=30 IFR (RSI)
# AF=32 Volatilidade Historica Media

function Get-AssetKey {
    param([string]$nome)
    if ($nome -eq "IBOV")   { return "IBOV" }
    if ($nome -like "WIN*") { return "WIN" }
    if ($nome -like "WDO*") { return "WDO" }
    return $null
}

function ToNum {
    param($v)
    if ($null -eq $v -or $v -eq "") { return $null }
    try { return [double]$v } catch { return $null }
}

function Log {
    param([string]$msg)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $msg"
}

Log "Conectando ao Excel..."
$excel  = $null
$opened = $false

try {
    try {
        $excel = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
        Log "Excel ja esta aberto."
    } catch {
        Log "Abrindo Excel..."
        $excel  = New-Object -ComObject Excel.Application
        $excel.Visible = $true
        $opened = $true
    }

    $wb = $null
    foreach ($w in $excel.Workbooks) {
        if ($w.Name -like "*rtd*") { $wb = $w; break }
    }

    if (-not $wb) {
        if (-not (Test-Path $FullExcel)) {
            throw "Arquivo nao encontrado: $FullExcel"
        }
        Log "Abrindo $ExcelFile..."
        $wb = $excel.Workbooks.Open($FullExcel)
        Log "Aguardando RTD popular (10s)..."
        Start-Sleep -Seconds 10
    }

    $ws = $wb.Sheets.Item(1)
    $result = @{}

    for ($row = 2; $row -le 10; $row++) {
        $nome = $ws.Cells.Item($row, 4).Value2
        if (-not $nome) { continue }

        $key = Get-AssetKey $nome
        if (-not $key) { continue }

        $close     = ToNum $ws.Cells.Item($row, 7).Value2
        $open      = ToNum $ws.Cells.Item($row, 8).Value2
        $high      = ToNum $ws.Cells.Item($row, 9).Value2
        $low       = ToNum $ws.Cells.Item($row, 10).Value2
        $prevClose = ToNum $ws.Cells.Item($row, 11).Value2
        $varPct    = ToNum $ws.Cells.Item($row, 13).Value2
        $varPts    = ToNum $ws.Cells.Item($row, 14).Value2
        $volume    = ToNum $ws.Cells.Item($row, 17).Value2
        $rsiRaw    = ToNum $ws.Cells.Item($row, 30).Value2
        $rsi       = if ($null -ne $rsiRaw -and $rsiRaw -ge 0 -and $rsiRaw -le 100) { $rsiRaw } else { $null }
        $histVol   = ToNum $ws.Cells.Item($row, 32).Value2
        $date      = "$($ws.Cells.Item($row, 5).Value2)"
        $time      = "$($ws.Cells.Item($row, 6).Value2)"

        if ($null -eq $close) {
            Log "AVISO: $nome sem dados. Profit conectado?"
            continue
        }

        $result[$key] = @{
            nome       = "$nome"
            open       = $open
            high       = $high
            low        = $low
            close      = $close
            prev_close = $prevClose
            var_pct    = $varPct
            var_pts    = $varPts
            volume     = $volume
            rsi        = $rsi
            hist_vol   = $histVol
            date       = $date
            time       = $time
            ts         = (Get-Date -Format "o")
        }

        $varStr = if ($null -ne $varPct) { "$([math]::Round($varPct,2))%" } else { "n/d" }
        $rsiStr = if ($null -ne $rsi) { "RSI=$([math]::Round($rsi,1))" } else { "" }
        Log "${key} (${nome}): C=$close Ant=$prevClose Var=$varStr $rsiStr"
    }

    if ($result.Count -eq 0) {
        throw "Nenhum dado lido. Verifique se o Profit esta conectado e o RTD ativo no Excel."
    }

    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $json = $result | ConvertTo-Json -Depth 3
    [System.IO.File]::WriteAllText($OutputPath, $json, [System.Text.UTF8Encoding]::new($false))
    Log "Salvo em $OutputPath"

} catch {
    Write-Host "ERRO: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($opened -and $wb) { $wb.Close($false) }
    if ($opened -and $excel) {
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
    }
}
