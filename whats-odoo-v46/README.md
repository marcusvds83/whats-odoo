# WhatsApp-Odoo Middleware

Middleware de integracao WhatsApp Business com Odoo SaaS (CRM, Vendas, Projetos e Contatos).

## Arquitetura

```
┌──────────────────┐     Socket.io      ┌──────────────────┐     Socket.io      ┌──────────────────┐
│   Next.js SPA    │ ◄──────────────► │  WhatsApp Service │ ◄──────────────► │   Odoo Service    │
│   (Porta 3000)   │                   │   (Porta 3001)   │                   │   (Porta 3002)   │
│                  │                   │   Baileys/WA Web  │                   │   XML-RPC        │
└──────────────────┘                   └──────────────────┘                   └──────────────────┘
        │                                      │                                      │
        │                                      │                                      │
        ▼                                      ▼                                      ▼
   Browser UI                         WhatsApp Business                    Odoo SaaS
   Dashboard, Chat,                   QR Code Auth,                       CRM Leads,
   Configuracoes                      Send/Receive Msgs                   res.partner,
                                                                           sale.order,
                                                                           project.task
```

## Funcionalidades

- **WhatsApp via QR Code**: Escaneie o QR Code com o WhatsApp Business para conectar
- **Chat em tempo real**: Envie e receba mensagens WhatsApp pelo navegador
- **Integracao Odoo**: Conecte ao Odoo SaaS via XML-RPC
- **Auto-Sync**: Cria automaticamente Contatos, Leads, mensagens no Chatter e Atividades no Odoo
- **Vinculacao manual**: Vincule conversas a Contatos, Leads, Vendas e Tarefas
- **Smart Field Detection**: Detecta automaticamente campos customizados de WhatsApp no Odoo

## Como funciona no Odoo

Quando uma mensagem WhatsApp chega:

1. **Contato criado** em `res.partner` com o numero de telefone (se auto-create ativado)
2. **Lead criado** no CRM vinculado ao contato (se auto-create ativado)
3. **Mensagem registrada** no Chatter do Lead/Contato (igual mensagens internas do Odoo)
4. **Atividade de notificacao** criada para a primeira mensagem de cada lead

Tudo aparece nativamente no Odoo - no CRM, no Chatter, nas Atividades. Nao precisa instalar modulo customizado no Odoo.

## Deploy no Render

### 1. Criar repositorio no GitHub

```bash
# Inicializar git (se ainda nao fez)
git init
git add .
git commit -m "Initial commit - WhatsApp-Odoo Middleware"

# Adicionar remote e push
git remote add origin https://github.com/SEU-USUARIO/whats-odoo.git
git push -u origin main
```

### 2. Criar aplicacao no Render

1. Acesse [render.com](https://render.com) e faca login
2. Clique em **New** > **Web Service**
3. Conecte seu repositorio GitHub
4. O Render vai detectar o `render.yaml` automaticamente
5. Configure as variaveis de ambiente:
   - `DATABASE_URL`: Ser preenchido automaticamente pelo PostgreSQL do Render
   - `ODOO_SERVICE_URL`: `http://localhost:3002`

### 3. Configurar Odoo

Na tela de Configuracoes do middleware:
- **URL**: URL do seu Odoo SaaS (ex: `https://sua-instancia.odoo.com`)
- **Banco**: Nome do banco de dados Odoo
- **Usuario**: Email do usuario Odoo
- **Senha**: API Key ou senha do usuario

## Desenvolvimento Local

### Prerequisitos

- Node.js 18+ ou Bun
- npm ou bun

### Instalacao

```bash
# Instalar dependencias
npm install
cd mini-services/whatsapp-service && npm install && cd ../..
cd mini-services/odoo-service && npm install && cd ../..

# Configurar banco de dados
cp .env.example .env
npx prisma db push
npx prisma generate

# Build do Next.js
npm run build
```

### Rodar

```bash
# Terminal 1 - WhatsApp Service (porta 3001)
npx tsx mini-services/whatsapp-service/index.ts

# Terminal 2 - Odoo Service (porta 3002)
npx tsx mini-services/odoo-service/index.ts

# Terminal 3 - Next.js Frontend (porta 3000)
npm run dev
```

Acesse: http://localhost:3000

## Estrutura do Projeto

```
whats-odoo/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Pagina principal (Dashboard, WA, Conversas, Settings)
│   │   ├── layout.tsx            # Layout raiz
│   │   ├── globals.css           # Estilos globais (Tailwind)
│   │   └── api/route.ts          # API route
│   ├── components/
│   │   ├── whatsapp/
│   │   │   ├── QRCodePanel.tsx   # Painel de QR Code para conectar WhatsApp
│   │   │   ├── ChatView.tsx      # Interface de chat com mensagens
│   │   │   └── ConversationList.tsx # Lista de conversas
│   │   ├── odoo/
│   │   │   ├── OdooConfigForm.tsx    # Formulario de conexao Odoo
│   │   │   ├── OdooLinkPanel.tsx     # Painel de vinculacao de registros
│   │   │   ├── AutoSyncSettings.tsx  # Configuracoes de auto-sync
│   │   │   └── OdooRecordCard.tsx    # Card de registro Odoo
│   │   └── ui/                   # Componentes shadcn/ui
│   ├── lib/
│   │   ├── use-whatsapp.ts       # Hook Socket.io WhatsApp
│   │   ├── use-odoo.ts           # Hook Socket.io Odoo
│   │   ├── types.ts              # Tipos TypeScript
│   │   ├── db.ts                 # Prisma client
│   │   └── utils.ts              # Utilitarios (cn)
│   └── hooks/
│       ├── use-mobile.ts         # Hook mobile
│       └── use-toast.ts          # Hook toast
├── mini-services/
│   ├── whatsapp-service/
│   │   ├── index.ts              # Servico WhatsApp (Baileys + Socket.io)
│   │   ├── package.json
│   │   └── Dockerfile
│   └── odoo-service/
│       ├── index.ts              # Servico Odoo (XML-RPC + Socket.io)
│       ├── package.json
│       └── Dockerfile
├── prisma/
│   └── schema.prisma             # Schema do banco de dados
├── public/
│   └── logo.svg
├── render.yaml                   # Configuracao de deploy no Render
├── docker-compose.yml            # Docker Compose para dev local
├── package.json                  # Dependencias e scripts
├── .env.example                  # Exemplo de variaveis de ambiente
└── .gitignore
```

## Variaveis de Ambiente

| Variavel | Descricao | Default |
|----------|-----------|---------|
| `DATABASE_URL` | URL do banco de dados | `file:./dev.db` |
| `NODE_ENV` | Ambiente | `development` |
| `ODOO_SERVICE_URL` | URL do servico Odoo | `http://localhost:3002` |
| `PORT` | Porta do servidor | `3000` |

## Tecnologias

- **Next.js 16** - Frontend React
- **Tailwind CSS 4** - Estilizacao
- **shadcn/ui** - Componentes UI
- **Socket.io** - Comunicacao real-time
- **Baileys** - WhatsApp Web API
- **XML-RPC** - Conexao Odoo SaaS
- **Prisma** - ORM do banco de dados
- **SQLite** - Banco local (PostgreSQL no Render)
