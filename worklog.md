# Whats-Odoo Middleware Worklog

---
Task ID: 1
Agent: Main Agent
Task: Build Whats-Odoo v7.0 with all user-requested fixes

Work Log:
- Analyzed entire v6.0 codebase (whatsapp-service, odoo-service, frontend components)
- Researched Baileys WhatsApp library for proper conversation syncing
- Key findings: use `conversationTimestamp` for real timestamps, `isJidGroup()` for groups, `useMultiFileAuthState` for session persistence
- Rebuilt whatsapp-service with: real timestamps, group support, soft disconnect, session persistence, auto-reconnect
- Rebuilt odoo-service: removed autoPostMessages, kept contact/lead/activity creation
- Updated frontend: ConversationList with groups, ChatView with sender names, QRCodePanel with disconnect vs logout
- Updated types: added isGroup, groupName, senderName fields
- Updated use-whatsapp hook: added logout() function, fixed conversation sorting
- Updated use-odoo hook: removed autoPostMessages from AutoSyncSettings
- Updated AutoSyncSettings component: removed autoPostMessages toggle
- Added UserManual component in settings page
- Updated server.js bridge: added whatsapp:logout event relay
- Created v7.0 ZIP at /home/z/my-project/download/whats-odoo-v7.zip

Stage Summary:
- v7.0 ZIP created (75KB) at /home/z/my-project/download/whats-odoo-v7.zip
- All 11 user-requested fixes implemented
- Key architecture changes: real timestamps from WhatsApp, group chat support, persistent sessions
---
Task ID: v7.3
Agent: main
Task: Create Whats-Odoo v7.3 with new features (refresh conversations, new conversation by phone, contacts from device, force full sync)

Work Log:
- Analyzed v7.2 codebase thoroughly (server.ts, frontend components, hooks, types)
- Fixed OOM issue: start command now includes `npx prisma db push --skip-generate` (no more `next build` in start)
- Added 4 new socket.io events to server.ts:
  - `whatsapp:refresh-conversations` — Re-fetches profile pictures, group metadata, re-emits list
  - `whatsapp:start-conversation` — Validates phone number via onWhatsApp(), creates conversation
  - `whatsapp:get-contacts` — Returns all contacts from device (from contactNames map)
  - `whatsapp:force-full-sync` — Reconnects with syncFullHistory=true to fetch ALL conversations
- Updated use-whatsapp.ts with new actions: refreshConversations, startNewConversation, getAllContacts, forceFullSync, contacts state
- Updated ConversationList.tsx with action buttons: Atualizar, Trazer do Aparelho, + (new conversation)
- Created NewConversationDialog.tsx component for creating conversations by phone number
- Updated page.tsx with new "Contatos" tab showing contacts from device
- Updated types.ts with WhatsAppContact interface
- Updated render.yaml startCommand to match package.json

Stage Summary:
- v7.3 ZIP generated at /home/z/my-project/download/whats-odoo-v73.zip (75KB)
- All 5 user-requested features implemented
- OOM fix included (no next build in start command)
- Single-process architecture preserved (no websocket bridge errors)
---
Task ID: v7.7
Agent: main
Task: Build whats-odoo v7.7 with contact names from device, contacts sync fix, conversation sort fix, CSS fix

Work Log:
- Copied v7.6 as base for v7.7
- server.ts: Enhanced `resolveName()` to also check Baileys `store.contacts` directly for device-saved names (name + notify fields)
- server.ts: Added `loadNamesFromStore()` function that reads ALL contacts from `waSocket.store.contacts` and updates `contactNames` map + all conversation names
- server.ts: Added `loadNamesFromStore()` call after connection opens (3s delay) and after history sync completes (2s delay)
- server.ts: Enhanced `whatsapp:get-contacts` handler to read from Baileys store directly, then merge with contactNames map, then update ALL conversation names
- server.ts: Enhanced `whatsapp:refresh-conversations` handler to first load all names from Baileys store, then refresh avatars/metadata, and always update names (not just when empty)
- globals.css: Removed `@plugin "tailwindcss-animate"` which could cause Turbopack issues. Replaced with inline `@utility` definitions for all animation classes (animate-in, animate-out, fade-in-0, fade-out-0, zoom-in-95, zoom-out-95, slide-in-from-*, slide-out-to-*, etc.)
- package.json: Removed `tailwindcss-animate` dependency (no longer needed, inlined in CSS)
- Updated version to 7.7.0 in package.json and page.tsx
- Conversation sort is already newest-first (tB - tA) which is correct

