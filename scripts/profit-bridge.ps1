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

function Get-AssetKey {
    param([string]$nome)
    if ($nome -eq "IBOV")    { return "IBOV" }
    if ($nome -like "WIN*")  { return "WIN" }
    if ($nome -like "WDO*")  { return "WDO" }
    return $null
}

function Log {
    param([string]$msg)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $msg"
}

Log "Conectando ao Excel..."

$excel  = $null
$opened = $false

try {
    # Tenta conectar ao Excel ja aberto
    try {
        $excel = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
        Log "Excel ja esta aberto."
    } catch {
        Log "Abrindo Excel..."
        $excel  = New-Object -ComObject Excel.Application
        $excel.Visible = $true
        $opened = $true
    }

    # Localiza a pasta de trabalho RTD
    $wb = $null
    foreach ($w in $excel.Workbooks) {
        if ($w.Name -like "*rtd*") {
            $wb = $w
            break
        }
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

    # Le linhas 2 a 4 (dados dos ativos)
    $result = @{}

    for ($row = 2; $row -le 4; $row++) {
        $nome = $ws.Cells.Item($row, 4).Value2
        if (-not $nome) { continue }

        $key = Get-AssetKey $nome
        if (-not $key) { continue }

        $close = $ws.Cells.Item($row, 7).Value2
        $open  = $ws.Cells.Item($row, 8).Value2
        $high  = $ws.Cells.Item($row, 9).Value2
        $low   = $ws.Cells.Item($row, 10).Value2
        $date  = $ws.Cells.Item($row, 5).Value2
        $time  = $ws.Cells.Item($row, 6).Value2

        if (-not $close) {
            Log "AVISO: $nome sem dados. Profit conectado?"
            continue
        }

        $result[$key] = @{
            nome  = "$nome"
            open  = [double]$open
            high  = [double]$high
            low   = [double]$low
            close = [double]$close
            date  = "$date"
            time  = "$time"
            ts    = (Get-Date -Format "o")
        }

        Log "${key} (${nome}): O=$open H=$high L=$low C=$close"
    }

    if ($result.Count -eq 0) {
        throw "Nenhum dado lido. Verifique se o Profit esta conectado e o RTD ativo no Excel."
    }

    # Salva JSON sem BOM (PowerShell 5.1 adiciona BOM com Out-File -Encoding utf8)
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $json = $result | ConvertTo-Json -Depth 3
    [System.IO.File]::WriteAllText($OutputPath, $json, [System.Text.UTF8Encoding]::new($false))
    Log "Salvo em $OutputPath"

} catch {
    Write-Host "ERRO: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($opened -and $wb) {
        $wb.Close($false)
    }
    if ($opened -and $excel) {
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
    }
}
