// Lógica compartilhada entre o cron (src/generate.mjs) e o bot (api/telegram.js).
// Compatível com Node 20+ e com o runtime Edge da Vercel — usa apenas fetch e string ops.

import {
  SYSTEM_PROMPT,
  USER_PROMPT_TEMPLATE,
  AUDIO_SYSTEM_PROMPT,
  AUDIO_USER_PROMPT_TEMPLATE,
} from "./prompts.mjs";

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
// AA=IFR(RSI), AC=Volatilidade Histórica Média.
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

    for (const row of rows.slice(1)) {
      const key = rtdAssetKeyFromName(row[0]);
      if (key !== assetKey) continue;
      const [close, open, high, low, prevClose, varPct] = [row[3], row[4], row[5], row[6], row[7], row[8]];
      if (!close || !open || !high || !low) continue;
      const rsi = typeof row[26] === "number" && row[26] >= 0 && row[26] <= 100 ? row[26] : null;
      const histVol = typeof row[28] === "number" ? row[28] : null;
      return {
        close,
        open,
        high,
        low,
        prev_close: prevClose ?? null,
        var_pct: varPct ?? null,
        volume: row[11] ?? null,
        rsi,
        hist_vol: histVol,
        date: row[1] ?? null,
        time: row[2] ?? null,
        ts: info.mtime.toISOString(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export const ASSETS = {
  IBOV: {
    key: "IBOV",
    nome: "Ibovespa (IBOV)",
    timeframe: "Gráfico Diário (1D)",
    tvSymbol: "BMFBOVESPA:IBOV",
    tvInterval: "D",
    slug: "ibovespa",
    wpEnvKey: "WORDPRESS_PAGE_ID_IBOV",
  },
  WIN: {
    key: "WIN",
    nome: "Mini Índice (WIN)",
    timeframe: "Gráfico Intraday de 15 minutos (M15)",
    tvSymbol: "BMFBOVESPA:WIN1!",
    tvInterval: "15",
    slug: "mini-indice",
    wpEnvKey: "WORDPRESS_PAGE_ID_WIN",
  },
  WDO: {
    key: "WDO",
    nome: "Mini Dólar Futuro (WDO)",
    timeframe: "Gráfico Intraday de 15 minutos (M15)",
    tvSymbol: "BMFBOVESPA:WDO1!",
    tvInterval: "15",
    slug: "mini-dolar",
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


async function callGroq({ apiKey, model, systemPrompt, userPrompt }) {
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
      max_tokens: 600,
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

async function callGemini({ apiKey, model, systemPrompt, userPrompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 600,
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

export async function callLLM({ provider, apiKey, model, systemPrompt, userPrompt }) {
  if (provider === "groq") return callGroq({ apiKey, model, systemPrompt, userPrompt });
  return callGemini({ apiKey, model, systemPrompt, userPrompt });
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
    open: rtd.open,
    high: rtd.high,
    low: rtd.low,
    close: rtd.close,
    prevClose,
    percent_change,
    rsi: rtd.rsi ?? null,
    hist_vol: rtd.hist_vol ?? null,
    volume: rtd.volume ?? null,
    currency: "BRL",
    asOf: new Date(rtd.ts),
  };
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

  // Para WIN/WDO, inclui dados do último candle de 15m como contexto adicional
  const extra15m = (ohlc15m && asset.key !== "IBOV")
    ? `\n\nÚltimo Candle de 15 Minutos (contexto intraday):
- Abertura (15m): ${formatNumber(ohlc15m.open)}
- Máxima (15m): ${formatNumber(ohlc15m.high)}
- Mínima (15m): ${formatNumber(ohlc15m.low)}
- Fechamento (15m): ${formatNumber(ohlc15m.close)}`
    : "";

  const userPrompt = renderTemplate(opts.userPromptTpl || USER_PROMPT_TEMPLATE, {
    ativo: asset.nome,
    open: formatNumber(ohlcDay.open),
    high: formatNumber(ohlcDay.high),
    low: formatNumber(ohlcDay.low),
    close: formatNumber(ohlcDay.close),
    percent_change: ohlcDay.percent_change.toFixed(2),
    timeframe: asset.timeframe,
    extraIndicadores: extraIndicadores ? `\n${extraIndicadores}` : "",
    extra15m,
  });

  const analiseTexto = await callLLM({
    provider,
    apiKey,
    model,
    systemPrompt: opts.systemPrompt || SYSTEM_PROMPT,
    userPrompt,
  });

  return { asset, ohlc: ohlcDay, ohlc15m, analiseTexto, userPrompt };
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
