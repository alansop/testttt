// Lógica compartilhada entre o cron (src/generate.mjs) e o bot (api/telegram.js).
// Compatível com Node 20+ e com o runtime Edge da Vercel — usa apenas fetch e string ops.

import {
  SYSTEM_PROMPT,
  USER_PROMPT_TEMPLATE,
  AUDIO_SYSTEM_PROMPT,
  AUDIO_USER_PROMPT_TEMPLATE,
  DUAL_SYSTEM_PROMPT,
  DUAL_USER_PROMPT_TEMPLATE,
  DUAL_TRADER_MARK,
  DUAL_TECNICA_MARK,
  DUAL_CLOSING,
} from "./prompts.mjs";

// Garante a frase de encerramento obrigatória ("regra de ouro") ao fim de cada versão,
// anexando-a caso o LLM tenha esquecido — sem duplicar se já estiver presente.
function ensureClosing(texto) {
  const t = texto.trim();
  if (t.endsWith(DUAL_CLOSING)) return t;
  const sep = /[.!?]$/.test(t) ? " " : ". ";
  return `${t}${sep}${DUAL_CLOSING}`;
}

// Separa a saída de dupla versão do LLM (Versão Trader + Versão Técnica) em campos.
// Retorna { trader, tecnica } ou null se os marcadores não forem encontrados.
export function parseDualVersions(text) {
  if (!text) return null;
  const t = String(text);
  const ti = t.indexOf(DUAL_TRADER_MARK);
  const ci = t.indexOf(DUAL_TECNICA_MARK);
  if (ti === -1 || ci === -1 || ci < ti) return null;
  const trader = t.slice(ti + DUAL_TRADER_MARK.length, ci).trim();
  const tecnica = t.slice(ci + DUAL_TECNICA_MARK.length).trim();
  if (!trader || !tecnica) return null;
  return { trader: ensureClosing(trader), tecnica: ensureClosing(tecnica) };
}

function rtdAssetKeyFromName(nome) {
  const n = String(nome || "").toUpperCase();
  if (n === "IBOV") return "IBOV";
  if (n.startsWith("WIN")) return "WIN";
  if (n.startsWith("WDO")) return "WDO";
  return null;
}

// Lê os dados RTD direto da instância do Excel aberta (COM, só Windows), sem precisar
// salvar o arquivo — evita o delay entre "RTD atualiza a célula" e "alguém salva o .xlsx".
// Resultado é cacheado em memória por processo (1 chamada de PowerShell cobre os 3 ativos).
let liveRtdCache = null;
async function readRtdLive(assetKey) {
  if (process.platform !== "win32") return null;
  try {
    if (!liveRtdCache) {
      const { execFileSync } = await import("node:child_process");
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
      const scriptPath = resolve(root, "scripts/read-rtd-live.ps1");
      const stdout = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { encoding: "utf8", timeout: 15000 }
      );
      liveRtdCache = JSON.parse(stdout);
    }
    return liveRtdCache[assetKey] ?? null;
  } catch {
    liveRtdCache = liveRtdCache || false; // evita tentar de novo nas próximas chamadas do mesmo processo
    return null;
  }
}

// Lê os dados RTD direto da planilha rtd.xlsx salva em disco (fallback quando o Excel
// não está aberto ou não está acessível via COM — ex: ambiente não-Windows).
// Colunas da planilha: A=Asset, B=Data, C=Hora, D=Último(close), E=Abertura(open),
// F=Máximo(high), G=Mínimo(low), H=Fechamento Anterior(prev_close), I=Variação%(var_pct),
// J=Variação(pts), M=Volume, Q=Semana, R=Mês, S=3 meses, T=6 meses, U=12 meses,
// V=Ano, W=Trimestre, X=Semestre, AP=IFR(RSI), AR=Volatilidade Histórica Média.
//
// Contratos futuros (WINQ26, WDON26 etc.) rolam a cada poucos meses, então as colunas
// de retorno em prazos longos (6m/12m/Trimestre/Semestre/Ano) ficam truncadas ou
// duplicadas para eles. Os contratos perpétuos (WINFUT, WDOFUT) têm série contínua e
// fornecem esses retornos de forma confiável — usamos o contrato corrente para
// preço/OHLC do dia e o perpétuo só para os retornos de prazo mais longo.
function isPerpetuo(nome) {
  return /FUT$/i.test(String(nome || "").trim());
}

