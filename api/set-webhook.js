// Endpoint utilitário para REGISTRAR (ou remover) o webhook do bot na Telegram.
// Visite UMA VEZ após o deploy: https://SEU-APP.vercel.app/api/set-webhook
// Para remover: https://SEU-APP.vercel.app/api/set-webhook?action=delete

export const config = { runtime: "edge" };

export default async function handler(req) {
  const token = globalThis.process?.env?.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return json({ ok: false, error: "TELEGRAM_BOT_TOKEN não configurado" }, 500);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "set";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const webhookUrl = `${proto}://${host}/api/telegram`;

  if (action === "delete") {
    const r = await fetch(
      `https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`
    );
    return json({ action: "delete", result: await r.json() });
  }

  if (action === "info") {
    const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    return json({ action: "info", result: await r.json() });
  }

  // default: set
  const params = new URLSearchParams({
    url: webhookUrl,
    drop_pending_updates: "true",
    allowed_updates: JSON.stringify(["message"]),
  });
  const r = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook?${params}`
  );
  const result = await r.json();
  return json({
    action: "set",
    webhookUrl,
    result,
    nextStep: result.ok
      ? "Pronto! Abra o Telegram e mande /start para o bot."
      : "Algo deu errado. Veja o campo 'result' acima.",
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
