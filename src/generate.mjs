#!/usr/bin/env node
// Cron / CLI: gera HTMLs estáticos, opcionalmente publica no WordPress
// e notifica o admin via Telegram. A lógica de análise vive em src/lib/analysis.mjs.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

import {
  ASSETS,
  buildAnalysis,
  formatNumber,
  renderTemplate,
} from "./lib/analysis.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function log(msg, ...rest) {
  console.log(`[${new Date().toISOString()}] ${msg}`, ...rest);
}

function requireEnv(key) {
  const v = process.env[key];
  if (!v || v.startsWith("COLE_")) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
  return v;
}

async function publishWordpress({ url, user, password, pageId, htmlContent, title }) {
  if (!url || !user || !password || !pageId) return { skipped: true };
  const endpoint = `${url.replace(/\/$/, "")}/wp-json/wp/v2/pages/${pageId}`;
  const auth = Buffer.from(`${user}:${password}`).toString("base64");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ title, content: htmlContent, status: "publish" }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`WordPress HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  return { skipped: false, id: pageId };
}

async function notifyTelegram({ token, chatId, message }) {
  if (!token || !chatId) return { skipped: true };
  // Admin notification: texto puro para evitar problemas de parser com erros
  // contendo caracteres especiais. Bold/italic não importa para notificação admin.
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return { skipped: false };
}

async function processAsset(assetKey, pageTpl) {
  log(`▶ ${assetKey} — iniciando pipeline`);
  const { asset, ohlc, analiseTexto } = await buildAnalysis(assetKey);

  const publishedAt = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });

  const periodos = [
    { label: "Semana", value: ohlc.var_semana },
    { label: "Mês", value: ohlc.var_mes },
    { label: "Trimestre", value: ohlc.var_tri },
    { label: "Semestre", value: ohlc.var_sem },
    { label: "12 Meses", value: ohlc.var_12m },
    { label: "Ano (YTD)", value: ohlc.var_ano },
  ].filter((p) => p.value != null);

  const quantPanelHtml = periodos.length
    ? periodos
        .map(
          (p) => `<div class="quant-cell">
              <span class="quant-label">${p.label}</span>
              <span class="quant-value ${p.value >= 0 ? "positive" : "negative"}">${p.value >= 0 ? "+" : ""}${p.value.toFixed(2)}%</span>
            </div>`
        )
        .join("\n")
    : "";

  const html = renderTemplate(pageTpl, {
    ativo: asset.nome,
    timeframe: asset.timeframe,
    tvSymbol: asset.tvSymbol,
    tvInterval: asset.tvInterval,
    open: formatNumber(ohlc.open),
    high: formatNumber(ohlc.high),
    low: formatNumber(ohlc.low),
    close: formatNumber(ohlc.close),
    percent_change: ohlc.percent_change.toFixed(2),
    changeClass: ohlc.percent_change >= 0 ? "positive" : "negative",
    quantPanelHtml,
    analiseTexto,
    textoOg: analiseTexto.slice(0, 180).replace(/"/g, "'") + "…",
    publicadoEm: publishedAt,
    coletadoEm: ohlc.asOf.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      dateStyle: "short",
      timeStyle: "short",
    }),
    canonicalUrl: `${process.env.PUBLIC_BASE_URL || ""}/${asset.slug}.html`,
  });

  const outDir = path.resolve(ROOT, process.env.OUTPUT_DIR || "public");
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `${asset.slug}.html`);
  await fs.writeFile(outFile, html, "utf8");
  log(`✔ ${assetKey} — HTML gravado em ${path.relative(ROOT, outFile)}`);

  const wpResult = await publishWordpress({
    url: process.env.WORDPRESS_URL,
    user: process.env.WORDPRESS_USER,
    password: process.env.WORDPRESS_APP_PASSWORD,
    pageId: process.env[asset.wpEnvKey],
    htmlContent: html,
    title: `Análise Técnica — ${asset.nome}`,
  });
  if (wpResult.skipped) {
    log(`⊝ ${assetKey} — WordPress: pulado (credenciais não configuradas)`);
  } else {
    log(`✔ ${assetKey} — WordPress: página ${wpResult.id} atualizada`);
  }

  return { assetKey, ohlc, analiseTexto, outFile, wpPublished: !wpResult.skipped };
}

async function main() {
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
    throw new Error("Configure GROQ_API_KEY ou GEMINI_API_KEY no .env");
  }

  const pageTpl = await fs.readFile(
    path.join(ROOT, "templates/page.html"),
    "utf8"
  );

  const selectorRaw = (process.env.PUBLISH_ASSETS || "ALL").toUpperCase();
  const selected =
    selectorRaw === "ALL"
      ? Object.keys(ASSETS)
      : selectorRaw.split(",").map((s) => s.trim()).filter(Boolean);

  log(`Ativos selecionados: ${selected.join(", ")}`);

  const results = [];
  for (const key of selected) {
    if (!ASSETS[key]) {
      log(`⚠ ativo desconhecido ignorado: ${key}`);
      continue;
    }
    try {
      results.push(await processAsset(key, pageTpl));
    } catch (err) {
      log(`✘ ${key} — falhou: ${err.message}`);
      results.push({ assetKey: key, error: err.message });
    }
  }

  const summary = results
    .map((r) =>
      r.error
        ? `• ❌ ${r.assetKey}: ${r.error.slice(0, 250)}`
        : `• ✅ ${r.assetKey}: fech. ${formatNumber(r.ohlc.close)} (${r.ohlc.percent_change.toFixed(2)}%)${r.wpPublished ? " — publicado" : ""}`
    )
    .join("\n");

  try {
    await notifyTelegram({
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      message: `Análise Técnica — execução concluída\n${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}\n\n${summary}`,
    });
  } catch (err) {
    log(`⚠ Telegram admin falhou: ${err.message}`);
  }

  const hasError = results.some((r) => r.error);
  process.exit(hasError ? 1 : 0);
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});
