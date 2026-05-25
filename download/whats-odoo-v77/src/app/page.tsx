'use client'

import { useState, useMemo } from 'react'
import { useWhatsApp } from '@/lib/use-whatsapp'
import { useOdoo } from '@/lib/use-odoo'
import { QRCodePanel } from '@/components/whatsapp/QRCodePanel'
import { ConversationList } from '@/components/whatsapp/ConversationList'
import { ChatView } from '@/components/whatsapp/ChatView'
import { OdooConfigForm } from '@/components/odoo/OdooConfigForm'
import { OdooLinkPanel } from '@/components/odoo/OdooLinkPanel'
import { AutoSyncSettingsPanel } from '@/components/odoo/AutoSyncSettings'
import type { WhatsAppContact } from '@/lib/types'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  MessageCircle,
  Settings,
  LayoutDashboard,
  Smartphone,
  Link2,
  Wifi,
  WifiOff,
  Server,
  Users,
  TrendingUp,
  ShoppingCart,
  ClipboardList,
  PanelRightOpen,
  PanelRightClose,
  Zap,
  Loader2,
  BookOpen,
  Globe,
  RefreshCcw,
  Power,
  LogOut,
  Phone,
  Search,
  Download,
  BookUser,
} from 'lucide-react'

type Tab = 'dashboard' | 'whatsapp' | 'conversations' | 'contacts' | 'settings'

