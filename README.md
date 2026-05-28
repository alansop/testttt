# Análise Técnica Automatizada — Genial Investimentos

Automação que gera diariamente (e a cada 15 min para intraday) páginas de análise técnica para **Ibovespa (IBOV)**, **Mini Índice (WIN)** e **Mini Dólar (WDO)**, com gráfico interativo do TradingView e texto redigido pelo Gemini seguindo o tom institucional CNPI-T. Inclui um **bot de Telegram** que responde a `/ibov`, `/win` e `/wdo` em tempo real.

> ⚠️ **Antes de qualquer commit, leia [SECURITY.md](SECURITY.md).** Credenciais foram expostas em chat e precisam ser rotacionadas.

## Arquitetura

```
                       ┌─────────────────────────────────┐
                       │  src/lib/analysis.mjs           │
                       │  • fetchYahooOHLC               │
                       │  • callGemini                   │
                       │  • buildAnalysis (orquestrador) │
                       └─────────┬───────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                                                  │
┌───────▼─────────┐                              ┌─────────▼─────────┐
│ src/generate.   │                              │ api/telegram.js   │
│ mjs (CRON)      │                              │ (Vercel Edge)     │
│                 │                              │                   │
│ GitHub Actions  │                              │ Webhook do bot    │
│ roda IBOV 18:30 │                              │ @alancnpi_bot     │
│ e WIN/WDO a     │                              │                   │
│ cada 15min      │                              │ /ibov /win /wdo   │
└───────┬─────────┘                              └───────────────────┘
        │
        ├──→ /public/*.html  ──→  GitHub Pages (24/7 grátis)
        ├──→ WordPress REST  ──→  (opcional)
        └──→ Telegram admin  ──→  notificação de execução
```

## Estrutura

```
testttt/
├── src/
│   ├── generate.mjs              ← entry point do cron
│   └── lib/
│       ├── analysis.mjs          ← lógica compartilhada (Yahoo+Gemini+OHLC)
│       └── prompts.mjs           ← FONTE DA VERDADE dos prompts CNPI-T
├── api/
│   ├── telegram.js               ← webhook do bot (Vercel Edge)
│   └── set-webhook.js            ← registra o webhook (use 1x após deploy)
├── templates/page.html           ← template visual com widget TradingView
├── public/
│   ├── index.html                ← landing page
│   ├── ibovespa.html             ← gerado pelo cron
│   ├── mini-indice.html          ← gerado pelo cron
│   └── mini-dolar.html           ← gerado pelo cron
├── n8n/workflow.json             ← workflow alternativo (n8n self-hosted)
├── .github/workflows/publish.yml ← cron 24/7 do GitHub Actions
├── vercel.json                   ← config do deploy Vercel
├── .env.example                  ← molde de credenciais
└── package.json
```

### Mapeamento dos ativos

| Ativo | Símbolo Yahoo (dados do texto) | Símbolo TradingView (gráfico) | Timeframe                              |
| ----- | ------------------------------ | ----------------------------- | -------------------------------------- |
| IBOV  | `^BVSP`                        | `BMFBOVESPA:IBOV`             | Gráfico Diário (1D)                    |
| WIN   | `^BVSP` (proxy do índice)      | `BMFBOVESPA:WIN1!`            | Intraday 15 minutos (M15)              |
| WDO   | `BRL=X` (proxy USD/BRL)        | `BMFBOVESPA:WDO1!`            | Intraday 15 minutos (M15)              |

> Yahoo Finance público não distribui ticks dos futuros B3 individuais. Usamos o ativo subjacente como proxy para o **texto** do Gemini; o **gráfico** ao usuário é o futuro real via TradingView. Quando você integrar uma API direta (Cedro/Profit/MT5), substitua `fetchYahooOHLC` em `src/lib/analysis.mjs`.

---

## Setup local (5 min)

```powershell
npm install
Copy-Item .env.example .env
# Edite .env com as credenciais NOVAS (após rotação)
npm run generate           # gera as 3 páginas em /public
```

Abra `public/ibovespa.html` no navegador para validar.

---

## Deploy 24/7 (escolha a combinação)

### Caminho recomendado: GitHub Pages + Vercel (ambos grátis)

| Serviço | Função | Hospeda |
| ------- | ------ | ------- |
| **GitHub Pages** | Serve os HTMLs gerados pelo cron | `https://SEU-USER.github.io/SEU-REPO/` |
| **Vercel Edge Functions** | Webhook do bot Telegram | `https://SEU-APP.vercel.app/api/telegram` |
| **GitHub Actions** | Executa o cron e dá push nos HTMLs | — |

### Passo 1 — GitHub Actions + Pages (cron das páginas)

1. Crie um repositório **privado** no GitHub e suba este projeto:
   ```powershell
   git init
   git add .
   git commit -m "feat: bootstrap análise técnica genial"
   git remote add origin https://github.com/SEU-USER/SEU-REPO.git
   git branch -M main
   git push -u origin main
   ```
