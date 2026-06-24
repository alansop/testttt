// Webhook do bot Telegram — Vercel Serverless Function (Node.js runtime).
// Recebe updates do Telegram, processa comandos de análise e mensagens de voz.
//
// Variáveis de ambiente necessárias:
//   TELEGRAM_BOT_TOKEN   — token do bot
//   OPENAI_API_KEY       — para transcrição de áudio via Whisper
//   PUBLIC_BASE_URL      — URL base das páginas publicadas
//   GROQ_API_KEY ou GEMINI_API_KEY — LLM para geração de análise

import {
  ASSETS,
  buildAnalysis,
  buildAnalysisWithAudio,
  formatNumber,
  normalizeAssetKey,
} from "../src/lib/analysis.mjs";

// Estado em memória: último ativo selecionado por chat.
// Em ambiente serverless, persiste apenas durante a vida da instância.
// Para uso pessoal (1 usuário) isso é suficiente — cold starts são raros.
const lastAssetByChat = new Map();

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

🎙️ _Após selecionar um ativo, envie um áudio **ou digite** seu comentário de mercado para gerar a análise combinada._

⚠️ _As análises são informativas e probabilísticas (CVM/CNPI). Não constituem recomendação de compra, venda ou manutenção._`;
}

function helpMsg() {
  return `*Comandos*

/ibov — Análise do Ibovespa (gráfico diário)
/win — Análise do Mini Índice WIN (gráfico 15 minutos)
/wdo — Análise do Mini Dólar WDO (gráfico 15 minutos)
/analise IBOV — sintaxe alternativa
/start — mensagem de boas-vindas

*Análise com sua narrativa (áudio ou texto)*
Selecione um ativo com /win (por exemplo) e em seguida:
• Envie uma mensagem de voz — o bot transcreve via Whisper; ou
• Digite seu comentário de mercado como texto normal.
O bot combina sua narrativa com os dados exatos do RTD para gerar a análise final.

⚠️ _Conteúdo informativo. Análise técnica probabilística, sem recomendação direta. Investimentos em renda variável envolvem riscos._`;
}

function buildAnalysisReply(asset, ohlc, analiseTexto, baseUrl, fromAudio = false, versions = null) {
  const emoji = ohlc.percent_change >= 0 ? "🟢" : "🔴";
  const audioTag = fromAudio ? " 🎙️" : "";
  const link =
    baseUrl && baseUrl.startsWith("http")
      ? `\n\n🔗 [Ver gráfico interativo](${baseUrl.replace(/\/$/, "")}/${asset.slug}.html)`
      : "";
  // Quando há duas versões (texto automático das páginas), exibe ambas rotuladas.
  const corpo = versions
    ? `📈 *Versão Trader*\n${versions.trader}\n\n📐 *Versão Técnica*\n${versions.tecnica}`
    : analiseTexto;
  return `📊 *${escapeMd(asset.nome)}* — Análise Técnica${audioTag}
_${escapeMd(asset.timeframe)}_

${emoji} *Fechamento:* ${formatNumber(ohlc.close)} (${ohlc.percent_change.toFixed(2)}%)
*Máx. do Dia:* ${formatNumber(ohlc.high)}  ·  *Mín. do Dia:* ${formatNumber(ohlc.low)}
*Abertura:* ${formatNumber(ohlc.open)}

${corpo}${link}

