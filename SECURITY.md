# Segurança — leia antes de qualquer commit

## Credenciais expostas em 26/05/2026

Durante a definição do projeto, três credenciais foram coladas em chat. Considere-as **comprometidas** e rotacione imediatamente:

| Credencial          | Onde rotacionar                                                              | Status     |
| ------------------- | ---------------------------------------------------------------------------- | ---------- |
| Telegram Bot Token  | Conversa com `@BotFather` → `/revoke` → `/token`                             | ⚠️ pendente |
| Gemini API Key      | https://aistudio.google.com/apikey → revogar chave antiga e gerar nova       | ⚠️ pendente |
| Telegram User ID    | Não é segredo em si, mas evite postar publicamente                           | informativo |

## Regras de operação

1. **Tudo que é segredo vai para `.env`.** O arquivo `.env` está no `.gitignore` e nunca deve ser commitado.
2. **`.env.example`** contém apenas placeholders — esse sim pode ser versionado.
3. **GitHub Actions** lê as credenciais via *Repository Secrets* (Settings → Secrets and variables → Actions). Adicione:
   - `GEMINI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `WORDPRESS_URL`, `WORDPRESS_USER`, `WORDPRESS_APP_PASSWORD` (opcionais)
4. **n8n**: armazene credenciais nos nós de credencial nativos, nunca em campos de texto livre.
5. **Logs**: o script nunca imprime o valor das chaves — apenas o nome da variável faltante.

## Checklist antes do primeiro `git push`

- [ ] Bot Telegram rotacionado
- [ ] Gemini API key rotacionada
- [ ] `.env` existe localmente, mas **não** aparece em `git status`
- [ ] `git log -p` não contém nenhuma string `AIza` nem token Telegram
- [ ] Repositório é **privado** (recomendado enquanto contém IDs e configurações internas)
