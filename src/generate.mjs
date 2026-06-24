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
import { DUAL_CLOSING } from "./lib/prompts.mjs";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Realça a frase de encerramento obrigatória dentro de um parágrafo já escapado.
function emphasizeClosing(htmlEscaped) {
  const phrase = escapeHtml(DUAL_CLOSING);
  return htmlEscaped.replace(phrase, `<strong>${phrase}</strong>`);
}

// Monta o HTML da análise: duas versões rotuladas (Trader + Técnica) quando
// disponíveis; caso contrário, um único parágrafo (fallback). Cada versão recebe
// um botão "Copiar texto" para facilitar a colagem no WordPress.
function buildAnaliseHtml(analiseTexto, versions) {
  if (versions) {
    const bloco = (rotulo, texto) =>
      `<div class="analise-versao">
            <div class="analise-versao-head">
              <span class="analise-versao-label">${rotulo}</span>
              <button class="copy-btn copy-text" type="button" aria-label="Copiar ${rotulo}">Copiar texto</button>
            </div>
            <p class="analise-tecnica">${emphasizeClosing(escapeHtml(texto))}</p>
          </div>`;
    return (
      bloco("Versão Trader", versions.trader) +
      "\n          " +
      bloco("Versão Técnica", versions.tecnica)
    );
  }
  return `<div class="analise-versao">
            <div class="analise-versao-head">
              <span class="analise-versao-label">Análise</span>
              <button class="copy-btn copy-text" type="button" aria-label="Copiar análise">Copiar texto</button>
            </div>
            <p class="analise-tecnica">${emphasizeClosing(escapeHtml(analiseTexto))}</p>
          </div>`;
}

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
  const { asset, ohlc, analiseTexto, versions } = await buildAnalysis(assetKey);

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

  const ticker = ohlc.ticker || asset.tvSymbol || asset.nome;
  const openF = formatNumber(ohlc.open);
  const highF = formatNumber(ohlc.high);
  const lowF = formatNumber(ohlc.low);
  const closeF = formatNumber(ohlc.close);
  // Variação do dia como número puro em formato pt-BR (vírgula), com sinal só no
  // negativo — ex.: "1,40" ou "-1,40". Sem o símbolo "%".
  const variacaoDisplay = formatNumber(ohlc.percent_change, 2);
  // Bloco "copiar tudo" — uma linha pronta para colar no WordPress.
  const ohlcCopy = `${ticker} | Abertura: ${openF} | Máxima: ${highF} | Mínima: ${lowF} | Fechamento: ${closeF} | Variação: ${variacaoDisplay}`;

  // Suportes e resistências em números redondos, derivados do fechamento e do passo
  // do ativo (índice 1000, dólar 10, etc.). 3 níveis acima (R1..R3) e 3 abaixo (S1..S3).
  const step = asset.roundStep || 1000;
  const floorLvl = Math.floor(ohlc.close / step) * step;
  const r1 = floorLvl + step;
  const s1 = floorLvl < ohlc.close ? floorLvl : floorLvl - step;
  const resistencias = [r1, r1 + step, r1 + 2 * step]; // R1 (mais próximo) → R3
  const suportes = [s1, s1 - step, s1 - 2 * step];      // S1 (mais próximo) → S3
  const srLevelHtml = (tag, val) =>
    `<div class="sr-level">
              <span class="sr-tag">${tag}</span>
              <span class="sr-value">${formatNumber(val, 0)}</span>
              <button class="copy-btn" type="button" data-copy="${formatNumber(val, 0)}" aria-label="Copiar ${tag}">Copiar</button>
            </div>`;
  const resistenciasHtml = resistencias.map((v, i) => srLevelHtml(`R${i + 1}`, v)).join("\n");
  const suportesHtml = suportes.map((v, i) => srLevelHtml(`S${i + 1}`, v)).join("\n");
  const srCopy =
    `Resistências: ${resistencias.map((v) => formatNumber(v, 0)).join(" / ")} | ` +
    `Suportes: ${suportes.map((v) => formatNumber(v, 0)).join(" / ")}`;

  const html = renderTemplate(pageTpl, {
    ativo: asset.nome,
    timeframe: asset.timeframe,
    tvSymbol: asset.tvSymbol,
    tvInterval: asset.tvInterval,
    ticker,
    open: openF,
    high: highF,
    low: lowF,
    close: closeF,
    percent_change: ohlc.percent_change.toFixed(2),
    variacaoDisplay,
    ohlcCopy,
    resistenciasHtml,
    suportesHtml,
    srCopy,
    changeClass: ohlc.percent_change >= 0 ? "positive" : "negative",
    quantPanelHtml,
    analiseHtml: buildAnaliseHtml(analiseTexto, versions),
    textoOg: (versions?.trader || analiseTexto).slice(0, 180).replace(/"/g, "'") + "…",
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