⚠️ _Análise técnica probabilística (CVM/CNPI). Não constitui recomendação de investimento._`;
}

// Baixa o áudio do Telegram e envia para o Whisper (OpenAI) para transcrição.
async function transcribeVoice(telegramToken, fileId, openaiKey, language = "pt") {
  // 1. Resolve o caminho do arquivo no servidor do Telegram
  const fileInfoRes = await fetch(TG(telegramToken, "getFile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo?.result?.file_path;
  if (!filePath) throw new Error("Telegram getFile: file_path ausente");

  // 2. Baixa o binário do áudio
  const audioRes = await fetch(`https://api.telegram.org/file/bot${telegramToken}/${filePath}`);
  if (!audioRes.ok) throw new Error(`Telegram download do áudio falhou: ${audioRes.status}`);
  const audioBuffer = await audioRes.arrayBuffer();

  // 3. Envia para Whisper via multipart/form-data
  // Mensagens de voz do Telegram chegam como .oga (OGG/Opus)
  const ext = filePath.split(".").pop() || "oga";
  const mimeMap = { oga: "audio/ogg", ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4" };
  const mime = mimeMap[ext] || "audio/ogg";

  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mime }), `voice.${ext}`);
  form.append("model", "whisper-1");
  form.append("language", language);

  const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  if (!whisperRes.ok) {
    const t = await whisperRes.text();
    throw new Error(`Whisper HTTP ${whisperRes.status}: ${t.slice(0, 200)}`);
  }
  const whisperData = await whisperRes.json();
  const transcricao = whisperData?.text?.trim();
  if (!transcricao) throw new Error("Whisper retornou transcrição vazia");
  return transcricao;
}

// Gera a análise a partir de uma narrativa em texto (digitada pelo analista).
// Mesmo fluxo do áudio, mas sem o passo de transcrição.
async function handleNarrative(token, chatId, assetKey, narrativa, baseUrl) {
  const placeholder = await tg(token, "sendMessage", {
    chat_id: chatId,
    text: `⏳ Gerando análise de *${escapeMd(ASSETS[assetKey].nome)}* com seu comentário...`,
    parse_mode: "Markdown",
  });
  const placeholderId = placeholder?.result?.message_id;

  try {
    const { asset, ohlc, analiseTexto } = await buildAnalysisWithAudio(assetKey, narrativa);
    const replyText = buildAnalysisReply(asset, ohlc, analiseTexto, baseUrl, true);

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
    const errMsg = `❌ Falha ao gerar análise: ${err.message.slice(0, 300)}`;
    if (placeholderId) {
      await tg(token, "editMessageText", { chat_id: chatId, message_id: placeholderId, text: errMsg });
    } else {
      await tg(token, "sendMessage", { chat_id: chatId, text: errMsg });
    }
  }
}

