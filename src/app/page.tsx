'use client'

import { useState, useMemo, useEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useWhatsApp } from '@/lib/use-whatsapp'
import { useOdoo } from '@/lib/use-odoo'
import { useAuth } from '@/lib/auth-context'
import { QRCodePanel } from '@/components/whatsapp/QRCodePanel'
import { ConversationList } from '@/components/whatsapp/ConversationList'
import { ChatView } from '@/components/whatsapp/ChatView'
import { OdooConfigForm } from '@/components/odoo/OdooConfigForm'
import { OdooLinkPanel } from '@/components/odoo/OdooLinkPanel'
import { AutoSyncSettingsPanel } from '@/components/odoo/AutoSyncSettings'
import { UsersPanel } from '@/components/admin/UsersPanel'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
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
  AlertCircle,
  CheckCircle2,
  LogOut,
} from 'lucide-react'

type Tab = 'dashboard' | 'whatsapp' | 'conversations' | 'settings' | 'users'

function DashboardView({
  waStatus,
  waMe,
  waConversations,
  odooStatus,
  onNavigate,
}: {
  waStatus: { connected: boolean; reason?: string; hasSession?: boolean }
  waMe: { id: string; name?: string; profilePicUrl?: string } | null
  waConversations: Array<{ jid: string; unreadCount: number }>
  odooStatus: { connected: boolean; url?: string; db?: string; username?: string }
  onNavigate: (tab: Tab) => void
}) {
  const totalUnread = waConversations.reduce((s, c) => s + c.unreadCount, 0)

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Visao geral da integracao WhatsApp e Odoo
        </p>
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
              {waStatus.connected ? (waMe?.name || waMe?.id?.split('@')[0] || 'Sessao ativa') : waStatus.hasSession ? 'Restaurando sessao salva' : 'Escaneie o QR Code para conectar'}
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
            <p className="text-xs text-muted-foreground mt-1">
              {odooStatus.connected ? odooStatus.url : 'Configure as credenciais do Odoo'}
            </p>
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
            <div className="text-2xl font-bold">{waConversations.length}</div>
            <p className="text-xs text-muted-foreground mt-1">{totalUnread} nao lidas</p>
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
            <p className="text-xs text-muted-foreground mt-1">
              {waStatus.connected && odooStatus.connected ? 'WhatsApp e Odoo conectados' : 'Conecte ambos para ativar'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Acoes Rapidas</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {!waStatus.connected && !waStatus.hasSession && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('whatsapp')}>
                <Smartphone className="size-4 text-emerald-500" />
                <div className="text-left">
                  <div className="text-sm font-medium">Conectar WhatsApp</div>
                  <div className="text-xs text-muted-foreground">Escanear QR Code</div>
                </div>
              </Button>
            )}
            {!odooStatus.connected && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('settings')}>
                <Server className="size-4 text-amber-500" />
                <div className="text-left">
                  <div className="text-sm font-medium">Configurar Odoo</div>
                  <div className="text-xs text-muted-foreground">Conectar ao servidor</div>
                </div>
              </Button>
            )}
            {waStatus.connected && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('conversations')}>
                <MessageCircle className="size-4 text-primary" />
                <div className="text-left">
                  <div className="text-sm font-medium">Ver Conversas</div>
                  <div className="text-xs text-muted-foreground">{waConversations.length} conversas ativas</div>
                </div>
              </Button>
            )}
            {waStatus.connected && odooStatus.connected && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('conversations')}>
                <Zap className="size-4 text-yellow-500" />
                <div className="text-left">
                  <div className="text-sm font-medium">Criar Lead</div>
                  <div className="text-xs text-muted-foreground">A partir de conversa</div>
                </div>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Como Funciona</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 text-sm font-bold">1</div>
              <div>
                <p className="text-sm font-medium">Conecte WhatsApp</p>
                <p className="text-xs text-muted-foreground mt-0.5">Escaneie o QR Code com o WhatsApp Business no celular para vincular sua conta. A sessao fica salva automaticamente!</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 text-sm font-bold">2</div>
              <div>
                <p className="text-sm font-medium">Configure Odoo</p>
                <p className="text-xs text-muted-foreground mt-0.5">Insira as credenciais do seu Odoo SaaS (URL, banco, usuario e senha)</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">3</div>
              <div>
                <p className="text-sm font-medium">Integre Conversas</p>
                <p className="text-xs text-muted-foreground mt-0.5">Vincule conversas a Contatos, Leads, Vendas e Projetos do Odoo diretamente</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ConversationsView({
  conversations,
  selectedJid,
  selectedConversation,
  currentMessages,
  showOdooPanel,
  odooStatus,
  onSelectConversation,
  onSendMessage,
  onSendMedia,
  onSendMediaBase64,
  onMarkRead,
  onToggleOdooPanel,
  onLinkConversation,
  onSearchContacts,
  onSearchLeads,
  onSearchSales,
  onSearchTasks,
  onCreateLead,
  onCreateContact,
  onCreateTask,
  onLogMessage,
  isSyncing,
  syncProgress,
  onGetContacts,
  onStartConversation,
  onFetchOdooHistory,
  onInjectHistory,
  linkedOdooRecords,
  onCreateOdooContact,
  onDeleteConversation,
  onRefreshData,
}: {
  conversations: any[]
  selectedJid: string | null
  selectedConversation: any
  currentMessages: any[]
  showOdooPanel: boolean
  odooStatus: { connected: boolean }
  onSelectConversation: (jid: string) => void
  onSendMessage: (jid: string, text: string) => Promise<boolean>
  onSendMedia?: (jid: string, file: File, caption?: string) => Promise<{ success: boolean; error?: string }>
  onSendMediaBase64?: (jid: string, opts: { type: 'image' | 'audio' | 'video' | 'document'; base64: string; mimeType: string; fileName?: string; caption?: string }) => Promise<{ success: boolean; error?: string }>
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
  onGetContacts?: (query?: string) => Promise<{ success: boolean; data?: any[]; error?: string }>
  onStartConversation?: (phone: string, name?: string) => Promise<{ success: boolean; jid?: string; error?: string }>
  onFetchOdooHistory?: (model: string, recordId: number) => Promise<{ success: boolean; data?: any[]; error?: string }>
  onInjectHistory?: (jid: string, messages: any[]) => Promise<{ success: boolean; added?: number; skipped?: number; error?: string }>
  linkedOdooRecords?: Array<{ model: string; recordId: number; recordName?: string }>
  onCreateOdooContact?: (data: { name: string; phone?: string; mobile?: string; whatsapp?: string; email?: string }) => Promise<{ success: boolean; id?: number; error?: string }>
  onDeleteConversation?: (jid: string) => Promise<{ success: boolean; error?: string }>
  onRefreshData?: () => Promise<{ success: boolean; chatsFetched?: number; contactsFetched?: number; error?: string }>
}) {
  // Build conversation history payload (for Odoo lead creation)
  const conversationHistory = useMemo(() => {
    return currentMessages.map(m => ({
      fromMe: m.fromMe,
      textContent: m.textContent,
      mediaType: m.mediaType,
      timestamp: m.timestamp,
    }))
  }, [currentMessages])

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* Conversation list — always visible, takes full width when no conversation is selected */}
      <div className={cn(
        "border-r bg-background transition-all duration-200 h-full shrink-0",
        selectedJid ? "w-72 lg:w-80 xl:w-96" : "w-full max-w-lg mx-auto"
      )}>
        <ConversationList
          conversations={conversations}
          selectedJid={selectedJid}
          onSelect={onSelectConversation}
          isSyncing={isSyncing}
          syncProgress={syncProgress}
          onGetContacts={onGetContacts}
          odooConnected={odooStatus.connected}
          onSearchOdooContacts={onSearchContacts}
          onStartConversation={onStartConversation}
          onCreateOdooContact={onCreateOdooContact}
          onDeleteConversation={onDeleteConversation}
          onRefreshData={onRefreshData}
        />
      </div>

      {selectedJid && (
        <div className="flex-1 flex min-w-0">
          {/* Chat view — shrinks (but never hides) to make room for Odoo panel */}
          <div className="flex-1 min-w-0 transition-all duration-200">
            <ChatView
              conversation={selectedConversation}
              messages={currentMessages}
              onSendMessage={onSendMessage}
              onSendMedia={onSendMedia}
              onSendMediaBase64={onSendMediaBase64}
              onMarkRead={onMarkRead}
              odooConnected={odooStatus.connected}
              odooLinkedRecords={linkedOdooRecords}
              onFetchOdooHistory={onFetchOdooHistory}
              onInjectHistory={onInjectHistory}
              onDeleteConversation={onDeleteConversation ? (jid) => {
                // The actual delete is handled by the parent (wa.deleteConversation),
                // here we just trigger the same confirmation flow as the list.
                onDeleteConversation(jid)
              } : undefined}
            />
          </div>

          {/* Right side: collapsible Odoo panel — when open, it takes its own column, never overlapping the chat */}
          {showOdooPanel ? (
            <div className="w-72 lg:w-80 xl:w-96 border-l bg-background flex flex-col shrink-0">
              <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Link2 className="size-4 text-primary shrink-0" />
                  <span className="text-sm font-medium truncate">Odoo</span>
                  {odooStatus.connected && (
                    <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200 shrink-0">Conectado</Badge>
                  )}
                </div>
                <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => onToggleOdooPanel(false)} title="Recolher painel Odoo">
                  <PanelRightClose className="size-4" />
                </Button>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <OdooLinkPanel
                  conversationJid={selectedJid}
                  conversationPhone={selectedConversation?.phone || null}
                  onLinkConversation={onLinkConversation}
                  onSearchContacts={onSearchContacts}
                  onSearchLeads={onSearchLeads}
                  onSearchSales={onSearchSales}
                  onSearchTasks={onSearchTasks}
                  onCreateLead={onCreateLead}
                  onCreateContact={onCreateContact}
                  onCreateTask={onCreateTask}
                  onLogMessage={onLogMessage}
                  odooConnected={odooStatus.connected}
                  conversationHistory={conversationHistory}
                />
              </div>
            </div>
          ) : (
            /* Collapsed state — a slim vertical strip with an "open" button */
            <div className="border-l bg-muted/30 flex flex-col items-center pt-3 px-1 shrink-0 w-12">
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
        </div>
      )}
    </div>
  )
}