2. Em **Settings → Secrets and variables → Actions → Secrets**, adicione:
   - `GEMINI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - (opcional) `WORDPRESS_URL`, `WORDPRESS_USER`, `WORDPRESS_APP_PASSWORD`, `WORDPRESS_PAGE_ID_IBOV`, `WORDPRESS_PAGE_ID_WIN`, `WORDPRESS_PAGE_ID_WDO`
3. Em **Settings → Variables → Actions → Repository variables**, adicione (opcional):
   - `PUBLIC_BASE_URL` = `https://SEU-USER.github.io/SEU-REPO`
4. Em **Settings → Pages**, em *Build and deployment* escolha **Deploy from a branch** → `gh-pages` → `/ (root)`.
5. Rode o workflow uma vez à mão para popular `gh-pages`: **Actions → Publicar Análise Técnica → Run workflow**.

URLs finais:
- Landing: `https://SEU-USER.github.io/SEU-REPO/`
- `https://SEU-USER.github.io/SEU-REPO/ibovespa.html`
- `https://SEU-USER.github.io/SEU-REPO/mini-indice.html`
- `https://SEU-USER.github.io/SEU-REPO/mini-dolar.html`

### Passo 2 — Vercel (bot Telegram interativo)

1. Acesse https://vercel.com/new e faça login **com a sua conta do GitHub**.
2. *Import* do repositório (o mesmo do passo 1).
3. **Não configure framework** — Vercel detecta o `vercel.json` automaticamente. Confirme:
   - Framework Preset: **Other**
   - Build Command: vazio
   - Output Directory: `public`
4. Em **Environment Variables**, adicione (Production + Preview):
   - `GEMINI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `PUBLIC_BASE_URL` (URL do seu GitHub Pages — opcional, gera link compartilhável nas respostas do bot)
5. Clique em **Deploy**.
6. Após o deploy ficar pronto, **abra UMA VEZ** no navegador:
   ```
   https://SEU-APP.vercel.app/api/set-webhook
   ```
   A resposta deve ser `{ "result": { "ok": true } }`. Esse endpoint registra na Telegram o webhook apontando pro seu bot.

7. **Teste**: abra o Telegram, procure `@alancnpi_bot`, mande `/start`. Em seguida `/ibov`. Deve responder em 3-8 segundos com a análise.

#### Comandos do bot

| Comando             | Ação |
| ------------------- | ---- |
| `/start`            | Mensagem de boas-vindas |
| `/help`             | Lista de comandos |
| `/ibov`             | Análise do Ibovespa (1D) |
| `/win`              | Análise do Mini Índice (M15) |
| `/wdo`              | Análise do Mini Dólar (M15) |
| `/analise IBOV`     | Sintaxe alternativa |

#### Endpoints utilitários (Vercel)

| URL                                        | Função |
| ------------------------------------------ | ------ |
| `/api/set-webhook`                         | Registra o webhook (use 1x após deploy) |
| `/api/set-webhook?action=info`             | Mostra qual webhook está ativo |
| `/api/set-webhook?action=delete`           | Remove o webhook (pausa o bot) |
| `/api/telegram` (GET)                      | Health check do bot |

---

## Alternativa: n8n self-hosted

Importe `n8n/workflow.json` no seu n8n (Cloud, Railway ou self-hosted). Configure as credenciais e env vars conforme o README dentro do JSON. Use esta opção se preferir orquestração visual ou já tiver n8n rodando.

---

## Customização do tom do texto

Edite [src/lib/prompts.mjs](src/lib/prompts.mjs). É o **único** lugar onde o system prompt e o user prompt vivem — mudança vale tanto para o cron quanto para o bot. Para um modelo mais robusto, troque `gemini-2.0-flash` por `gemini-2.0-pro` via `GEMINI_MODEL=gemini-2.0-pro` no `.env` (ou nos Secrets).

---

## Roadmap

- [x] Páginas estáticas com TradingView + texto Gemini
- [x] Agendamento autônomo 24/7 (GitHub Actions)
- [x] Notificação do admin via Telegram
- [x] **Bot Telegram interativo** (`/ibov`, `/win`, `/wdo`) — Vercel Edge
- [x] Landing page com 3 cards
- [ ] **Link compartilhável com OG image dinâmica** — gerar PNG via `@vercel/og` no path `/api/og?ativo=IBOV`.
- [ ] **UGC**: "poste sua análise" → Supabase + Next.js
- [ ] **Gamificação** (rank por volume médio) → integração com dados da corretora
- [ ] **CTA tracking** → UTM em `genialinvestimentos.com.br/abra-sua-conta/?utm_source=analise&utm_campaign={ativo}`

## Aviso regulatório

O texto gerado segue restrições CVM/CNPI: linguagem probabilística, sem recomendação direta, com disclaimer em todas as páginas e respostas do bot. Antes de publicar oficialmente sob o selo Genial, **valide o output do modelo nas primeiras semanas** e ajuste `src/lib/prompts.mjs` conforme orientação do compliance interno.
