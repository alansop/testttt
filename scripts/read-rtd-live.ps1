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

# Contratos futuros (WINQ26, WDON26 etc.) vencem e rolam a cada poucos meses, então
# colunas de retorno em prazos longos (6m/12m/Trimestre/Semestre/Ano) ficam truncadas
# ou repetidas para eles. Os contratos perpétuos (WINFUT, WDOFUT) têm série contínua
# e fornecem esses retornos de forma confiável — usamos o contrato corrente para
# preço/OHLC do dia e o perpétuo só para os retornos de prazo mais longo.
function Test-IsPerpetuo {
    param([string]$nome)
    return "$nome".ToUpper() -match "FUT$"
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
# I=9 Variacao%(var_pct), L=12 Volume, P=16 Semana, Q=17 Mes, R=18 TresMeses,
# S=19 SeisMeses, T=20 DozeMeses, U=21 Ano, V=22 Trimestre, W=23 Semestre,
# AA=27 IFR(RSI), AC=29 VolatilidadeHistoricaMedia
$ws = $wb.Sheets.Item(1)
$front = @{}
$perp  = @{}

for ($row = 2; $row -le 20; $row++) {
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
    $varSemana  = ToNum $ws.Cells.Item($row, 16).Value2
    $varMes     = ToNum $ws.Cells.Item($row, 17).Value2
    $var3m      = ToNum $ws.Cells.Item($row, 18).Value2
    $var6m      = ToNum $ws.Cells.Item($row, 19).Value2
    $var12m     = ToNum $ws.Cells.Item($row, 20).Value2
    $varAno     = ToNum $ws.Cells.Item($row, 21).Value2
    $varTri     = ToNum $ws.Cells.Item($row, 22).Value2
    $varSem     = ToNum $ws.Cells.Item($row, 23).Value2
    $rsiRaw     = ToNum $ws.Cells.Item($row, 27).Value2
    $histVolRaw = ToNum $ws.Cells.Item($row, 29).Value2
    $date       = "$($ws.Cells.Item($row, 2).Value2)"
    $time       = "$($ws.Cells.Item($row, 3).Value2)"

    $isPerp = Test-IsPerpetuo $asset

    if ($isPerp) {
        # Linha do contrato perpétuo: só nos interessam os retornos de prazo longo,
        # não exige OHLC válido (não é usado para preço).
        $perp[$key] = @{
            var_semana = $varSemana
            var_mes    = $varMes
            var_3m     = $var3m
            var_6m     = $var6m
            var_12m    = $var12m
            var_ano    = $varAno
            var_tri    = $varTri
            var_sem    = $varSem
        }
        continue
    }

    if ($null -eq $close -or $close -eq 0 -or $null -eq $open -or $open -eq 0 -or
        $null -eq $high  -or $high  -eq 0 -or $null -eq $low  -or $low  -eq 0) {
        continue
    }

    if ($null -eq $varPct -and $null -ne $prevClose -and $prevClose -ne 0) {
        $varPct = (($close - $prevClose) / $prevClose) * 100
    }

    $rsi = if ($null -ne $rsiRaw -and $rsiRaw -ge 0 -and $rsiRaw -le 100) { $rsiRaw } else { $null }
    $histVol = $histVolRaw

    $front[$key] = @{
        nome       = "$asset"
        close      = $close
        open       = $open
        high       = $high
        low        = $low
        prev_close = $prevClose
        var_pct    = $varPct
        volume     = $volume
        var_semana = $varSemana
        var_mes    = $varMes
        var_3m     = $var3m
        var_6m     = $var6m
        var_12m    = $var12m
        var_ano    = $varAno
        var_tri    = $varTri
        var_sem    = $varSem
        rsi        = $rsi
        hist_vol   = $histVol
        date       = $date
        time       = $time
        ts         = (Get-Date -Format "o")
    }
}

if ($front.Count -eq 0) {
    Write-Error "Nenhum dado válido lido do Excel."
    exit 1
}

# Para ativos com contrato perpétuo disponível (WIN/WDO), sobrepõe os retornos de
# prazo longo (mais confiáveis no perpétuo) sobre os dados de preço do contrato corrente.
$result = @{}
foreach ($key in $front.Keys) {
    $data = $front[$key]
    if ($perp.ContainsKey($key)) {
        $p = $perp[$key]
        $data.var_semana = $p.var_semana
        $data.var_mes    = $p.var_mes
        $data.var_3m     = $p.var_3m
        $data.var_6m     = $p.var_6m
        $data.var_12m    = $p.var_12m
        $data.var_ano    = $p.var_ano
        $data.var_tri    = $p.var_tri
        $data.var_sem    = $p.var_sem
    }
    $result[$key] = $data
}

$result | ConvertTo-Json -Depth 3