function NavItem({ icon, label, active, onClick, badge, collapsed }: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  badge?: string
  collapsed?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm transition-colors',
        'hover:bg-muted/80 focus-visible:outline-none focus-visible:bg-muted/80',
        active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground',
      )}
      title={collapsed ? label : undefined}
    >
      <span className="shrink-0 mx-auto lg:mx-0">{icon}</span>
      {!collapsed && <span className="hidden lg:block flex-1 text-left truncate">{label}</span>}
      {badge && !collapsed && (
        <Badge className="size-5 p-0 flex items-center justify-center text-[10px] bg-emerald-500 text-white border-0">
          {badge === 'online' ? '\u25CF' : badge}
        </Badge>
      )}
      {badge && collapsed && (
        <Badge className="hidden lg:flex absolute top-0 right-0 size-2 p-0 bg-emerald-500 border-0" />
      )}
    </button>
  )
}

function StatusIndicator({ label, connected, collapsed }: { label: string; connected: boolean; collapsed?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-xs" title={collapsed ? `${label}: ${connected ? 'ON' : 'OFF'}` : undefined}>
      <span className={cn('size-2 rounded-full shrink-0 mx-auto lg:mx-0', connected ? 'bg-emerald-500' : 'bg-muted-foreground/30')} />
      {!collapsed && <span className="hidden lg:block text-muted-foreground truncate">{label}</span>}
      {!collapsed && <span className="hidden lg:block ml-auto font-medium text-[10px]">{connected ? 'ON' : 'OFF'}</span>}
    </div>
  )
}