// ============================================================
// CONTACTS VIEW
// ============================================================
function ContactsView({
  contacts,
  waConnected,
  onLoadContacts,
  onStartConversation,
  onSelectConversation,
}: {
  contacts: WhatsAppContact[]
  waConnected: boolean
  onLoadContacts: () => Promise<{ success: boolean; contacts?: WhatsAppContact[] }>
  onStartConversation: (phone: string) => Promise<{ success: boolean; jid?: string; error?: string }>
  onSelectConversation: (jid: string) => void
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return contacts
    const query = searchQuery.toLowerCase()
    return contacts.filter(c =>
      (c.name && c.name.toLowerCase().includes(query)) ||
      (c.phone && c.phone.toLowerCase().includes(query))
    )
  }, [contacts, searchQuery])

  const handleLoad = async () => {
    setIsLoading(true)
    try { await onLoadContacts() } finally { setIsLoading(false) }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-4 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <BookUser className="size-5 text-primary" />
            <h2 className="font-semibold text-base">Contatos</h2>
            {contacts.length > 0 && (
              <Badge variant="outline" className="text-[10px]">{contacts.length}</Badge>
            )}
          </div>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={handleLoad} disabled={!waConnected || isLoading}>
            <RefreshCcw className={cn("size-3", isLoading && "animate-spin")} />
            Atualizar Contatos
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input placeholder="Buscar contatos por nome ou numero..." className="pl-9 h-9 text-sm bg-muted/50 border-transparent focus:border-border focus:bg-background" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <BookUser className="size-10 text-muted-foreground/40 mb-3" />
            {isLoading ? (
              <><Loader2 className="size-6 text-primary animate-spin mb-2" /><p className="text-sm font-medium text-muted-foreground">Carregando contatos...</p></>
            ) : (
              <><p className="text-sm font-medium text-muted-foreground">Nenhum contato carregado</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Clique em "Atualizar Contatos" para buscar os contatos do aparelho</p></>
            )}
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            <Search className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Nenhum resultado</p>
          </div>
        ) : (
          <div className="py-1">
            {filteredContacts.map((contact) => (
              <button key={contact.jid} className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                onClick={async () => {
                  if (contact.phone) {
                    const result = await onStartConversation(contact.phone)
                    if (result.success && result.jid) onSelectConversation(result.jid)
                  }
                }}>
                <Avatar className="size-10">
                  <AvatarFallback className="text-sm font-medium bg-muted text-muted-foreground">
                    {(contact.name || contact.phone || '?').split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{contact.name || 'Sem nome'}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="size-3" />{contact.phone}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

// ============================================================
// DASHBOARD VIEW
// ============================================================
function DashboardView({ waStatus, waMe, waConversations, odooStatus, onNavigate }: {
  waStatus: { connected: boolean; reason?: string; hasSession?: boolean }
  waMe: { id: string; name?: string; profilePicUrl?: string } | null
  waConversations: Array<{ jid: string; unreadCount: number; isGroup?: boolean }>
  odooStatus: { connected: boolean; url?: string; db?: string; username?: string }
  onNavigate: (tab: Tab) => void
}) {
  const totalUnread = waConversations.reduce((s, c) => s + c.unreadCount, 0)
  const groupCount = waConversations.filter(c => c.isGroup).length
  const contactCount = waConversations.filter(c => !c.isGroup).length

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Visao geral da integracao WhatsApp e Odoo</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="relative overflow-hidden">
          <div className={cn("absolute top-0 left-0 w-1 h-full", waStatus.connected ? "bg-emerald-500" : waStatus.hasSession ? "bg-amber-400" : "bg-red-400")} />
          <CardHeader className="pb-2 pl-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">WhatsApp</CardTitle>
              {waStatus.connected ? <Wifi className="size-4 text-emerald-500" /> : waStatus.hasSession ? <Loader2 className="size-4 text-amber-400 animate-spin" /> : <WifiOff className="size-4 text-red-400" />}
            </div>
          </CardHeader>
          <CardContent className="pl-5">
            <div className="text-2xl font-bold">{waStatus.connected ? 'Conectado' : waStatus.hasSession ? 'Reconectando...' : 'Desconectado'}</div>
            <p className="text-xs text-muted-foreground mt-1">
              {waStatus.connected ? (waMe?.name || waMe?.id?.split('@')[0] || 'Sessao ativa') : waStatus.hasSession ? 'Restaurando sessao salva' : 'Escaneie o QR Code'}
            </p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <div className={cn("absolute top-0 left-0 w-1 h-full", odooStatus.connected ? "bg-emerald-500" : "bg-amber-400")} />
          <CardHeader className="pb-2 pl-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">Odoo</CardTitle>
              <Server className={cn("size-4", odooStatus.connected ? "text-emerald-500" : "text-amber-400")} />
            </div>
          </CardHeader>
          <CardContent className="pl-5">
            <div className="text-2xl font-bold">{odooStatus.connected ? 'Conectado' : 'Desconectado'}</div>
            <p className="text-xs text-muted-foreground mt-1">{odooStatus.connected ? odooStatus.url : 'Configure as credenciais do Odoo'}</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-primary" />
          <CardHeader className="pb-2 pl-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">Conversas</CardTitle>
              <MessageCircle className="size-4 text-primary" />
            </div>
          </CardHeader>
          <CardContent className="pl-5">
            <div className="text-2xl font-bold">{contactCount}</div>
            <p className="text-xs text-muted-foreground mt-1">{totalUnread} nao lidas · {groupCount} grupos</p>
          </CardContent>
        </Card>

        <Card className="relative overflow-hidden">
          <div className={cn("absolute top-0 left-0 w-1 h-full", waStatus.connected && odooStatus.connected ? "bg-emerald-500" : "bg-muted")} />
          <CardHeader className="pb-2 pl-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">Integracao</CardTitle>
              <Link2 className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="pl-5">
            <div className="text-2xl font-bold">{waStatus.connected && odooStatus.connected ? 'Ativa' : 'Inativa'}</div>
            <p className="text-xs text-muted-foreground mt-1">{waStatus.connected && odooStatus.connected ? 'WhatsApp e Odoo conectados' : 'Conecte ambos para ativar'}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Acoes Rapidas</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {!waStatus.connected && !waStatus.hasSession && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('whatsapp')}>
                <Smartphone className="size-4 text-emerald-500" />
                <div className="text-left"><div className="text-sm font-medium">Conectar WhatsApp</div><div className="text-xs text-muted-foreground">Escanear QR Code</div></div>
              </Button>
            )}
            {!odooStatus.connected && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('settings')}>
                <Server className="size-4 text-amber-500" />
                <div className="text-left"><div className="text-sm font-medium">Configurar Odoo</div><div className="text-xs text-muted-foreground">Conectar ao servidor</div></div>
              </Button>
            )}
            {waStatus.connected && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('conversations')}>
                <MessageCircle className="size-4 text-primary" />
                <div className="text-left"><div className="text-sm font-medium">Ver Conversas</div><div className="text-xs text-muted-foreground">{waConversations.length} conversas</div></div>
              </Button>
            )}
            {waStatus.connected && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('contacts')}>
                <BookUser className="size-4 text-blue-500" />
                <div className="text-left"><div className="text-sm font-medium">Contatos do Aparelho</div><div className="text-xs text-muted-foreground">Ver e iniciar conversas</div></div>
              </Button>
            )}
            {waStatus.connected && odooStatus.connected && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('conversations')}>
                <Zap className="size-4 text-yellow-500" />
                <div className="text-left"><div className="text-sm font-medium">Criar Lead</div><div className="text-xs text-muted-foreground">A partir de conversa</div></div>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Como Funciona</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 text-sm font-bold">1</div>
              <div>
                <p className="text-sm font-medium">Conecte WhatsApp</p>
                <p className="text-xs text-muted-foreground mt-0.5">Escaneie o QR Code com o WhatsApp Business no celular. A sessao fica salva e reconecta automaticamente!</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-sm font-bold">2</div>
              <div>
                <p className="text-sm font-medium">Configure Odoo</p>
                <p className="text-xs text-muted-foreground mt-0.5">Insira as credenciais do seu Odoo (URL, banco, usuario e senha API)</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">3</div>
              <div>
                <p className="text-sm font-medium">Integre Conversas</p>
                <p className="text-xs text-muted-foreground mt-0.5">Crie Contatos no Odoo, depois Leads. Grupos aparecem para visualizacao mas nao geram leads automaticamente.</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ============================================================