Stage Summary:
- v7.7 addresses 3 user issues: (1) contact names from device, (2) contacts not updating, (3) CSS broken
- Key fix: Reading from Baileys `store.contacts` directly gives ALL device-saved names, not just those in conversations
- CSS fix: Inlined all animation utilities to avoid @plugin/@import resolution issues with Turbopack
- File: /home/z/my-project/download/whats-odoo-v77.zip (72K)
---
Task ID: 1
Agent: Main
Task: Fix v7.7 build error and contact name issues

Work Log:
- Analyzed build error: `@utility slide-in-from-top-\[48\%\]` defines invalid utility name in Tailwind CSS v4
- Root cause: Tailwind CSS v4 `@utility` directive requires alphanumeric names, no brackets/percentages
- Fixed globals.css: Replaced 4 invalid @utility names with valid alphanumeric alternatives
  - `slide-in-from-left-1\/2` → `slide-in-from-left-half`
  - `slide-in-from-top-\[48\%\]` → `slide-in-from-top-48pct`
  - `slide-out-to-left-1\/2` → `slide-out-to-left-half`
  - `slide-out-to-top-\[48\%\]` → `slide-out-to-top-48pct`
- Fixed server.ts contacts.upsert handler: Now also checks `contact.notify` (device saved name)
- Fixed server.ts contacts.update handler: Now also checks `update.notify` (device saved name)
- Enhanced auto-load of contact names: Now tries at 2s, 5s, and 10s after connection
- Verified conversation sort order is correct: `tB - tA` (newest first) in both server and frontend
- Created whats-odoo-v77.zip package

Stage Summary:
- CSS build error fixed by renaming 4 invalid @utility definitions
- Contact names now also sourced from `notify` field (device saved names)
- Auto-load contact names more aggressively (3 attempts post-connection)
- Conversation sort order confirmed correct (newest first)
- Package: /home/z/my-project/download/whats-odoo-v77.zip

---
Task ID: v7.10
Agent: main
Task: Fix missing Odoo/socket handlers and add new contact-start features

Work Log:
- Diagnosed root cause of "everything Odoo disappeared" + missing sidebar:
  - render.yaml runs `node server.js` directly (single-process)
  - server.js had embedded WA+Odoo logic BUT was missing 4 critical socket handlers
    that the frontend was calling (whatsapp:get-contacts, whatsapp:start-conversation,
    whatsapp:inject-history, odoo:fetch-history)
  - The mini-services in /mini-services/ were unused dead code (start.sh was never
    invoked by Render)
- Added deviceContacts Map to server.js with proper population in:
  - updateConversationName (now also writes to deviceContacts)
  - getOrCreateConversation (now also writes to deviceContacts)
  - Cleared on logout + DisconnectReason.loggedOut
- Added missing helpers: normalizePhoneToJid, getDeviceContactsList, stripHtml,
  pullOdooChatterIntoConversation (fetches mail.message records and merges them
  into local conversation with dedup by externalId + content/timestamp)
- Added 4 missing socket handlers to server.js:
  - whatsapp:get-contacts: returns deviceContacts phonebook (with optional filter)
  - whatsapp:start-conversation: normalizes phone, onWhatsApp check, creates conv,
    fetches profile pic, AND if Odoo is connected + phone matches a partner/lead,
    auto-pulls chatter history into the conversation + emits odoo:conversation:linked
  - whatsapp:inject-history: merges historical messages with dedup logic
  - odoo:fetch-history: reads mail.message records, returns WhatsApp-style msg objects
- Updated getSortedConversations to also include device contacts that don't have
  a conversation yet — they appear with "Sem mensagens" so the user can see all
  phone contacts in the Conversas tab and start chatting directly
- Updated OdooContactSearchDialog:
  - Added "Cadastrar" button next to search bar (when onCreateContact is provided)
  - New "Cadastrar novo contato" form with name/phone/email fields
  - On submit: creates Odoo contact via odoo:contacts:create, then starts WhatsApp
    conversation with the same phone number
- Updated ConversationList: added onCreateOdooContact prop, passed through to dialog
- Updated page.tsx ConversationsView: accept + forward onCreateOdooContact prop
- Updated start.sh to v7.10: removed mini-service startup (was dead code anyway)
- Bumped version to v7.10.0 in package.json and sidebar label
- Build test: npx next build succeeded
- Pushed to GitHub main branch (commit 32a02d3)

Stage Summary:
- Root cause of "Odoo disappeared": server.js was missing handlers the frontend
  was calling. All 4 handlers now implemented.
- Starting a conversation from an Odoo contact now ALSO pulls the Odoo chatter
  history automatically (if the phone matches a partner/lead) — so when the user
  comes back the next day, the previous conversation is restored from Odoo.
- "Cadastrar" button lets the user register a new Odoo contact AND start a
  WhatsApp conversation in one click.
- Device contacts (phone book) now appear in the Conversas tab even without
  prior messages — they show with "Sem mensagens" placeholder.
- Deploy will trigger automatically from the git push.
