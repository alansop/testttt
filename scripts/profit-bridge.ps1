# profit-bridge.ps1
# Le as celulas RTD do Excel (Profit) e salva em data/rtd-cache.json
# Requer: Excel aberto com rtd.xlsx conectado ao Profit

param(
    [string]$ExcelFile = "rtd.xlsx",
    [string]$OutputDir = "$PSScriptRoot\..\data"
)

$OutputPath = Join-Path $OutputDir "rtd-cache.json"
$RootDir    = Resolve-Path "$PSScriptRoot\.."
$FullExcel  = Join-Path $RootDir $ExcelFile

# Mapeamento: nome do ativo na coluna D -> chave interna
$assetMap = @{
    "IBOV" = "IBOV"
}
# WIN e WDO tem vencimento no nome (ex: WINM26, WDOM26) — mapeamos por prefixo

function Get-AssetKey($nome) {
    if ($nome -eq "IBOV") { return "IBOV" }
    if ($nome -like "WIN*") { return "WIN" }
    if ($nome -like "WDO*") { return "WDO" }
    return $null
}

Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Conectando ao Excel..."

$excel = $null
$opened = $false

try {
    # Tenta conectar a instancia do Excel ja aberta
    try {
        $excel = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Excel ja esta aberto."
    } catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Abrindo Excel..."
        $excel = New-Object -ComObject Excel.Application
        $excel.Visible = $true
        $opened = $true
    }

    # Localiza a pasta de trabalho RTD
    $wb = $null
    foreach ($w in $excel.Workbooks) {
        if ($w.Name -like "*rtd*") { $wb = $w; break }
    }

    if (-not $wb) {
        if (-not (Test-Path $FullExcel)) {
            throw "Arquivo nao encontrado: $FullExcel"
        }
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Abrindo $ExcelFile..."
        $wb = $excel.Workbooks.Open($FullExcel)
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Aguardando RTD popular (10s)..."
        Start-Sleep -Seconds 10
    }

    $ws = $wb.Sheets.Item(1)

    # Le linhas 2-4 (dados dos ativos)
    $result = @{}
    for ($row = 2; $row -le 4; $row++) {
        $nome = $ws.Cells.Item($row, 4).Value2  # Coluna D
        if (-not $nome) { continue }

        $key = Get-AssetKey $nome
        if (-not $key) { continue }

        $close = $ws.Cells.Item($row, 7).Value2   # G = ULT
        $open  = $ws.Cells.Item($row, 8).Value2   # H = ABE
        $high  = $ws.Cells.Item($row, 9).Value2   # I = MAX
        $low   = $ws.Cells.Item($row, 10).Value2  # J = MIN
        $date  = $ws.Cells.Item($row, 5).Value2   # E = DAT
        $time  = $ws.Cells.Item($row, 6).Value2   # F = HOR

        if (-not $close) {
            Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $nome sem dados — Profit conectado?"
            continue
        }

        $result[$key] = @{
            nome  = $nome
            open  = [double]$open
            high  = [double]$high
            low   = [double]$low
            close = [double]$close
            date  = "$date"
            time  = "$time"
            ts    = (Get-Date -Format "o")
        }

        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $key ($nome): O=$open H=$high L=$low C=$close"
    }

    if ($result.Count -eq 0) {
        throw "Nenhum dado lido. Verifique se o Profit esta conectado e o Excel com RTD ativo."
    }

    # Salva JSON
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $result | ConvertTo-Json -Depth 3 | Out-File -FilePath $OutputPath -Encoding utf8
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Salvo em $OutputPath"

} catch {
    Write-Error "Erro: $_"
    exit 1
} finally {
    if ($opened -and $wb) { $wb.Close($false) }
    if ($opened -and $excel) { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null }
}
