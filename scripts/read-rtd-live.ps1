# read-rtd-live.ps1
# Lê os dados RTD direto da instância do Excel já aberta (sem precisar salvar o arquivo)
# e imprime um JSON no stdout no mesmo formato usado por src/lib/analysis.mjs.
# Não abre nem salva o Excel — só lê o que já está em memória via RTD/Profit.
# Se o Excel não estiver aberto ou a planilha rtd.xlsx não estiver carregada, sai com erro.

param(
    [string]$WorkbookNameLike = "*rtd*"
)

function Get-AssetKey {
    param([string]$nome)
    $n = "$nome".ToUpper()
    if ($n -eq "IBOV")   { return "IBOV" }
    if ($n -like "WIN*") { return "WIN" }
    if ($n -like "WDO*") { return "WDO" }
    return $null
}

function ToNum {
    param($v)
    if ($null -eq $v -or $v -eq "") { return $null }
    try { return [double]$v } catch { return $null }
}

$excel = $null
try {
    $excel = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")
} catch {
    Write-Error "Excel não está aberto."
    exit 1
}

$wb = $null
foreach ($w in $excel.Workbooks) {
    if ($w.Name -like $WorkbookNameLike) { $wb = $w; break }
}
if (-not $wb) {
    Write-Error "Nenhum workbook aberto com nome semelhante a '$WorkbookNameLike'."
    exit 1
}

# Colunas (base 1):
# A=1 Asset, B=2 Data, C=3 Hora, D=4 Ultimo(close), E=5 Abertura(open),
# F=6 Maximo(high), G=7 Minimo(low), H=8 FechamentoAnterior(prev_close),
# I=9 Variacao%(var_pct), L=12 Volume, AA=27 IFR(RSI), AC=29 VolatilidadeHistoricaMedia
$ws = $wb.Sheets.Item(1)
$result = @{}

for ($row = 2; $row -le 10; $row++) {
    $asset = $ws.Cells.Item($row, 1).Value2
    if (-not $asset) { continue }

    $key = Get-AssetKey $asset
    if (-not $key) { continue }

    $close      = ToNum $ws.Cells.Item($row, 4).Value2
    $open       = ToNum $ws.Cells.Item($row, 5).Value2
    $high       = ToNum $ws.Cells.Item($row, 6).Value2
    $low        = ToNum $ws.Cells.Item($row, 7).Value2
    $prevClose  = ToNum $ws.Cells.Item($row, 8).Value2
    $varPct     = ToNum $ws.Cells.Item($row, 9).Value2
    $volume     = ToNum $ws.Cells.Item($row, 12).Value2
    $rsiRaw     = ToNum $ws.Cells.Item($row, 27).Value2
    $histVolRaw = ToNum $ws.Cells.Item($row, 29).Value2
    $date       = "$($ws.Cells.Item($row, 2).Value2)"
    $time       = "$($ws.Cells.Item($row, 3).Value2)"

    if ($null -eq $close -or $close -eq 0 -or $null -eq $open -or $open -eq 0 -or
        $null -eq $high  -or $high  -eq 0 -or $null -eq $low  -or $low  -eq 0) {
        continue
    }

    if ($null -eq $varPct -and $null -ne $prevClose -and $prevClose -ne 0) {
        $varPct = (($close - $prevClose) / $prevClose) * 100
    }

    $rsi = if ($null -ne $rsiRaw -and $rsiRaw -ge 0 -and $rsiRaw -le 100) { $rsiRaw } else { $null }
    $histVol = $histVolRaw

    $result[$key] = @{
        nome       = "$asset"
        close      = $close
        open       = $open
        high       = $high
        low        = $low
        prev_close = $prevClose
        var_pct    = $varPct
        volume     = $volume
        rsi        = $rsi
        hist_vol   = $histVol
        date       = $date
        time       = $time
        ts         = (Get-Date -Format "o")
    }
}

if ($result.Count -eq 0) {
    Write-Error "Nenhum dado válido lido do Excel."
    exit 1
}

$result | ConvertTo-Json -Depth 3
