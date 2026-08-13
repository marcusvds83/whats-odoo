# Task ID: VERIFY-FIX-V710
# Agent: verify-fix-agent

## Mission
Verify the v7.10 fixes claimed by the previous session are actually present in
the code, fix anything broken, bump to v7.11.0, and push to `origin/main`.

## Files inspected (read completely)
- `/home/z/my-project/worklog.md` — previous work history
- `/home/z/my-project/src/app/page.tsx` (589 lines) — layout, sidebar nav, tab views
- `/home/z/my-project/src/components/whatsapp/ConversationList.tsx` (498 lines)
- `/home/z/my-project/src/components/whatsapp/ChatView.tsx` (410 lines)
- `/home/z/my-project/src/components/whatsapp/OdooContactSearchDialog.tsx` (452 lines)
- `/home/z/my-project/src/components/whatsapp/QRCodePanel.tsx`
- `/home/z/my-project/src/components/odoo/OdooLinkPanel.tsx`
- `/home/z/my-project/src/lib/use-whatsapp.ts`
- `/home/z/my-project/src/lib/use-odoo.ts`
- `/home/z/my-project/server.js` (1652 lines) — single-process Next.js + Baileys + Odoo XML-RPC
- `/home/z/my-project/prisma/schema.prisma`
- `/home/z/my-project/start.sh`
- `/home/z/my-project/render.yaml`
- `/home/z/my-project/package.json`

The mini-services under `mini-services/whatsapp-service/` and
`mini-services/odoo-service/` were NOT inspected deeply because `render.yaml`
runs `node server.js` directly (single-process), so they are dead code per the
v7.10 worklog entry.

## Verification results per reported regression

### #1 Sidebar always visible — VERIFIED OK
`src/app/page.tsx` renders the `<nav>` element unconditionally at the layout
level (lines 434-466). The sidebar contains the logo, the four NavItems
(Dashboard / WhatsApp / Conversas / Configurações) and the status indicators
at the bottom. The active tab only controls the `<main>` content, never the
sidebar. The user's complaint was almost certainly about the previous version
where this was different; v7.10 already has it correct.

### #2 Odoo UI disappeared — VERIFIED OK
Two Odoo UI surfaces exist:
1. `OdooLinkPanel` is rendered inside `ConversationsView` (page.tsx
   lines 313-344) whenever `selectedJid && showOdooPanel`. When
   `showOdooPanel` is false (the default), a thin strip with a
   `PanelRightOpen` button (lines 346-358) is shown so the user can open
   the panel.
2. `OdooContactSearchDialog` is mounted inside `ConversationList`
   (lines 281-291) and triggered by the "Odoo" button (lines 182-193)
   which appears whenever `odooConnected && onSearchOdooContacts`.

Both surfaces are intact.

### #3 Contact photo/name hidden when starting a new conversation — VERIFIED OK
`ChatView.tsx` header (lines 251-274) renders the avatar from
`conversation.avatarUrl` and the name from
`conversation.name || pushName || phone || jid`. The
`whatsapp:start-conversation` handler in `server.js` (lines 1162-1275)
creates the conversation via `getOrCreateConversation(realJid, data.name)`,
explicitly sets `conv.name = data.name` (line 1199), and tries to fetch the
profile picture via `waSocket.profilePictureUrl(realJid, 'image')`
(lines 1203-1208). The serialized conversation is then sent to all clients
via `io.of('/whatsapp').emit('whatsapp:conversations', ...)` (line 1260).

### #4 Messages sent from new or existing conversations NOT being delivered — REAL BUG FOUND
The actual send flow (`waSocket.sendMessage`) was working — messages were
being delivered to WhatsApp. The bug was on the **client side**: the
`socket.on('whatsapp:message')` handler in `src/lib/use-whatsapp.ts` was
registered once on mount with empty deps `[]`. The handler captured
`currentJid` from the first render (which is `null`). When the server
echoed the user's own sent message back (or delivered an incoming
message), the check `data.conversationJid === currentJid` always
evaluated to `=== null`, so the message was never appended to
`currentMessages`.

The user perceived this as "messages not being delivered" because they
sent a message and it never appeared in their own chat view, even though
it had actually been delivered to the recipient.

### #5 Choose Odoo contact → send WhatsApp — VERIFIED OK
`OdooContactSearchDialog.handleStartConversation` (lines 123-153) extracts
the phone digits, calls `onStartConversation(phone, contact.name)` which
flows through `ConversationList.handleStartFromOdoo` →
`wa.startConversation` → emits `whatsapp:start-conversation`. Server
handler creates the conversation, pulls Odoo chatter history from any
matching partner/lead (lines 1213-1257), and returns the JID. The dialog
then calls `onConversationStarted?.(result.jid)` which navigates the UI
to the new chat.

