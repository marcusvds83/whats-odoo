# Whats-Odoo • Configuração do Firebase no Render

## Resumo do problema

Você configurou as regras do Firestore corretamente (`allow read, write: if false` — só o Admin SDK acessa, o que é **exatamente** o que queremos). Porém:

- **O app no Render ainda não tem a variável `FIREBASE_SERVICE_ACCOUNT` configurada.**
- Sem essa variável, o app detecta que o Firebase "não está configurado" e silenciosamente cai no **SQLite** como fallback.
- Por isso nada aparece no Firestore: o app nem está tentando escrever lá.
- Por isso o QR Code não conecta: a sessão do WhatsApp fica só no sistema de arquivos, e quando o Render dorme/acorda, ela se corrompe e o Baileys fica preso tentando restaurar uma sessão morta.

A boa notícia: **todo o código já está pronto (v7.31)**. Falca apenas configurar a variável no Render.

---

## Passo a passo

### Passo 1 — Baixar a service account do Firebase

1. Acesse https://console.firebase.google.com/project/whats-odoo
2. No menu lateral: **⚙️ Project settings** (Configurações do projeto)
3. Aba **Service accounts** (Contas de serviço)
4. Clique no botão **Generate new private key** (Gerar nova chave privada)
5. Um arquivo JSON será baixado (ex: `whats-odoo-firebase-adminsdk-xxxxx-xxxxxxxxxx.json`)
6. Guarde esse arquivo — ele dá acesso total ao seu Firebase, então não compartilhe publicamente.

### Passo 2 — Validar localmente (opcional, mas recomendado)

```bash
# No terminal, dentro da pasta do projeto:
node scripts/validate-firebase.js /caminho/para/o/arquivo-baixado.json
```

Você deve ver:
```
✓ Service account carregada via: file:/caminho/...
  • project_id   : whats-odoo
  • client_email : firebase-adminsdk-xxxxx@whats-odoo.iam.gserviceaccount.com
  • private_key  : 1678 chars, starts with -----BEGIN PRIVATE KEY-----...

✓ private_key está bem-formada (BEGIN/END presentes)

✓ Firebase Admin SDK inicializado com sucesso
✓ Escrita de teste OK (_validate_test/connection_test)
✓ Leitura de teste OK
✓ Coleção "users" acessível — 0 usuário(s) encontrado(s)

✅ TUDO OK! Cole o JSON acima no Render e faça redeploy.
```

O script vai imprimir o JSON completo em **uma única linha** com os `\n` escapados corretamente. Use **esse** JSON (não o arquivo original multi-linha).

### Passo 3 — Configurar a variável no Render

1. Acesse https://dashboard.render.com → seu serviço `whats-odoo`
2. No menu lateral: **Environment** (Variáveis de ambiente)
3. Clique em **Add Environment Variable**
4. **Key:** `FIREBASE_SERVICE_ACCOUNT`
5. **Value:** cole o JSON completo (uma única linha, com `\n` escapados)
6. Clique em **Save changes**

> **Importante:** O Render preserva `\n` literais dentro de strings JSON. NÃO substitua `\n` por quebras de linha reais — o JSON tem que ficar em **uma linha só**.

### Passo 4 — Garantir que `JWT_SECRET` também está configurado

Na mesma tela de Environment do Render, verifique se existe:
- **Key:** `JWT_SECRET`
- **Value:** uma string longa e aleatória (mínimo 32 caracteres)

Se não tiver, crie uma:
```bash
openssl rand -hex 32
```

Sem `JWT_SECRET`, o app usa um valor inseguro hardcoded e as sessões podem não persistir corretamente entre restarts.

### Passo 5 — Redeploy

1. No Render: **Manual Deploy** → **Deploy latest commit** (ou aguarde o auto-deploy após salvar a variável)
2. Acompanhe os logs. Você deve ver:
   ```
   [firebase-admin] ✓ Initialized Firebase Admin via FIREBASE_SERVICE_ACCOUNT (project_id=whats-odoo)
   [firebase-admin] ✓ Firestore instance obtained — user records will persist in Firestore (survives deploys)
   [Server] v7.30: Auto-migrating SQLite users → Firestore (if needed)...
   [user-store] migrateAllFromSqlite: scanning N SQLite user(s)...
   [user-store] migrateAllFromSqlite: ✓ migrated user@email.com (id=...)
   [Server] ✓ Migrated N user(s) from SQLite to Firestore
   ```

### Passo 6 — Verificar via Admin Panel

1. Faça login como admin
2. Vá em **Usuários** (Users tab)
3. Você deve ver um banner verde: **"Firebase: configurado e inicializado"**
4. A contagem de usuários no Firestore deve bater com a contagem no SQLite
5. Se estiver com preguiça de logar, chame via curl:
   ```bash
   curl -H "Cookie: whats_odoo_session=<seu-cookie>" https://whats-odoo.onrender.com/api/auth/debug
   ```
   Retorna o status exato do Firebase: `configured`, `initialized`, `configSource`, `initError` (se houver), contagem no Firestore vs SQLite.

