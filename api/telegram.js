// Webhook do bot Telegram — rodando como Vercel Edge Function (limite 30s no Hobby).
// Recebe updates do Telegram, processa comandos e responde via Bot API.

import {
  ASSETS,
  buildAnalysis,
  formatNumber,
  normalizeAssetKey,
} from "../src/lib/analysis.mjs";

export const config = { runtime: "edge" };

const TG = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

async function tg(token, method, params) {
  const res = await fetch(TG(token, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json().catch(() => ({ ok: false }));
}

function escapeMd(text) {
  // Markdown V1 do Telegram — escapa apenas asterisco/underscore/colchete/crases
  return text.replace(/([_*`\[\]])/g, "\\$1");
}

function welcomeMsg(name) {
  const safe = escapeMd(name || "investidor");
  return `Olá, *${safe}*! 👋

Sou o bot de análise técnica automatizada da *Genial Investimentos*.

*Comandos disponíveis*
• /ibov — Ibovespa (gráfico diário)
• /win — Mini Índice WIN (M15)
• /wdo — Mini Dólar WDO (M15)
• /help — ajuda completa

⚠️ _As análises são informativas e probabilísticas (CVM/CNPI). Não constituem recomendação de compra, venda ou manutenção._`;
}

function helpMsg() {
  return `*Comandos*

/ibov — Análise do Ibovespa (gráfico diário)
/win — Análise do Mini Índice WIN (gráfico 15 minutos)
/wdo — Análise do Mini Dólar WDO (gráfico 15 minutos)
/analise IBOV — equivalente a /ibov (sintaxe alternativa)
/start — mensagem de boas-vindas

*Como funciona*
A cada solicitação, o bot coleta o OHLC do último pregão via Yahoo Finance e gera um parágrafo técnico (5–8 linhas) seguindo o padrão CNPI-T da Genial Investimentos.

⚠️ _Conteúdo informativo. Análise técnica probabilística, sem recomendação direta. Investimentos em renda variável envolvem riscos._`;
}

function buildAnalysisReply(asset, ohlc, analiseTexto, baseUrl) {
  const emoji = ohlc.percent_change >= 0 ? "🟢" : "🔴";
  const link =
    baseUrl && baseUrl.startsWith("http")
      ? `\n\n🔗 [Ver gráfico interativo](${baseUrl.replace(/\/$/, "")}/${asset.slug}.html)`
      : "";
  return `📊 *${escapeMd(asset.nome)}* — Análise Técnica
_${escapeMd(asset.timeframe)}_

${emoji} *Fechamento:* ${formatNumber(ohlc.close)} (${ohlc.percent_change.toFixed(2)}%)
*Máx.:* ${formatNumber(ohlc.high)}  ·  *Mín.:* ${formatNumber(ohlc.low)}
*Abertura:* ${formatNumber(ohlc.open)}

${analiseTexto}${link}

⚠️ _Análise técnica probabilística (CVM/CNPI). Não constitui recomendação de investimento._`;
}

export default async function handler(req) {
  const token = globalThis.process?.env?.TELEGRAM_BOT_TOKEN;
  const baseUrl = globalThis.process?.env?.PUBLIC_BASE_URL || "";

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ status: "alive", bot: token ? "configured" : "missing token" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!token) {
    return new Response("TELEGRAM_BOT_TOKEN not configured", { status: 500 });
  }

  let update;
  try {
    update = await req.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  const msg = update?.message;
  const text = msg?.text?.trim();
  if (!msg || !text) {
    return new Response("ok", { status: 200 });
  }

  const chatId = msg.chat.id;
  const userName = msg.from?.first_name || "investidor";

  // /start
  if (/^\/start\b/i.test(text)) {
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: welcomeMsg(userName),
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    return new Response("ok", { status: 200 });
  }

  // /help
  if (/^\/help\b/i.test(text)) {
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: helpMsg(),
      parse_mode: "Markdown",
    });
    return new Response("ok", { status: 200 });
  }

  // /ibov, /win, /wdo, /analise IBOV
  const directMatch = text.match(/^\/(ibov|win|wdo)\b/i);
  const verboseMatch = text.match(/^\/analise(?:_text|@\w+)?\s+(\w+)/i);
  const assetKey = normalizeAssetKey(
    directMatch?.[1] || verboseMatch?.[1] || null
  );

  if (!assetKey) {
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: "Comando não reconhecido. Use /help para ver a lista de comandos.",
    });
    return new Response("ok", { status: 200 });
  }

  // Envia placeholder que será editado quando a análise ficar pronta
  const placeholder = await tg(token, "sendMessage", {
    chat_id: chatId,
    text: `⏳ Coletando dados e gerando análise de *${escapeMd(ASSETS[assetKey].nome)}*...`,
    parse_mode: "Markdown",
  });
  const placeholderId = placeholder?.result?.message_id;

  try {
    const { asset, ohlc, analiseTexto } = await buildAnalysis(assetKey);
    const replyText = buildAnalysisReply(asset, ohlc, analiseTexto, baseUrl);

    if (placeholderId) {
      await tg(token, "editMessageText", {
        chat_id: chatId,
        message_id: placeholderId,
        text: replyText,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    } else {
      await tg(token, "sendMessage", {
        chat_id: chatId,
        text: replyText,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
    }
  } catch (err) {
    const errMsg = `❌ Falha ao gerar análise de ${assetKey}: ${err.message.slice(0, 300)}`;
    if (placeholderId) {
      await tg(token, "editMessageText", {
        chat_id: chatId,
        message_id: placeholderId,
        text: errMsg,
      });
    } else {
      await tg(token, "sendMessage", { chat_id: chatId, text: errMsg });
    }
  }

  return new Response("ok", { status: 200 });
}
