// Lógica compartilhada entre o cron (src/generate.mjs) e o bot (api/telegram.js).
// Compatível com Node 20+ e com o runtime Edge da Vercel — usa apenas fetch e string ops.

import { SYSTEM_PROMPT, USER_PROMPT_TEMPLATE } from "./prompts.mjs";

// Lê cache RTD gerado pelo profit-bridge.ps1 (apenas em ambiente Node, não no Edge)
async function readRtdCache(assetKey) {
  try {
    const { readFile } = await import("node:fs/promises");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const raw = await readFile(resolve(root, "data/rtd-cache.json"), "utf8");
    const cache = JSON.parse(raw.replace(/^﻿/, ""));
    const entry = cache[assetKey];
    if (!entry) return null;
    // Rejeita cache com mais de 20 minutos
    const age = Date.now() - new Date(entry.ts).getTime();
    if (age > 20 * 60 * 1000) return null;
    return entry;
  } catch {
    return null;
  }
}

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
    lastCandleOnly: true,
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
    lastCandleOnly: true,
    yahooScale: 1000,
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

export async function fetchYahooOHLC(symbol, interval, range, { lastCandleOnly = false } = {}) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AnaliseTecnicaBot/1.0)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo Finance ${symbol} HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance ${symbol}: resposta vazia`);

  const meta = result.meta;
  const q = result.indicators?.quote?.[0] || {};
  const rawOpens  = q.open  || [];
  const rawHighs  = q.high  || [];
  const rawLows   = q.low   || [];
  const rawCloses = q.close || [];

  // índices não-nulos
  const validIdx = rawCloses
    .map((v, i) => (v != null ? i : null))
    .filter((i) => i !== null);

  if (validIdx.length === 0) throw new Error(`Yahoo Finance ${symbol}: série OHLC vazia`);

  let open, high, low, close, prevClose;

  if (lastCandleOnly && validIdx.length >= 2) {
    // Último candle completo: prevClose = penúltimo fechamento
    const last = validIdx[validIdx.length - 1];
    const prev = validIdx[validIdx.length - 2];
    open  = rawOpens[last]  ?? rawCloses[last];
    high  = rawHighs[last]  ?? rawCloses[last];
    low   = rawLows[last]   ?? rawCloses[last];
    close = rawCloses[last];
    prevClose = rawCloses[prev];
  } else {
    // Sessão completa: agrega todos os candles
    const opens  = validIdx.map((i) => rawOpens[i]).filter(Boolean);
    const highs  = validIdx.map((i) => rawHighs[i]).filter(Boolean);
    const lows   = validIdx.map((i) => rawLows[i]).filter(Boolean);
    const closes = validIdx.map((i) => rawCloses[i]);
    open  = opens[0];
    high  = Math.max(...highs);
    low   = Math.min(...lows);
    close = closes[closes.length - 1];
    prevClose =
      meta.chartPreviousClose ??
      meta.previousClose ??
      meta.regularMarketPreviousClose ??
      null;
  }

  const percent_change = prevClose ? ((close - prevClose) / prevClose) * 100 : 0;

  return {
    open,
    high,
    low,
    close,
    percent_change,
    prevClose,
    currency: meta.currency,
    asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : new Date(),
  };
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

/**
 * Orquestra o pipeline completo de análise de UM ativo.
 * @param {string} assetKey  — IBOV, WIN ou WDO
 * @param {object} opts      — { geminiKey?, geminiModel?, systemPrompt?, userPromptTpl? }
 * @returns {Promise<{ asset, ohlc, analiseTexto, userPrompt }>}
 */
export async function buildAnalysis(assetKey, opts = {}) {
  const asset = ASSETS[assetKey];
  if (!asset) throw new Error(`Ativo desconhecido: ${assetKey}`);

  const groqKey = opts.groqKey || globalThis.process?.env?.GROQ_API_KEY;
  const geminiKey = opts.geminiKey || globalThis.process?.env?.GEMINI_API_KEY;
  const provider = groqKey ? "groq" : "gemini";
  const apiKey = groqKey || geminiKey;
  if (!apiKey) throw new Error("Configure GROQ_API_KEY ou GEMINI_API_KEY");
  const defaultModel = provider === "groq" ? "llama-3.3-70b-versatile" : "gemini-2.0-flash";
  const model = opts.model || globalThis.process?.env?.LLM_MODEL ||
    (provider === "gemini" ? globalThis.process?.env?.GEMINI_MODEL : null) || defaultModel;

  // Tenta usar dados ao vivo do Profit (RTD) para WIN e WDO
  let ohlc;
  const rtd = asset.key !== "IBOV" ? await readRtdCache(asset.key) : null;
  if (rtd) {
    // Usa prevClose e variação diretamente do Profit — sem Yahoo Finance
    const prevClose = rtd.prev_close ?? null;
    const percent_change = rtd.var_pct != null
      ? rtd.var_pct
      : (prevClose ? ((rtd.close - prevClose) / prevClose) * 100 : 0);
    ohlc = { open: rtd.open, high: rtd.high, low: rtd.low, close: rtd.close,
              prevClose, percent_change, rsi: rtd.rsi, hist_vol: rtd.hist_vol,
              volume: rtd.volume, currency: "BRL", asOf: new Date(rtd.ts) };
  } else {
    ohlc = await fetchYahooOHLC(
      asset.yahoo, asset.yahooInterval, asset.yahooRange,
      { lastCandleOnly: asset.lastCandleOnly ?? false }
    );
  }

  const extraIndicadores = [
    ohlc.rsi != null ? `- IFR (RSI-14): ${ohlc.rsi.toFixed(1)}` : null,
    ohlc.hist_vol != null ? `- Volatilidade Histórica Média: ${ohlc.hist_vol.toFixed(2)}%` : null,
  ].filter(Boolean).join("\n");

  const userPrompt = renderTemplate(opts.userPromptTpl || USER_PROMPT_TEMPLATE, {
    ativo: asset.nome,
    open: formatNumber(ohlc.open),
    high: formatNumber(ohlc.high),
    low: formatNumber(ohlc.low),
    close: formatNumber(ohlc.close),
    percent_change: ohlc.percent_change.toFixed(2),
    timeframe: asset.timeframe,
    extraIndicadores: extraIndicadores ? `\n${extraIndicadores}` : "",
  });

  const analiseTexto = await callLLM({
    provider,
    apiKey,
    model,
    systemPrompt: opts.systemPrompt || SYSTEM_PROMPT,
    userPrompt,
  });

  return { asset, ohlc, analiseTexto, userPrompt };
}