### Passo 7 — Conectar o WhatsApp (QR Code)

Depois de configurar o Firebase e fazer o redeploy:

1. Faça login como admin (ou usuário)
2. Vá na aba **WhatsApp**
3. Clique em **"Solicitar QR Code"**
4. Se o QR não aparecer em 10 segundos, clique em **"Limpar sessão salva e gerar novo QR"** (botão cinza embaixo)
5. Esse segundo botão apaga a sessão antiga (que provavelmente está corrompida no disco) e força o Baileys a gerar um QR novo
6. Escaneie com o WhatsApp

Depois disso, a sessão do WhatsApp fica salva no Firestore (`wa_auth_states/{userId}`). Mesmo que o Render durma ou faça deploy novo, a sessão vai ser restaurada automaticamente.

---

## Por que essas regras do Firestore estão corretas

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if false; // só o Admin SDK (servidor) acessa
    }
  }
}
```

**Isso está perfeito. Não mude.**

- O Admin SDK do Firebase (que usamos no `server.js` e nas API routes) **ignora as regras de segurança** — ele tem acesso total por padrão via service account.
- `allow read, write: if false` bloqueia apenas o **acesso direto pelo navegador** (que não usamos — o app nunca expõe credenciais de cliente).
- Isso é exatamente o padrão recomendado pelo Firebase para apps server-side.

> **Recomendação extra:** adicione a mesma regra para a coleção `wa_auth_states`:
> ```javascript
> match /wa_auth_states/{userId} {
>   allow read, write: if false;
> }
> ```

---

## Troubleshooting

### "Migração não rodou" / usuários não apareceram no Firestore

1. Verifique os logs do Render — procure por `[Server] v7.30: Auto-migrating SQLite users`
2. Se não aparecer, o `FIREBASE_SERVICE_ACCOUNT` não está sendo lido. Confirme no painel Environment do Render.
3. Se aparecer mas os usuários não migraram, chame manualmente:
   ```bash
   curl -X POST -H "Cookie: whats_odoo_session=<cookie-do-admin>" https://whats-odoo.onrender.com/api/auth/migrate-users
   ```

### "QR Code não aparece de jeito nenhum"

1. Clique em **"Limpar sessão salva e gerar novo QR"** (botão cinza embaixo do painel WhatsApp)
2. Se não existir esse botão, você está rodando uma versão antiga. Verifique `package.json` — deve ser `7.31.0`.
3. Olhe os logs do Render — procure por `[WA:<userId>] Force-new-QR: Cleared Firestore auth state` e `[WA:<userId>] QR Code generated`
4. Se Baileys travar, reinicie o serviço no Render (Manual Deploy → Clear cache & deploy)

### "Esqueci a senha do admin"

Use o endpoint de recuperação (requer `ADMIN_SETUP_TOKEN` configurado no Render):
```bash
curl -X POST https://whats-odoo.onrender.com/api/auth/setup-admin \
  -H "Content-Type: application/json" \
  -d '{"setupToken":"<token-configurado>","email":"admin@nytro.com.br","password":"novaSenha123","name":"Admin"}'
```

### Logs úteis para procurar

| Situação | Procure por |
|---|---|
| Firebase inicializou? | `[firebase-admin] ✓ Initialized Firebase Admin` |
| Migrou usuários? | `[Server] ✓ Migrated N user(s) from SQLite to Firestore` |
| WhatsApp usando Firestore? | `[WA-FS-Auth:<userId>] ✓ Using Firestore auth state` |
| QR gerado? | `[WA:<userId>] QR Code generated, sending to clients` |
| Erro de init Firebase? | `[firebase-admin] Firestore configured via ... but load failed` |

---

## Coleções usadas no Firestore

| Coleção | Documento | Conteúdo |
|---|---|---|
| `users` | `{id}` | email, passwordHash, role, isActive, odooUrl/odooDb/odooUsername/odooPassword, whatsappPhone, timestamps |
| `wa_auth_states` | `{userId}` | creds (Baileys), keys (Signal pre-keys), updatedAt — sessão do WhatsApp por usuário |

---

## Resumo executivo

1. **Regras do Firestore:** ✓ já estão corretas
2. **Banco de dados Firestore:** ✓ já existe (default)
3. **Falta apenas:** gerar a service account JSON no Firebase Console → colar como `FIREBASE_SERVICE_ACCOUNT` no Render → redeploy
4. Após o redeploy: login de usuários funciona, dados persistem no Firestore, sessão do WhatsApp sobrevive a sleeps/deploys