export default function HomePage() {
  const wa = useWhatsApp()
  const odoo = useOdoo()
  const { user, isLoading: authLoading, isAuthenticated, isAdmin, logout } = useAuth()
  const router = useRouter()

  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  const [selectedJid, setSelectedJid] = useState<string | null>(null)
  const [showOdooPanel, setShowOdooPanel] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // v7.22: Auth guard — if not authenticated, redirect to /login
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace('/login')
    }
  }, [authLoading, isAuthenticated, router])

  // v7.29.3: ALL hooks must be declared BEFORE any early return — otherwise
  // React's rules of hooks are violated (hooks called in different orders
  // between renders) and the page crashes with "Application error: a
  // client-side exception has occurred". This was the root cause of the
  // "neither admin nor user can send/receive messages" bug: the page would
  // crash on first interaction once auth state flipped, taking down the
  // entire WhatsApp UI with it.
  const selectedConversation = useMemo(() => {
    if (!selectedJid) return null
    return wa.conversations.find(c => c.jid === selectedJid) || null
  }, [selectedJid, wa.conversations])

  // Derive linked Odoo records for the currently selected conversation
  // Used by the ChatView's "Pull from Odoo" button
  const linkedOdooRecords = useMemo(() => {
    if (!selectedJid) return undefined
    const links = odoo.conversationLinks.get(selectedJid)
    if (!links || links.length === 0) return undefined
    return links
  }, [selectedJid, odoo.conversationLinks])

  // Show loading spinner while auth state is being determined.
  // v7.29.3: This early return MUST come AFTER all hook declarations
  // (useWhatsApp, useOdoo, useAuth, useState, useEffect, useMemo) — otherwise
  // React throws "Rendered more hooks than during the previous render" /
  // "Application error: a client-side exception has occurred".
  if (authLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-8 animate-spin text-emerald-600" />
          <p className="text-sm text-muted-foreground">Carregando...</p>
        </div>
      </div>
    )
  }

  const handleSelectConversation = (jid: string) => {
    setSelectedJid(jid)
    wa.loadMessages(jid)
    wa.markRead(jid)
    setActiveTab('conversations')
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <nav className={cn(
        "border-r bg-muted/30 flex flex-col shrink-0 max-h-screen transition-all duration-200",
        sidebarCollapsed ? "w-14" : "w-14 lg:w-56"
      )}>
        <div className="h-14 flex items-center px-3 lg:px-4 border-b">
          <div className="flex items-center gap-2">
            <Image
              src="/logo.png"
              alt="Whats-Odoo"
              width={32}
              height={32}
              className="size-8 rounded-lg object-cover shrink-0"
              priority
            />
            {!sidebarCollapsed && (
              <div className="hidden lg:block min-w-0">
                <p className="text-sm font-bold leading-tight truncate">Whats-Odoo</p>
                <p className="text-[10px] text-muted-foreground">v7.29.4 Msg extract fix</p>
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 ml-auto hidden lg:flex shrink-0"
            onClick={() => setSidebarCollapsed(c => !c)}
            title={sidebarCollapsed ? 'Expandir menu' : 'Recolher menu'}
          >
            {sidebarCollapsed ? <PanelRightOpen className="size-4" /> : <PanelRightClose className="size-4" />}
          </Button>
        </div>

        <div className="flex-1 py-2 space-y-1 px-2">
          <NavItem icon={<LayoutDashboard className="size-4" />} label="Dashboard" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} collapsed={sidebarCollapsed} />
          <NavItem icon={<Smartphone className="size-4" />} label="WhatsApp" active={activeTab === 'whatsapp'} onClick={() => setActiveTab('whatsapp')} badge={wa.status.connected ? 'online' : undefined} collapsed={sidebarCollapsed} />
          <NavItem
            icon={<MessageCircle className="size-4" />} label="Conversas" active={activeTab === 'conversations'} onClick={() => setActiveTab('conversations')}
            badge={wa.conversations.reduce((s, c) => s + c.unreadCount, 0) > 0 ? String(wa.conversations.reduce((s, c) => s + c.unreadCount, 0)) : undefined}
            collapsed={sidebarCollapsed}
          />
          <NavItem icon={<Settings className="size-4" />} label="Configuracoes" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} collapsed={sidebarCollapsed} />
          {/* v7.22: Admin-only "Usuários" tab */}
          {isAdmin && (
            <NavItem icon={<Users className="size-4" />} label="Usuários" active={activeTab === 'users'} onClick={() => setActiveTab('users')} collapsed={sidebarCollapsed} />
          )}
        </div>

        <div className="p-2 border-t space-y-1">
          <StatusIndicator label="WhatsApp" connected={wa.status.connected} collapsed={sidebarCollapsed} />
          <StatusIndicator label="Odoo" connected={odoo.status.connected} collapsed={sidebarCollapsed} />
          {/* v7.22: User info + logout */}
          <div className="pt-2 mt-2 border-t">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <div className="size-7 rounded-full bg-emerald-600 text-white text-xs flex items-center justify-center shrink-0 font-medium">
                {(user?.name || user?.email || '?').charAt(0).toUpperCase()}
              </div>
              {!sidebarCollapsed && (
                <div className="flex-1 min-w-0 hidden lg:block">
                  <p className="text-xs font-medium truncate">{user?.name || user?.email}</p>
                  {/* v7.29.2: Hide role label — regular users see the same UI as admins
                      (the only difference is admin's "Usuários" tab, which is already
                      gated). Showing "Admin"/"Usuário" creates a perceived difference
                      that doesn't actually exist in functionality. */}
                  <p className="text-[10px] text-muted-foreground truncate">{user?.email}</p>
                </div>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => logout()}
                title="Sair"
              >
                <LogOut className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex flex-col min-h-0 max-h-screen relative">
        {/* v7.21: Floating banner showing Odoo chatter history sync progress */}
        {wa.odooHistorySync && (
          <div className="absolute top-3 right-3 z-50 max-w-sm animate-in fade-in slide-in-from-top-2">
            <div className={`rounded-lg border shadow-lg p-3 text-xs ${
              wa.odooHistorySync.phase === 'error'
                ? 'bg-destructive/95 text-destructive-foreground border-destructive'
                : wa.odooHistorySync.phase === 'complete'
                ? 'bg-emerald-600/95 text-white border-emerald-700'
                : 'bg-sky-600/95 text-white border-sky-700'
            }`}>
              <div className="flex items-start gap-2">
                {wa.odooHistorySync.phase === 'error' ? (
                  <AlertCircle className="size-4 shrink-0 mt-0.5" />
                ) : wa.odooHistorySync.phase === 'complete' ? (
                  <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
                ) : (
                  <Loader2 className="size-4 shrink-0 mt-0.5 animate-spin" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold">
                    {wa.odooHistorySync.phase === 'error'
                      ? 'Erro ao sincronizar conversas'
                      : wa.odooHistorySync.phase === 'complete'
                      ? 'Conversas restauradas do Odoo'
                      : 'Trazendo conversas do Odoo...'}
                  </p>
                  {wa.odooHistorySync.phase === 'error' && wa.odooHistorySync.error && (
                    <p className="mt-0.5 opacity-90 break-words">{wa.odooHistorySync.error}</p>
                  )}
                  {wa.odooHistorySync.phase === 'complete' && (
                    <p className="mt-0.5 opacity-90">
                      {wa.odooHistorySync.processed || 0} contatos • {(wa.odooHistorySync.added || 0)} mensagens
                      {(wa.odooHistorySync.failed || 0) > 0 && ` • ${wa.odooHistorySync.failed} falhas`}
                    </p>
                  )}
                  {(wa.odooHistorySync.phase === 'starting' ||
                    wa.odooHistorySync.phase === 'fetching_partners' ||
                    wa.odooHistorySync.phase === 'processing') && (
                    <p className="mt-0.5 opacity-90">
                      {wa.odooHistorySync.phase === 'fetching_partners'
                        ? 'Buscando contatos no Odoo...'
                        : wa.odooHistorySync.phase === 'processing'
                        ? `Processando ${wa.odooHistorySync.processed || 0}/${wa.odooHistorySync.total || 0} • ${wa.odooHistorySync.added || 0} msgs`
                        : 'Iniciando...'}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'dashboard' && (
          <div className="flex-1 overflow-y-auto">
            <DashboardView
              waStatus={wa.status}
              waMe={wa.me}
              waConversations={wa.conversations}
              odooStatus={odoo.status}
              onNavigate={setActiveTab}
            />
          </div>
        )}

        {activeTab === 'whatsapp' && (
          <div className="flex-1 overflow-y-auto p-6 flex items-start justify-center">
            <QRCodePanel
              qrCode={wa.qrCode}
              status={wa.status}
              me={wa.me}
              onRequestQR={wa.requestQR}
              onDisconnect={wa.disconnect}
              isConnected={wa.status.connected}
            />
          </div>
        )}

        {activeTab === 'conversations' && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <ConversationsView
            conversations={wa.conversations}
            selectedJid={selectedJid}
            selectedConversation={selectedConversation}
            currentMessages={wa.currentMessages}
            showOdooPanel={showOdooPanel}
            odooStatus={odoo.status}
            onSelectConversation={handleSelectConversation}
            onSendMessage={wa.sendMessage}
            onSendMedia={wa.sendMedia}
            onSendMediaBase64={wa.sendMediaBase64}
            onMarkRead={wa.markRead}
            onToggleOdooPanel={setShowOdooPanel}
            onLinkConversation={odoo.linkConversation}
            onSearchContacts={odoo.searchContacts}
            onSearchLeads={odoo.searchLeads}
            onSearchSales={odoo.searchSales}
            onSearchTasks={odoo.searchTasks}
            onCreateLead={odoo.createLead}
            onCreateContact={odoo.createContact}
            onCreateTask={odoo.createTask}
            onLogMessage={odoo.logMessage}
            isSyncing={wa.syncProgress?.isSyncing}
            syncProgress={wa.syncProgress?.progress}
            onGetContacts={wa.getContacts}
            onStartConversation={wa.startConversation}
            onFetchOdooHistory={(model, recordId) => odoo.fetchHistory({ model, recordId })}
            onInjectHistory={wa.injectHistory}
            linkedOdooRecords={linkedOdooRecords}
            onCreateOdooContact={odoo.createContact}
            onDeleteConversation={wa.deleteConversation}
            onRefreshData={wa.refreshData}
          />
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto space-y-6">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Configuracoes</h1>
              <p className="text-muted-foreground text-sm mt-1">Configure as conexoes e a sincronizacao automatica do middleware</p>
            </div>
            <OdooConfigForm
              status={odoo.status}
              onAuthenticate={odoo.authenticate}
              onDisconnect={odoo.disconnect}
              isConnected={odoo.status.connected}
            />
            <AutoSyncSettingsPanel
              odooConnected={odoo.status.connected}
              settings={odoo.autoSyncSettings}
              onUpdateSettings={odoo.updateAutoSyncSettings}
              onSyncAllHistory={odoo.syncAllHistory}
            />
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
                <Button variant={wa.status.connected ? 'destructive' : 'default'} className="w-full" onClick={() => setActiveTab('whatsapp')}>
                  {wa.status.connected ? 'Desconectar WhatsApp' : 'Conectar WhatsApp'}
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* v7.22: Admin user management tab */}
        {activeTab === 'users' && isAdmin && (
          <div className="flex-1 overflow-y-auto p-6 max-w-5xl mx-auto">
            <UsersPanel />
          </div>
        )}
      </main>
    </div>
  )
}