// CONVERSATIONS VIEW
// ============================================================
function ConversationsView({
  conversations, selectedJid, selectedConversation, currentMessages,
  showOdooPanel, odooStatus, onSelectConversation, onSendMessage,
  onMarkRead, onToggleOdooPanel, onLinkConversation, onSearchContacts,
  onSearchLeads, onSearchSales, onSearchTasks, onCreateLead,
  onCreateContact, onCreateTask, onLogMessage, isSyncing,
  syncProgress, waConnected, onRefresh, onStartConversation, onForceFullSync,
}: {
  conversations: any[]
  selectedJid: string | null
  selectedConversation: any
  currentMessages: any[]
  showOdooPanel: boolean
  odooStatus: { connected: boolean }
  onSelectConversation: (jid: string) => void
  onSendMessage: (jid: string, text: string) => Promise<boolean>
  onMarkRead: (jid: string) => void
  onToggleOdooPanel: (show: boolean) => void
  onLinkConversation: any
  onSearchContacts: any
  onSearchLeads: any
  onSearchSales: any
  onSearchTasks: any
  onCreateLead: any
  onCreateContact: any
  onCreateTask: any
  onLogMessage: any
  isSyncing?: boolean
  syncProgress?: number
  waConnected?: boolean
  onRefresh?: () => Promise<{ success: boolean; refreshed?: number }>
  onStartConversation?: (phone: string) => Promise<{ success: boolean; jid?: string; error?: string }>
  onForceFullSync?: () => Promise<{ success: boolean; message?: string }>
}) {
  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className={cn("border-r bg-background transition-all duration-200 h-full", selectedJid ? "w-80 lg:w-96" : "w-full max-w-lg mx-auto")}>
        <ConversationList
          conversations={conversations} selectedJid={selectedJid} onSelect={onSelectConversation}
          isSyncing={isSyncing} syncProgress={syncProgress} waConnected={waConnected}
          onRefresh={onRefresh} onStartConversation={onStartConversation} onForceFullSync={onForceFullSync}
        />
      </div>

      {selectedJid && (
        <div className="flex-1 flex min-w-0">
          <div className={cn("flex-1 min-w-0 transition-all duration-200", showOdooPanel && "hidden lg:block")}>
            <ChatView conversation={selectedConversation} messages={currentMessages} onSendMessage={onSendMessage} onMarkRead={onMarkRead} />
          </div>

          {showOdooPanel && !selectedConversation?.isGroup && (
            <div className="w-80 lg:w-96 border-l bg-background flex flex-col">
              <div className="flex items-center justify-between px-3 py-2 border-b">
                <div className="flex items-center gap-2">
                  <Link2 className="size-4 text-primary" />
                  <span className="text-sm font-medium">Odoo</span>
                  {odooStatus.connected && <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Conectado</Badge>}
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => onToggleOdooPanel(false)}>
                  <PanelRightClose className="size-4" />
                </Button>
              </div>
              <OdooLinkPanel
                conversationJid={selectedJid}
                conversationPhone={selectedConversation?.phone || null}
                onLinkConversation={onLinkConversation}
                onSearchContacts={onSearchContacts} onSearchLeads={onSearchLeads}
                onSearchSales={onSearchSales} onSearchTasks={onSearchTasks}
                onCreateLead={onCreateLead} onCreateContact={onCreateContact}
                onCreateTask={onCreateTask} onLogMessage={onLogMessage}
                odooConnected={odooStatus.connected}
              />
            </div>
          )}

          {!showOdooPanel && !selectedConversation?.isGroup && (
            <div className="border-l bg-muted/30 flex flex-col items-center pt-3 px-1">
              <Button variant="ghost" size="icon" className="size-8" onClick={() => onToggleOdooPanel(true)} title="Abrir painel Odoo">
                <PanelRightOpen className="size-4" />
              </Button>
              <Separator className="my-2 w-4" />
              <div className="flex flex-col gap-1 py-2">
                <div className="flex size-7 items-center justify-center"><Users className="size-3.5 text-muted-foreground" /></div>
                <div className="flex size-7 items-center justify-center"><TrendingUp className="size-3.5 text-muted-foreground" /></div>
                <div className="flex size-7 items-center justify-center"><ShoppingCart className="size-3.5 text-muted-foreground" /></div>
                <div className="flex size-7 items-center justify-center"><ClipboardList className="size-3.5 text-muted-foreground" /></div>
              </div>
            </div>
          )}

          {selectedConversation?.isGroup && (
            <div className="border-l bg-muted/30 flex flex-col items-center justify-center px-3 py-4">
              <Users className="size-5 text-muted-foreground/40 mb-2" />
              <p className="text-[10px] text-muted-foreground/60 text-center max-w-[80px]">Grupos nao criam leads automaticamente</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// USER MANUAL
// ============================================================
function UserManual() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-primary" />
          <CardTitle className="text-base">Manual do Usuario</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Smartphone className="size-4 text-emerald-500" />Conectando o WhatsApp</h3>
          <div className="text-xs text-muted-foreground space-y-2 pl-6">
            <p>1. Clique na aba <strong>WhatsApp</strong> e depois em <strong>Solicitar QR Code</strong></p>
            <p>2. No celular, abra o WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
            <p>3. Aponte a camera para o QR Code exibido no middleware</p>
            <p>4. Pronto! Suas conversas serao carregadas automaticamente</p>
            <p className="text-emerald-600 dark:text-emerald-400 font-medium mt-1">Sua sessao fica salva! Reconecta automaticamente ao reabrir.</p>
          </div>
        </div>
        <Separator />
        <div className="space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2"><MessageCircle className="size-4 text-primary" />Conversas e Grupos</h3>
          <div className="text-xs text-muted-foreground space-y-2 pl-6">
            <p><strong>Contatos individuais</strong> — aparecem com nome e numero. Pode enviar mensagens e vincular ao Odoo.</p>
            <p><strong>Grupos</strong> — aparecem com nome do grupo. Grupos <strong>nao geram leads automaticamente</strong>.</p>
            <p><strong>Atualizar</strong> — Atualiza fotos de perfil e metadados.</p>
            <p><strong>Trazer do Aparelho</strong> — Sincroniza TODAS as conversas do celular. Use quando conversas nao aparecem.</p>
          </div>
        </div>
        <Separator />
        <div className="space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2"><BookUser className="size-4 text-blue-500" />Contatos</h3>
          <div className="text-xs text-muted-foreground space-y-2 pl-6">
            <p>Na aba <strong>Contatos</strong>, voce ve todos os contatos salvos no celular com nome e numero.</p>
            <p>Clique em <strong>Atualizar Contatos</strong> para buscar do aparelho.</p>
            <p>Clique em qualquer contato para <strong>iniciar conversa</strong> pelo WhatsApp.</p>
          </div>
        </div>
        <Separator />
        <div className="space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Server className="size-4 text-amber-500" />Integracao com Odoo</h3>
          <div className="text-xs text-muted-foreground space-y-2 pl-6">
            <p>1. Configure as credenciais do Odoo na aba <strong>Configuracoes</strong></p>
            <p>2. No painel Odoo ao lado de cada conversa, voce pode <strong>Criar Contato</strong> e depois <strong>Criar Lead</strong></p>
            <p>3. <strong>IMPORTANTE:</strong> Sempre crie o Contato PRIMEIRO, depois o Lead!</p>
            <p>4. A sincronizacao automatica ja faz isso: cria Contato primeiro, Lead depois.</p>
          </div>
        </div>
        <Separator />
        <div className="space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Zap className="size-4 text-yellow-500" />Sincronizacao Automatica</h3>
          <div className="text-xs text-muted-foreground space-y-2 pl-6">
            <p>Quando ativada, para cada nova mensagem recebida:</p>
            <p><strong>1. Criar Contato</strong> — Busca ou cria contato em res.partner com o numero WhatsApp</p>
            <p><strong>2. Criar Lead</strong> — Se for nova conversa, cria Lead no CRM com prefixo [WhatsApp]</p>
            <p><strong>3. Criar Atividade</strong> — Cria notificacao no lead sobre a mensagem</p>
          </div>
        </div>
        <Separator />
        <div className="space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Power className="size-4 text-red-500" />Desconectar vs Sair</h3>
          <div className="text-xs text-muted-foreground space-y-2 pl-6">
            <p><strong>Desconectar</strong> — Fecha conexao, sessao fica salva. Reconecta automaticamente.</p>
            <p><strong>Sair do WhatsApp</strong> — Remove sessao. Precisa escanear QR Code novamente.</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================
// NAV ITEMS
// ============================================================
function NavItem({ icon, label, active, onClick, badge }: {
  icon: React.ReactNode; label: string; active: boolean; onClick: () => void; badge?: string
}) {
  return (
    <button onClick={onClick} className={cn('w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm transition-colors', 'hover:bg-muted/80 focus-visible:outline-none focus-visible:bg-muted/80', active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground')}>
      <span className="shrink-0">{icon}</span>
      <span className="hidden lg:block flex-1 text-left truncate">{label}</span>
      {badge && <Badge className="size-5 p-0 flex items-center justify-center text-[10px] bg-emerald-500 text-white border-0">{badge === 'online' ? '\u25CF' : badge}</Badge>}
    </button>
  )
}

function StatusIndicator({ label, connected }: { label: string; connected: boolean }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
      <span className={cn('size-2 rounded-full shrink-0', connected ? 'bg-emerald-500' : 'bg-muted-foreground/30')} />
      <span className="hidden lg:block text-muted-foreground truncate">{label}</span>
      <span className="hidden lg:block ml-auto font-medium text-[10px]">{connected ? 'ON' : 'OFF'}</span>
    </div>
  )
}

// ============================================================
// MAIN PAGE
// ============================================================
export default function HomePage() {
  const wa = useWhatsApp()
  const odoo = useOdoo()

  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  const [selectedJid, setSelectedJid] = useState<string | null>(null)
  const [showOdooPanel, setShowOdooPanel] = useState(false)

  const selectedConversation = useMemo(() => {
    if (!selectedJid) return null
    return wa.conversations.find(c => c.jid === selectedJid) || null
  }, [selectedJid, wa.conversations])

  const handleSelectConversation = (jid: string) => {
    setSelectedJid(jid)
    wa.loadMessages(jid)
    wa.markRead(jid)
    setActiveTab('conversations')
  }

  const handleContactsTab = () => {
    setActiveTab('contacts')
    if (wa.contacts.length === 0 && wa.status.connected) wa.getAllContacts()
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <nav className="w-14 lg:w-56 border-r bg-muted/30 flex flex-col shrink-0">
        <div className="h-14 flex items-center px-3 lg:px-4 border-b">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <MessageCircle className="size-4" />
            </div>
            <div className="hidden lg:block">
              <p className="text-sm font-bold leading-tight">WA-Odoo</p>
              <p className="text-[10px] text-muted-foreground">v7.7 Middleware</p>
            </div>
          </div>
        </div>

        <div className="flex-1 py-2 space-y-1 px-2">
          <NavItem icon={<LayoutDashboard className="size-4" />} label="Dashboard" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} />
          <NavItem icon={<Smartphone className="size-4" />} label="WhatsApp" active={activeTab === 'whatsapp'} onClick={() => setActiveTab('whatsapp')} badge={wa.status.connected ? 'online' : undefined} />
          <NavItem icon={<MessageCircle className="size-4" />} label="Conversas" active={activeTab === 'conversations'} onClick={() => setActiveTab('conversations')} badge={wa.conversations.reduce((s, c) => s + c.unreadCount, 0) > 0 ? String(wa.conversations.reduce((s, c) => s + c.unreadCount, 0)) : undefined} />
          <NavItem icon={<BookUser className="size-4" />} label="Contatos" active={activeTab === 'contacts'} onClick={handleContactsTab} badge={wa.contacts.length > 0 ? String(wa.contacts.length) : undefined} />
          <NavItem icon={<Settings className="size-4" />} label="Configuracoes" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
        </div>

        <div className="p-2 border-t space-y-1">
          <StatusIndicator label="WhatsApp" connected={wa.status.connected} />
          <StatusIndicator label="Odoo" connected={odoo.status.connected} />
        </div>
      </nav>

      <main className="flex-1 flex flex-col overflow-hidden min-h-0">
        {activeTab === 'dashboard' && (
          <DashboardView waStatus={wa.status} waMe={wa.me} waConversations={wa.conversations} odooStatus={odoo.status} onNavigate={setActiveTab} />
        )}

        {activeTab === 'whatsapp' && (
          <div className="p-6 flex items-start justify-center min-h-full">
            <QRCodePanel qrCode={wa.qrCode} status={wa.status} me={wa.me} onRequestQR={wa.requestQR} onDisconnect={wa.disconnect} onLogout={wa.logout} isConnected={wa.status.connected} />
          </div>
        )}

        {activeTab === 'conversations' && (
          <div className="flex-1 min-h-0">
            <ConversationsView
              conversations={wa.conversations} selectedJid={selectedJid} selectedConversation={selectedConversation}
              currentMessages={wa.currentMessages} showOdooPanel={showOdooPanel} odooStatus={odoo.status}
              onSelectConversation={handleSelectConversation} onSendMessage={wa.sendMessage} onMarkRead={wa.markRead}
              onToggleOdooPanel={setShowOdooPanel} onLinkConversation={odoo.linkConversation}
              onSearchContacts={odoo.searchContacts} onSearchLeads={odoo.searchLeads}
              onSearchSales={odoo.searchSales} onSearchTasks={odoo.searchTasks}
              onCreateLead={odoo.createLead} onCreateContact={odoo.createContact}
              onCreateTask={odoo.createTask} onLogMessage={odoo.logMessage}
              isSyncing={wa.syncProgress?.isSyncing} syncProgress={wa.syncProgress?.progress}
              waConnected={wa.status.connected} onRefresh={wa.refreshConversations}
              onStartConversation={wa.startNewConversation} onForceFullSync={wa.forceFullSync}
            />
          </div>
        )}

        {activeTab === 'contacts' && (
          <div className="flex-1 min-h-0">
            <ContactsView contacts={wa.contacts} waConnected={wa.status.connected} onLoadContacts={wa.getAllContacts} onStartConversation={wa.startNewConversation} onSelectConversation={handleSelectConversation} />
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="p-6 max-w-2xl mx-auto space-y-6 overflow-y-auto">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Configuracoes</h1>
              <p className="text-muted-foreground text-sm mt-1">Configure as conexoes e a sincronizacao automatica</p>
            </div>
            <OdooConfigForm status={odoo.status} onAuthenticate={odoo.authenticate} onDisconnect={odoo.disconnect} isConnected={odoo.status.connected} />
            <AutoSyncSettingsPanel odooConnected={odoo.status.connected} settings={odoo.autoSyncSettings} onUpdateSettings={odoo.updateAutoSyncSettings} />
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Smartphone className="size-4 text-emerald-500" />
                  <CardTitle className="text-base">Status WhatsApp</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Conexao</span>
                  <Badge variant={wa.status.connected ? 'default' : 'outline'} className={wa.status.connected ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : ''}>
                    {wa.status.connected ? 'Conectado' : wa.status.hasSession ? 'Reconectando...' : 'Desconectado'}
                  </Badge>
                </div>
                {wa.status.hasSession && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Sessao salva</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium text-xs">Sim - reconexao automatica</span>
                  </div>
                )}
                {wa.me && (
                  <>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Numero</span>
                      <span className="font-mono text-xs">{wa.me.id?.split('@')[0]}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Nome</span>
                      <span>{wa.me.name || 'N/A'}</span>
                    </div>
                  </>
                )}
                <div className="flex gap-2">
                  <Button variant="outline" className="flex-1" onClick={() => setActiveTab('whatsapp')}>
                    {wa.status.connected ? <><Power className="size-4" /> Gerenciar</> : <><Smartphone className="size-4" /> Conectar</>}
                  </Button>
                </div>
              </CardContent>
            </Card>
            <UserManual />
          </div>
        )}
      </main>
    </div>
  )
}