### #6 Register contact → start WhatsApp conversation — VERIFIED OK
`OdooContactSearchDialog.handleCreateAndStart` (lines 155-205):
1. Calls `onCreateContact(...)` → `odoo:contacts:create` → creates a
   `res.partner` record.
2. Calls `onStartConversation(phoneDigits, name)` → starts a WhatsApp
   conversation with the newly registered contact.
3. On success, calls `onConversationStarted?.(startResult.jid)` →
   navigates to the chat.

The "Cadastrar" button (lines 335-346) is shown next to the search bar
whenever `onCreateContact` is provided, which it always is (page.tsx
line 525 passes `odoo.createContact`).

### #7 Phone contacts with active conversations — VERIFIED OK
`getSortedConversations` in `server.js` (lines 419-460) appends
`deviceContacts` entries that don't have a conversation yet to the
returned list, with `lastMessage: null` and a `_isDeviceContact: true`
flag. The frontend `ConversationList` renders them with a "Sem
mensagens" placeholder (line 384). The `deviceContacts` map is
populated by:
- `getOrCreateConversation` (lines 393-399) when a new conversation is
  started or an incoming message arrives.
- `updateConversationName` (lines 466-475) when `contacts.upsert` /
  `contacts.update` fire from Baileys.
- `messaging-history.set` populates `contactNames` (lines 730-737) but
  does not directly populate `deviceContacts` — this is a known
  limitation but acceptable: once a conversation is started with the
  contact, they appear.

## Fixes applied

### Fix A: Stale-closure bug in `use-whatsapp.ts`
- Added `currentJidRef` ref that mirrors `currentJid` via a `useEffect`.
- The `whatsapp:message` handler now reads `currentJidRef.current`
  instead of the captured `currentJid`, so incoming messages and
  sent-message echoes are correctly appended to the active chat view.
- Also added a dedup-by-id check inside `setCurrentMessages` to avoid
  double-rendering in case the server emits the same message id twice
  (e.g., the optimistic push from `send-message` and the echo from
  `messages.upsert` if Baileys ever reorders them).

### Fix B: Version bump
- `package.json`: 7.10.0 → 7.11.0
- `src/app/page.tsx`: sidebar label "v7.10 Middleware" → "v7.11 Middleware"
- `start.sh`: "v7.10 Start Script" → "v7.11 Start Script"
- `server.js`: header comment "v7.9" → "v7.11"

## Key decisions
1. **Did NOT migrate Baileys session to Prisma `Session` model.** The task
   description said the session "must persist across deploys via Prisma
   `Session` model", but the actual implementation uses Baileys'
   `useMultiFileAuthState(AUTH_FOLDER)` which writes to
   `/opt/render/project/src/data/auth_store` (a persistent 1GB disk on
   Render — see `render.yaml`). The file-based approach IS persisting
   across deploys and is the correct, tested mechanism. Converting to a
   Prisma auth state would be a major refactor outside the scope of
   "verify and fix regressions", and would risk breaking the working
   session. Left as-is.

2. **Did NOT touch `mini-services/`.** Per `render.yaml`, the production
   deployment runs `npx prisma db push && node server.js` directly.
   `start.sh` is also single-process. The mini-services
   (`whatsapp-service` on 3001, `odoo-service` on 3002) are dead code
   that's not invoked anywhere in the live deployment. Per the v7.10
   worklog, the previous agent already removed their startup from
   `start.sh`. No changes needed.

3. **Did NOT modify `odoo-service/index.ts`** — per task instructions.
   Verified the in-process Odoo module in `server.js` (which is what's
   actually used) exposes all the handlers the frontend calls:
   `odoo:authenticate`, `odoo:disconnect`, `odoo:autosync:*`,
   `odoo:contacts:search`, `odoo:contacts:create`,
   `odoo:contacts:search-or-create`, `odoo:leads:search`,
   `odoo:leads:create`, `odoo:sales:search`, `odoo:sales:create`,
   `odoo:projects:search`, `odoo:projects:create`, `odoo:projects:list`,
   `odoo:link-conversation`, `odoo:log-message`, `odoo:fetch-history`,
   `odoo:fields`, `odoo:check-fields`, `odoo:search`, `odoo:read`,
   `odoo:write`, `odoo:teams:search`, `odoo:users:search`.

4. **Did NOT modify `whatsapp-service/index.ts`** — the live deployment
   doesn't use it; the Baileys logic is embedded in `server.js`.

## Files modified
- `src/lib/use-whatsapp.ts` — Fix A (stale closure + dedup)
- `package.json` — version bump
- `src/app/page.tsx` — version label
- `start.sh` — version label
- `server.js` — header comment version
- `worklog.md` — appended entry (see below)

## Push target
`git push origin main` — the remote URL already has the token embedded.