export default async function handler(req) {
  const token    = process.env.TELEGRAM_BOT_TOKEN;
  const baseUrl  = process.env.PUBLIC_BASE_URL || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";

  if (req.method !== "POST") {
    return Response.json({ status: "alive", bot: token ? "configured" : "missing token" });
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

  const msg    = update?.message;
  const chatId = msg?.chat?.id;
  if (!msg || !chatId) return new Response("ok", { status: 200 });

  const text      = msg.text?.trim() || "";
  const voice     = msg.voice || msg.audio || null;
  const userName  = msg.from?.first_name || "investidor";

  // ── /start ────────────────────────────────────────────────────────────────
  if (/^\/start\b/i.test(text)) {
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: welcomeMsg(userName),
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
    return new Response("ok", { status: 200 });
  }

  // ── /help ─────────────────────────────────────────────────────────────────
  if (/^\/help\b/i.test(text)) {
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: helpMsg(),
      parse_mode: "Markdown",
    });
    return new Response("ok", { status: 200 });
  }

  // ── Mensagem de voz: transcreve + gera análise com áudio ──────────────────
  if (voice) {
    const assetKey = lastAssetByChat.get(chatId) || null;

    if (!assetKey) {
      await tg(token, "sendMessage", {
        chat_id: chatId,
        text: "Selecione um ativo antes de enviar o áudio.\nExemplo: /win — e então envie sua mensagem de voz.",
      });
      return new Response("ok", { status: 200 });
    }

    if (!openaiKey) {
      await tg(token, "sendMessage", {
        chat_id: chatId,
        text: "❌ OPENAI_API_KEY não configurada. A transcrição de áudio não está disponível.",
      });
      return new Response("ok", { status: 200 });
    }

    const placeholder = await tg(token, "sendMessage", {
      chat_id: chatId,
      text: `⏳ Transcrevendo áudio e gerando análise de *${escapeMd(ASSETS[assetKey].nome)}*...`,
      parse_mode: "Markdown",
    });
    const placeholderId = placeholder?.result?.message_id;

    try {
      const transcricao = await transcribeVoice(token, voice.file_id, openaiKey);
      const { asset, ohlc, analiseTexto } = await buildAnalysisWithAudio(assetKey, transcricao);
      const replyText = buildAnalysisReply(asset, ohlc, analiseTexto, baseUrl, true);

      const editParams = {
        chat_id: chatId,
        message_id: placeholderId,
        text: replyText,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      };

      if (placeholderId) {
        await tg(token, "editMessageText", editParams);
      } else {
        await tg(token, "sendMessage", { chat_id: chatId, text: replyText, parse_mode: "Markdown", disable_web_page_preview: true });
      }

      // Envia transcrição como nota para o analista conferir
      await tg(token, "sendMessage", {
        chat_id: chatId,
        text: `📝 *Transcrição do áudio:*\n_${escapeMd(transcricao)}_`,
        parse_mode: "Markdown",
      });
    } catch (err) {
      const errMsg = `❌ Falha ao processar áudio: ${err.message.slice(0, 300)}`;
      if (placeholderId) {
        await tg(token, "editMessageText", { chat_id: chatId, message_id: placeholderId, text: errMsg });
      } else {
        await tg(token, "sendMessage", { chat_id: chatId, text: errMsg });
      }
    }

    return new Response("ok", { status: 200 });
  }

  // ── Comandos de análise: /ibov, /win, /wdo, /analise IBOV ────────────────
  if (text) {
    const directMatch  = text.match(/^\/(ibov|win|wdo)\b/i);
    const verboseMatch = text.match(/^\/analise(?:_text|@\w+)?\s+(\w+)/i);
    const assetKey     = normalizeAssetKey(directMatch?.[1] || verboseMatch?.[1] || null);

    if (!assetKey) {
      // Não é comando: se houver ativo selecionado, trata o texto como comentário
      // de mercado (alternativa ao áudio — não depende do Whisper).
      if (!text.startsWith("/")) {
        const pendingAsset = lastAssetByChat.get(chatId) || null;
        if (pendingAsset) {
          await handleNarrative(token, chatId, pendingAsset, text, baseUrl);
          return new Response("ok", { status: 200 });
        }
      }
      await tg(token, "sendMessage", {
        chat_id: chatId,
        text: "Comando não reconhecido. Use /help para ver a lista de comandos.",
      });
      return new Response("ok", { status: 200 });
    }

    // Registra o ativo como o último selecionado (para mensagens de voz subsequentes)
    lastAssetByChat.set(chatId, assetKey);

    const placeholder = await tg(token, "sendMessage", {
      chat_id: chatId,
      text: `⏳ Coletando dados e gerando análise de *${escapeMd(ASSETS[assetKey].nome)}*...`,
      parse_mode: "Markdown",
    });
    const placeholderId = placeholder?.result?.message_id;

    try {
      const { asset, ohlc, analiseTexto, versions } = await buildAnalysis(assetKey);
      const replyText = buildAnalysisReply(asset, ohlc, analiseTexto, baseUrl, false, versions);

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

      // Instrui o analista que pode enviar narrativa por áudio ou texto
      const dica = openaiKey
        ? `🎙️ _Envie uma mensagem de voz *ou digite* seu comentário de mercado para gerar a análise com sua narrativa._`
        : `✍️ _Digite seu comentário de mercado para gerar a análise com sua narrativa._`;
      await tg(token, "sendMessage", {
        chat_id: chatId,
        text: dica,
        parse_mode: "Markdown",
      });
    } catch (err) {
      const errMsg = `❌ Falha ao gerar análise de ${assetKey}: ${err.message.slice(0, 300)}`;
      if (placeholderId) {
        await tg(token, "editMessageText", { chat_id: chatId, message_id: placeholderId, text: errMsg });
      } else {
        await tg(token, "sendMessage", { chat_id: chatId, text: errMsg });
      }
    }
  }

  return new Response("ok", { status: 200 });
}
