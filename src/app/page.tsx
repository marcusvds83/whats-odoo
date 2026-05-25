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
} from 'lucide-react'

type Tab = 'dashboard' | 'whatsapp' | 'conversations' | 'settings'

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
}) {
  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className={cn(
        "border-r bg-background transition-all duration-200 h-full",
        selectedJid ? "w-80 lg:w-96" : "w-full max-w-lg mx-auto"
      )}>
        <ConversationList
          conversations={conversations}
          selectedJid={selectedJid}
          onSelect={onSelectConversation}
          isSyncing={isSyncing}
          syncProgress={syncProgress}
        />
      </div>

      {selectedJid && (
        <div className="flex-1 flex min-w-0">
          <div className={cn("flex-1 min-w-0 transition-all duration-200", showOdooPanel && "hidden lg:block")}>
            <ChatView
              conversation={selectedConversation}
              messages={currentMessages}
              onSendMessage={onSendMessage}
              onMarkRead={onMarkRead}
            />
          </div>

          {showOdooPanel && (
            <div className="w-80 lg:w-96 border-l bg-background flex flex-col">
              <div className="flex items-center justify-between px-3 py-2 border-b">
                <div className="flex items-center gap-2">
                  <Link2 className="size-4 text-primary" />
                  <span className="text-sm font-medium">Odoo</span>
                  {odooStatus.connected && (
                    <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Conectado</Badge>
                  )}
                </div>
                <Button variant="ghost" size="icon" className="size-7" onClick={() => onToggleOdooPanel(false)}>
                  <PanelRightClose className="size-4" />
                </Button>
              </div>
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
              />
            </div>
          )}

          {!showOdooPanel && (
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
        </div>
      )}
    </div>
  )
}

function NavItem({ icon, label, active, onClick, badge }: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  badge?: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm transition-colors',
        'hover:bg-muted/80 focus-visible:outline-none focus-visible:bg-muted/80',
        active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="hidden lg:block flex-1 text-left truncate">{label}</span>
      {badge && (
        <Badge className="size-5 p-0 flex items-center justify-center text-[10px] bg-emerald-500 text-white border-0">
          {badge === 'online' ? '\u25CF' : badge}
        </Badge>
      )}
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
              <p className="text-[10px] text-muted-foreground">v4.7 Middleware</p>
            </div>
          </div>
        </div>

        <div className="flex-1 py-2 space-y-1 px-2">
          <NavItem icon={<LayoutDashboard className="size-4" />} label="Dashboard" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} />
          <NavItem icon={<Smartphone className="size-4" />} label="WhatsApp" active={activeTab === 'whatsapp'} onClick={() => setActiveTab('whatsapp')} badge={wa.status.connected ? 'online' : undefined} />
          <NavItem
            icon={<MessageCircle className="size-4" />} label="Conversas" active={activeTab === 'conversations'} onClick={() => setActiveTab('conversations')}
            badge={wa.conversations.reduce((s, c) => s + c.unreadCount, 0) > 0 ? String(wa.conversations.reduce((s, c) => s + c.unreadCount, 0)) : undefined}
          />
          <NavItem icon={<Settings className="size-4" />} label="Configuracoes" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
        </div>

        <div className="p-2 border-t space-y-1">
          <StatusIndicator label="WhatsApp" connected={wa.status.connected} />
          <StatusIndicator label="Odoo" connected={odoo.status.connected} />
        </div>
      </nav>

      <main className="flex-1 flex flex-col overflow-hidden min-h-0">
        {activeTab === 'dashboard' && (
          <DashboardView
            waStatus={wa.status}
            waMe={wa.me}
            waConversations={wa.conversations}
            odooStatus={odoo.status}
            onNavigate={setActiveTab}
          />
        )}

        {activeTab === 'whatsapp' && (
          <div className="p-6 flex items-start justify-center min-h-full">
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
          <div className="flex-1 min-h-0">
            <ConversationsView
            conversations={wa.conversations}
            selectedJid={selectedJid}
            selectedConversation={selectedConversation}
            currentMessages={wa.currentMessages}
            showOdooPanel={showOdooPanel}
            odooStatus={odoo.status}
            onSelectConversation={handleSelectConversation}
            onSendMessage={wa.sendMessage}
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
          />
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="p-6 max-w-2xl mx-auto space-y-6">
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
      </main>
    </div>
  )
}
