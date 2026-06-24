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

# Normaliza um cabeçalho para casamento robusto: tira acentos, espaços extras,
# e deixa minúsculo. Assim "Máximo", "Variação", "Mês" casam mesmo com acentuação.
function Norm {
    param($s)
    if ($null -eq $s) { return "" }
    $t = "$s".Trim().ToLowerInvariant().Normalize([Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $t.ToCharArray()) {
        if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch) -ne [Globalization.UnicodeCategory]::NonSpacingMark) {
            [void]$sb.Append($ch)
        }
    }
    return ($sb.ToString() -replace '\s+', ' ').Trim()
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

$ws = $wb.Sheets.Item(1)

# Mapeia cabeçalho normalizado -> número da coluna (1ª ocorrência). Isso torna a
# leitura imune a inserção/remoção/reordenação de colunas: buscamos pelo NOME, não
# pela posição fixa. Há blocos de colunas repetidos na planilha (ex.: "Semana"
# aparece mais de uma vez); ficamos com a primeira ocorrência.
$colCount = $ws.UsedRange.Columns.Count
$colMap = @{}
for ($c = 1; $c -le $colCount; $c++) {
    $name = Norm $ws.Cells.Item(1, $c).Value2
    if ($name -ne "" -and -not $colMap.ContainsKey($name)) { $colMap[$name] = $c }
}

# Lê um campo numérico da linha pelo nome do cabeçalho (aceita alternativas).
function CellNum {
    param([int]$row, [string[]]$nomes)
    foreach ($n in $nomes) {
        $key = Norm $n
        if ($colMap.ContainsKey($key)) { return ToNum $ws.Cells.Item($row, $colMap[$key]).Value2 }
    }
    return $null
}
function CellText {
    param([int]$row, [string[]]$nomes)
    foreach ($n in $nomes) {
        $key = Norm $n
        if ($colMap.ContainsKey($key)) { return "$($ws.Cells.Item($row, $colMap[$key]).Value2)" }
    }
    return ""
}

$colAsset = if ($colMap.ContainsKey("asset")) { $colMap["asset"] } else { 1 }
$front = @{}
$perp  = @{}

for ($row = 2; $row -le 20; $row++) {
    $asset = $ws.Cells.Item($row, $colAsset).Value2
    if (-not $asset) { continue }

    $key = Get-AssetKey $asset
    if (-not $key) { continue }

    $close      = CellNum $row @("Ultimo", "Último")
    $open       = CellNum $row @("Abertura")
    $high       = CellNum $row @("Maximo", "Máximo")
    $low        = CellNum $row @("Minimo", "Mínimo")
    $prevClose  = CellNum $row @("Fechamento Anterior")
    $varPct     = CellNum $row @("Variacao", "Variação")
    $volume     = CellNum $row @("Volume")
    $varSemana  = CellNum $row @("Semana")
    $varMes     = CellNum $row @("Mes", "Mês")
    $var3m      = CellNum $row @("3 meses")
    $var6m      = CellNum $row @("6 meses")
    $var12m     = CellNum $row @("12 meses")
    $varAno     = CellNum $row @("Ano")
    $varTri     = CellNum $row @("Trimestre")
    $varSem     = CellNum $row @("Semestre")
    $rsiRaw     = CellNum $row @("IFR (RSI)", "IFR", "RSI")
    $histVolRaw = CellNum $row @("Volatilidade Historica Media", "Volatilidade Histórica Média")
    $date       = CellText $row @("Data")
    $time       = CellText $row @("Hora")

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
