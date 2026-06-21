# profit-bridge.ps1
# Le dados RTD do Profit via Excel e salva em data/rtd-cache.json
# Requer: Excel aberto com rtd.xlsx conectado ao Profit

param(
    [string]$ExcelFile = "rtd.xlsx",
    [string]$OutputDir = "$PSScriptRoot\..\data",
    [int]$RetryCount  = 5,   # tentativas por linha quando valores vierem zerados
    [int]$RetryDelay  = 4    # segundos entre tentativas
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
# M=13 Variacao % (retornada pelo Profit ja em percentual, ex: -0.53 para -0.53%)
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

# Lê uma linha do Excel com retry até que OHLC não tenha zeros suspeitos.
# O RTD pode popular com atraso — valores zerados indicam dados ainda não recebidos.
function Read-RowWithRetry {
    param($ws, [int]$row, [string]$key, [int]$maxAttempts, [int]$delaySec)

    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $close     = ToNum $ws.Cells.Item($row, 7).Value2
        $open      = ToNum $ws.Cells.Item($row, 8).Value2
        $high      = ToNum $ws.Cells.Item($row, 9).Value2
        $low       = ToNum $ws.Cells.Item($row, 10).Value2
        $prevClose = ToNum $ws.Cells.Item($row, 11).Value2
        $varPct    = ToNum $ws.Cells.Item($row, 13).Value2
        $varPts    = ToNum $ws.Cells.Item($row, 14).Value2
        $volume    = ToNum $ws.Cells.Item($row, 17).Value2
        $rsiRaw    = ToNum $ws.Cells.Item($row, 30).Value2
        $histVol   = ToNum $ws.Cells.Item($row, 32).Value2
        $date      = "$($ws.Cells.Item($row, 5).Value2)"
        $time      = "$($ws.Cells.Item($row, 6).Value2)"

        # RTD ainda populando: qualquer campo OHLC zerado ou nulo é sinal de dado inválido
        $ohlcZerado = ($null -eq $close -or $close -eq 0) -or
                      ($null -eq $open  -or $open  -eq 0) -or
                      ($null -eq $high  -or $high  -eq 0) -or
                      ($null -eq $low   -or $low   -eq 0)

        if (-not $ohlcZerado) {
            # Dados válidos — retorna
            $rsi = if ($null -ne $rsiRaw -and $rsiRaw -ge 0 -and $rsiRaw -le 100) { $rsiRaw } else { $null }

            # Recalcula var_pct localmente se o Profit não forneceu, para garantir consistência
            # Profit devolve var_pct ja em percentual (ex: -0.53 = -0.53%). Se vier nulo, calcula.
            if ($null -eq $varPct -and $null -ne $prevClose -and $prevClose -ne 0) {
                $varPct = (($close - $prevClose) / $prevClose) * 100
            }

            return @{
                close      = $close
                open       = $open
                high       = $high
                low        = $low
                prev_close = $prevClose
                var_pct    = $varPct
                var_pts    = $varPts
                volume     = $volume
                rsi        = $rsi
                hist_vol   = $histVol
                date       = $date
                time       = $time
            }
        }

        if ($attempt -lt $maxAttempts) {
            Log "AVISO: ${key} com OHLC zerado (tentativa $attempt/$maxAttempts) — aguardando ${delaySec}s para RTD popular..."
            Start-Sleep -Seconds $delaySec
        } else {
            Log "AVISO: ${key} ainda com OHLC zerado apos $maxAttempts tentativas. Descartando linha."
        }
    }

    return $null
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

        $data = Read-RowWithRetry -ws $ws -row $row -key $key -maxAttempts $RetryCount -delaySec $RetryDelay
        if ($null -eq $data) { continue }

        $result[$key] = @{
            nome       = "$nome"
            open       = $data.open
            high       = $data.high
            low        = $data.low
            close      = $data.close
            prev_close = $data.prev_close
            var_pct    = $data.var_pct
            var_pts    = $data.var_pts
            volume     = $data.volume
            rsi        = $data.rsi
            hist_vol   = $data.hist_vol
            date       = $data.date
            time       = $data.time
            ts         = (Get-Date -Format "o")
        }

        $varStr = if ($null -ne $data.var_pct) { "$([math]::Round($data.var_pct, 2))%" } else { "n/d" }
        $rsiStr = if ($null -ne $data.rsi) { "RSI=$([math]::Round($data.rsi, 1))" } else { "" }
        Log "${key} ($nome): C=$($data.close) Ant=$($data.prev_close) Var=$varStr $rsiStr"
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