async function readRtdFromFile(assetKey) {
  try {
    const XLSX = (await import("xlsx")).default;
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { stat } = await import("node:fs/promises");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const xlsxPath = resolve(root, "rtd.xlsx");

    // Rejeita planilha não atualizada há mais de 20 minutos
    const info = await stat(xlsxPath);
    const age = Date.now() - info.mtime.getTime();
    if (age > 20 * 60 * 1000) return null;

    const wb = XLSX.readFile(xlsxPath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
    const numOrNull = (v) => (typeof v === "number" ? v : null);

    // Mapeia cabeçalho normalizado -> índice da coluna (1ª ocorrência), para ler
    // pelo NOME e não pela posição — imune a inserção/remoção/reordenação de colunas.
    const norm = (s) =>
      String(s ?? "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\s+/g, " ");
    const header = rows[0] || [];
    const colMap = new Map();
    header.forEach((h, i) => {
      const n = norm(h);
      if (n && !colMap.has(n)) colMap.set(n, i);
    });
    const at = (row, ...nomes) => {
      for (const nm of nomes) {
        const i = colMap.get(norm(nm));
        if (i != null) return row[i];
      }
      return undefined;
    };

    let front = null;
    let perp = null;

    for (const row of rows.slice(1)) {
      const nome = at(row, "Asset") ?? row[0];
      const key = rtdAssetKeyFromName(nome);
      if (key !== assetKey) continue;

      const periodos = {
        var_semana: numOrNull(at(row, "Semana")),
        var_mes: numOrNull(at(row, "Mes", "Mês")),
        var_3m: numOrNull(at(row, "3 meses")),
        var_6m: numOrNull(at(row, "6 meses")),
        var_12m: numOrNull(at(row, "12 meses")),
        var_ano: numOrNull(at(row, "Ano")),
        var_tri: numOrNull(at(row, "Trimestre")),
        var_sem: numOrNull(at(row, "Semestre")),
      };

      if (isPerpetuo(nome)) {
        if (!perp) perp = periodos;
        continue;
      }

      if (front) continue; // já temos o contrato corrente, ignora linhas extras
      const close = at(row, "Ultimo", "Último");
      const open = at(row, "Abertura");
      const high = at(row, "Maximo", "Máximo");
      const low = at(row, "Minimo", "Mínimo");
      const prevClose = at(row, "Fechamento Anterior");
      const varPct = at(row, "Variacao", "Variação");
      if (!close || !open || !high || !low) continue;
      const rsiRaw = at(row, "IFR (RSI)", "IFR", "RSI");
      const rsi = typeof rsiRaw === "number" && rsiRaw >= 0 && rsiRaw <= 100 ? rsiRaw : null;
      const histVolRaw = at(row, "Volatilidade Historica Media", "Volatilidade Histórica Média");
      const histVol = typeof histVolRaw === "number" ? histVolRaw : null;
      front = {
        close,
        open,
        high,
        low,
        prev_close: prevClose ?? null,
        var_pct: varPct ?? null,
        volume: at(row, "Volume") ?? null,
        ...periodos,
        rsi,
        hist_vol: histVol,
        date: at(row, "Data") ?? null,
        time: at(row, "Hora") ?? null,
        ts: info.mtime.toISOString(),
      };
    }

    if (!front) return null;
    if (perp) Object.assign(front, perp);
    return front;
  } catch {
    return null;
  }
}

// roundStep: incremento dos níveis redondos de suporte/resistência exibidos na página
// quando não há nível específico (índice = 1000; dólar = 10; bitcoin = 10000).
export const ASSETS = {
  IBOV: {
    key: "IBOV",
    nome: "Ibovespa (IBOV)",
    timeframe: "Gráfico Diário (1D)",
    tvSymbol: "BMFBOVESPA:IBOV",
    tvInterval: "D",
    slug: "ibovespa",
    roundStep: 1000,
    wpEnvKey: "WORDPRESS_PAGE_ID_IBOV",
  },
  WIN: {
    key: "WIN",
    nome: "Mini Índice (WIN)",
    timeframe: "Gráfico Intraday de 15 minutos (M15)",
    tvSymbol: "BMFBOVESPA:WIN1!",
    tvInterval: "15",
    slug: "mini-indice",
    roundStep: 1000,
    wpEnvKey: "WORDPRESS_PAGE_ID_WIN",
  },
  WDO: {
    key: "WDO",
    nome: "Mini Dólar Futuro (WDO)",
    timeframe: "Gráfico Intraday de 15 minutos (M15)",
    tvSymbol: "BMFBOVESPA:WDO1!",
    tvInterval: "15",
    slug: "mini-dolar",
    roundStep: 10,
    wpEnvKey: "WORDPRESS_PAGE_ID_WDO",
  },
};

export function normalizeAssetKey(input) {
  if (!input) return null;
  const k = String(input).toUpperCase().trim();
  return ASSETS[k] ? k : null;
}

export function formatNumber(value, decimals) {
  if (value == null || Number.isNaN(value)) return "—";
  if (decimals == null) {
    if (Math.abs(value) >= 1000) decimals = 0;
    else if (Math.abs(value) >= 10) decimals = 2;
    else decimals = 4;
  }
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}


async function callGroq({ apiKey, model, systemPrompt, userPrompt, maxTokens = 1400 }) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq: resposta sem texto");
  return text.trim().replace(/^["']|["']$/g, "");
}

async function callGemini({ apiKey, model, systemPrompt, userPrompt, maxTokens = 1400 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: maxTokens,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini: resposta sem texto");
  return text.trim().replace(/^["']|["']$/g, "");
}

export async function callLLM({ provider, apiKey, model, systemPrompt, userPrompt, maxTokens }) {
  if (provider === "groq") return callGroq({ apiKey, model, systemPrompt, userPrompt, maxTokens });
  return callGemini({ apiKey, model, systemPrompt, userPrompt, maxTokens });
}

export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    vars[k] == null ? "" : String(vars[k])
  );
}

// Resolve provider/model a partir de opts e variáveis de ambiente.
function resolveLLMConfig(opts) {
  const groqKey   = opts.groqKey   || globalThis.process?.env?.GROQ_API_KEY;
  const geminiKey = opts.geminiKey || globalThis.process?.env?.GEMINI_API_KEY;
  const provider  = groqKey ? "groq" : "gemini";
  const apiKey    = groqKey || geminiKey;
  if (!apiKey) throw new Error("Configure GROQ_API_KEY ou GEMINI_API_KEY");
  const defaultModel = provider === "groq" ? "llama-3.3-70b-versatile" : "gemini-2.0-flash";
  const model = opts.model || globalThis.process?.env?.LLM_MODEL ||
    (provider === "gemini" ? globalThis.process?.env?.GEMINI_MODEL : null) || defaultModel;
  return { provider, apiKey, model };
}

// Monta OHLC diário a partir do cache RTD do Profit.
function ohlcFromRtd(rtd) {
  const prevClose = rtd.prev_close ?? null;
  // Variação do dia = coluna I (Variação%, já calculada pelo Profit como D vs H).
  // Se vier nula, calcula a partir de Fechamento Anterior (H) vs Último (D).
  const percent_change = rtd.var_pct != null
    ? rtd.var_pct
    : (prevClose && prevClose !== 0 ? ((rtd.close - prevClose) / prevClose) * 100 : 0);
  return {
    ticker: rtd.nome ?? null, // contrato corrente do RTD (ex.: WINQ26, WDON26, IBOV)
    open: rtd.open,
    high: rtd.high,
    low: rtd.low,
    close: rtd.close,
    prevClose,
    percent_change,
    rsi: rtd.rsi ?? null,
    hist_vol: rtd.hist_vol ?? null,
    volume: rtd.volume ?? null,
    var_semana: rtd.var_semana ?? null,
    var_mes: rtd.var_mes ?? null,
    var_3m: rtd.var_3m ?? null,
    var_6m: rtd.var_6m ?? null,
    var_12m: rtd.var_12m ?? null,
    var_ano: rtd.var_ano ?? null,
    var_tri: rtd.var_tri ?? null,
    var_sem: rtd.var_sem ?? null,
    currency: "BRL",
    asOf: new Date(rtd.ts),
  };
}

// Monta o bloco de retornos em múltiplos prazos (semana, mês, trimestre, semestre,
// 12 meses, ano) para dar ao LLM contexto de longo prazo além do candle do dia.
function buildMultiPrazoBlock(ohlcDay) {
  const fmtPct = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  const dia = ohlcDay.percent_change;

  // Início de semana: o acumulado semanal coincide com a variação do dia (ex.: segunda
  // ou 1º pregão útil da semana). Nesse caso, dia e semana são o MESMO número — não dá
  // para tratá-los como dois sinais que se confirmam, sob pena de soar redundante.
  const semanaIgualDia =
    ohlcDay.var_semana != null && dia != null &&
    Math.abs(ohlcDay.var_semana - dia) < 0.02;

  const linhaSemana = semanaIgualDia
    ? `- Acumulado da Semana: ${fmtPct(ohlcDay.var_semana)} (semana em formação — igual à variação do dia)`
    : `- Variação na Semana: ${fmtPct(ohlcDay.var_semana)}`;

  const linhas = [
    ohlcDay.var_semana != null ? linhaSemana : null,
    ohlcDay.var_mes    != null ? `- Variação no Mês: ${fmtPct(ohlcDay.var_mes)}` : null,
    ohlcDay.var_tri    != null ? `- Variação no Trimestre: ${fmtPct(ohlcDay.var_tri)}` : null,
    ohlcDay.var_3m     != null ? `- Variação em 3 Meses: ${fmtPct(ohlcDay.var_3m)}` : null,
    ohlcDay.var_sem    != null ? `- Variação no Semestre: ${fmtPct(ohlcDay.var_sem)}` : null,
    ohlcDay.var_6m     != null ? `- Variação em 6 Meses: ${fmtPct(ohlcDay.var_6m)}` : null,
    ohlcDay.var_12m    != null ? `- Variação em 12 Meses: ${fmtPct(ohlcDay.var_12m)}` : null,
    ohlcDay.var_ano    != null ? `- Variação no Ano (YTD): ${fmtPct(ohlcDay.var_ano)}` : null,
  ].filter(Boolean);
  if (!linhas.length) return "";

  const notaSemana = semanaIgualDia
    ? ` ATENÇÃO (início de semana): o acumulado da semana é idêntico à variação do dia, pois a semana está apenas começando. NÃO descreva o movimento do dia e o da semana como duas confirmações distintas (ex.: evite "subiu no pregão e também na semana") — seria redundante e de baixo nível. Em vez disso, enquadre o número como a ABERTURA da semana (ex.: "o ativo inicia a semana em alta/baixa", "abre a semana pressionado", "estreia a semana lateralizado") e apoie a leitura de tendência maior nos demais prazos (mês, trimestre, semestre).`
    : "";

  return `\nPerformance em Múltiplos Prazos (contexto de pano de fundo — NÃO deixe que estes números de longo prazo determinem a direção do mercado; a leitura de direção vem do movimento recente do dia e da semana. Use-os apenas para enriquecer o texto, sem sobrepor o curto prazo).${notaSemana}\n${linhas.join("\n")}`;
}

/**
 * Busca os dados do ativo exclusivamente via RTD: primeiro tenta ler ao vivo da
 * instância do Excel aberta (COM, sem precisar salvar); se não houver Excel aberto
 * com o RTD, cai para o último rtd.xlsx salvo em disco. Nenhuma API externa é consultada.
 */
async function fetchOhlcForAsset(asset) {
  const liveRtd = await readRtdLive(asset.key);
  if (liveRtd) return { ohlcDay: ohlcFromRtd(liveRtd), ohlc15m: null };

  const fileRtd = await readRtdFromFile(asset.key);
  if (fileRtd) return { ohlcDay: ohlcFromRtd(fileRtd), ohlc15m: null };

  throw new Error(
    `RTD: dados de ${asset.key} ausentes. Verifique se o Excel está aberto com rtd.xlsx e o RTD do Profit conectado (ou se há um rtd.xlsx salvo nos últimos 20 min).`
  );
}

/**
 * Orquestra o pipeline completo de análise de UM ativo.
 * @param {string} assetKey  — IBOV, WIN ou WDO
 * @param {object} opts      — { groqKey?, geminiKey?, model?, systemPrompt?, userPromptTpl? }
 * @returns {Promise<{ asset, ohlc, ohlc15m, analiseTexto, userPrompt }>}
 *   ohlc = dados diários (use para display na página)
 *   ohlc15m = último candle de 15m (contexto intraday, pode ser null para IBOV)
 */
export async function buildAnalysis(assetKey, opts = {}) {
  const asset = ASSETS[assetKey];
  if (!asset) throw new Error(`Ativo desconhecido: ${assetKey}`);

  const { provider, apiKey, model } = resolveLLMConfig(opts);
  const { ohlcDay, ohlc15m } = await fetchOhlcForAsset(asset);

  const extraIndicadores = [
    ohlcDay.rsi     != null ? `- IFR (RSI-14): ${ohlcDay.rsi.toFixed(1)}`            : null,
    ohlcDay.hist_vol != null ? `- Volatilidade Histórica Média: ${ohlcDay.hist_vol.toFixed(2)}%` : null,
  ].filter(Boolean).join("\n");

  const multiPrazo = buildMultiPrazoBlock(ohlcDay);

  // Para WIN/WDO, inclui dados do último candle de 15m como contexto adicional
  const extra15m = (ohlc15m && asset.key !== "IBOV")
    ? `\n\nÚltimo Candle de 15 Minutos (contexto intraday):
- Abertura (15m): ${formatNumber(ohlc15m.open)}
- Máxima (15m): ${formatNumber(ohlc15m.high)}
- Mínima (15m): ${formatNumber(ohlc15m.low)}
- Fechamento (15m): ${formatNumber(ohlc15m.close)}`
    : "";

  const userPrompt = renderTemplate(opts.userPromptTpl || DUAL_USER_PROMPT_TEMPLATE, {
    ativo: asset.nome,
    open: formatNumber(ohlcDay.open),
    high: formatNumber(ohlcDay.high),
    low: formatNumber(ohlcDay.low),
    close: formatNumber(ohlcDay.close),
    percent_change: ohlcDay.percent_change.toFixed(2),
    timeframe: asset.timeframe,
    extraIndicadores: extraIndicadores ? `\n${extraIndicadores}` : "",
    extra15m,
    multiPrazo: multiPrazo ? `\n${multiPrazo}` : "",
  });

  const analiseTexto = await callLLM({
    provider,
    apiKey,
    model,
    systemPrompt: opts.systemPrompt || DUAL_SYSTEM_PROMPT,
    userPrompt,
  });

  // Saída padrão das páginas: duas versões (Trader + Técnica). Se o parsing falhar
  // (marcadores ausentes), versions fica null e os consumidores caem no texto corrido.
  const versions = parseDualVersions(analiseTexto);

  return { asset, ohlc: ohlcDay, ohlc15m, analiseTexto, versions, userPrompt };
}

/**
 * Variante de buildAnalysis que usa a transcrição de áudio do analista como
 * guia principal da narrativa. Os dados quantitativos do RTD preenchem os números exatos.
 *
 * @param {string} assetKey     — IBOV, WIN ou WDO
 * @param {string} transcricao  — texto transcrito do áudio do analista
 * @param {object} opts         — mesmas opções de buildAnalysis
 */
export async function buildAnalysisWithAudio(assetKey, transcricao, opts = {}) {
  const asset = ASSETS[assetKey];
  if (!asset) throw new Error(`Ativo desconhecido: ${assetKey}`);
  if (!transcricao || !transcricao.trim()) throw new Error("Transcrição de áudio vazia");

  const { provider, apiKey, model } = resolveLLMConfig(opts);
  const { ohlcDay } = await fetchOhlcForAsset(asset);

  const extraIndicadores = [
    ohlcDay.rsi     != null ? `- IFR (RSI-14): ${ohlcDay.rsi.toFixed(1)}`            : null,
    ohlcDay.hist_vol != null ? `- Volatilidade Histórica Média: ${ohlcDay.hist_vol.toFixed(2)}%` : null,
  ].filter(Boolean).join("\n");

  const multiPrazo = buildMultiPrazoBlock(ohlcDay);

  const userPrompt = renderTemplate(opts.userPromptTpl || AUDIO_USER_PROMPT_TEMPLATE, {
    ativo: asset.nome,
    transcricao: transcricao.trim(),
    open: formatNumber(ohlcDay.open),
    high: formatNumber(ohlcDay.high),
    low: formatNumber(ohlcDay.low),
    close: formatNumber(ohlcDay.close),
    percent_change: ohlcDay.percent_change.toFixed(2),
    timeframe: asset.timeframe,
    extraIndicadores: extraIndicadores ? `\n${extraIndicadores}` : "",
    multiPrazo: multiPrazo ? `\n${multiPrazo}` : "",
  });

  const analiseTexto = await callLLM({
    provider,
    apiKey,
    model,
    systemPrompt: opts.systemPrompt || AUDIO_SYSTEM_PROMPT,
    userPrompt,
  });

  return { asset, ohlc: ohlcDay, analiseTexto, userPrompt, transcricao };
}
