// Lógica compartilhada entre o cron (src/generate.mjs) e o bot (api/telegram.js).
// Compatível com Node 20+ e com o runtime Edge da Vercel — usa apenas fetch e string ops.

import { SYSTEM_PROMPT, USER_PROMPT_TEMPLATE } from "./prompts.mjs";

export const ASSETS = {
  IBOV: {
    key: "IBOV",
    nome: "Ibovespa (IBOV)",
    yahoo: "^BVSP",
    yahooInterval: "1d",
    yahooRange: "5d",
    timeframe: "Gráfico Diário (1D)",
    tvSymbol: "BMFBOVESPA:IBOV",
    tvInterval: "D",
    slug: "ibovespa",
    wpEnvKey: "WORDPRESS_PAGE_ID_IBOV",
  },
  WIN: {
    key: "WIN",
    nome: "Mini Índice (WIN)",
    yahoo: "^BVSP",
    yahooInterval: "15m",
    yahooRange: "1d",
    timeframe: "Gráfico Intraday de 15 minutos (M15)",
    tvSymbol: "BMFBOVESPA:WIN1!",
    tvInterval: "15",
    slug: "mini-indice",
    wpEnvKey: "WORDPRESS_PAGE_ID_WIN",
  },
  WDO: {
    key: "WDO",
    nome: "Mini Dólar Futuro (WDO)",
    yahoo: "BRL=X",
    yahooInterval: "15m",
    yahooRange: "1d",
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

export async function fetchYahooOHLC(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; AnaliseTecnicaBot/1.0)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo Finance ${symbol} HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance ${symbol}: resposta vazia`);

  const meta = result.meta;
  const q = result.indicators?.quote?.[0] || {};
  const opens = (q.open || []).filter((v) => v != null);
  const highs = (q.high || []).filter((v) => v != null);
  const lows = (q.low || []).filter((v) => v != null);
  const closes = (q.close || []).filter((v) => v != null);

  if (opens.length === 0 || closes.length === 0) {
    throw new Error(`Yahoo Finance ${symbol}: série OHLC vazia`);
  }

  const open = opens[0];
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const close = closes[closes.length - 1];
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? open;
  const percent_change = ((close - prevClose) / prevClose) * 100;

  return {
    open,
    high,
    low,
    close,
    percent_change,
    prevClose,
    currency: meta.currency,
    asOf: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000)
      : new Date(),
  };
}

export async function callGemini({ apiKey, model, systemPrompt, userPrompt }) {
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

export function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    vars[k] == null ? "" : String(vars[k])
  );
}

/**
 * Orquestra o pipeline completo de análise de UM ativo.
 * @param {string} assetKey  — IBOV, WIN ou WDO
 * @param {object} opts      — { geminiKey?, geminiModel?, systemPrompt?, userPromptTpl? }
 * @returns {Promise<{ asset, ohlc, analiseTexto, userPrompt }>}
 */
export async function buildAnalysis(assetKey, opts = {}) {
  const asset = ASSETS[assetKey];
  if (!asset) throw new Error(`Ativo desconhecido: ${assetKey}`);

  const apiKey = opts.geminiKey || globalThis.process?.env?.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY não configurada");
  const model =
    opts.geminiModel || globalThis.process?.env?.GEMINI_MODEL || "gemini-2.0-flash";

  const ohlc = await fetchYahooOHLC(
    asset.yahoo,
    asset.yahooInterval,
    asset.yahooRange
  );

  const userPrompt = renderTemplate(opts.userPromptTpl || USER_PROMPT_TEMPLATE, {
    ativo: asset.nome,
    open: formatNumber(ohlc.open),
    high: formatNumber(ohlc.high),
    low: formatNumber(ohlc.low),
    close: formatNumber(ohlc.close),
    percent_change: ohlc.percent_change.toFixed(2),
    timeframe: asset.timeframe,
  });

  const analiseTexto = await callGemini({
    apiKey,
    model,
    systemPrompt: opts.systemPrompt || SYSTEM_PROMPT,
    userPrompt,
  });

  return { asset, ohlc, analiseTexto, userPrompt };
}
