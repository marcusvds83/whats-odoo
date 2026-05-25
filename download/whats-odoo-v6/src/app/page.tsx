'use client'

import { useState, useMemo, useCallback } from 'react'
import { useWhatsApp } from '@/lib/use-whatsapp'
import { useOdoo } from '@/lib/use-odoo'
import { QRCodePanel } from '@/components/whatsapp/QRCodePanel'
import { ConversationList } from '@/components/whatsapp/ConversationList'
import { ChatView } from '@/components/whatsapp/ChatView'
import { OdooConfigForm } from '@/components/odoo/OdooConfigForm'
import { AutoSyncSettingsPanel } from '@/components/odoo/AutoSyncSettings'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
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
  Zap,
  Phone,
} from 'lucide-react'

type Tab = 'dashboard' | 'whatsapp' | 'conversations' | 'settings'

function DashboardView({
  waStatus,
  waMe,
  waConversations,
  waContacts,
  odooStatus,
  onNavigate,
}: {
  waStatus: { connected: boolean; reason?: string }
  waMe: { id: string; name?: string; profilePicUrl?: string } | null
  waConversations: Array<{ jid: string; unreadCount: number }>
  waContacts: Array<any>
  odooStatus: { connected: boolean; url?: string; db?: string; username?: string }
  onNavigate: (tab: Tab) => void
}) {
  const totalUnread = waConversations.reduce((s, c) => s + c.unreadCount, 0)

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">Visao geral da integracao WhatsApp e Odoo</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="relative overflow-hidden">
          <div className={cn("absolute top-0 left-0 w-1 h-full", waStatus.connected ? "bg-emerald-500" : "bg-red-400")} />
          <CardHeader className="pb-2 pl-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">WhatsApp</CardTitle>
              {waStatus.connected ? <Wifi className="size-4 text-emerald-500" /> : <WifiOff className="size-4 text-red-400" />}
            </div>
          </CardHeader>
          <CardContent className="pl-5">
            <div className="text-2xl font-bold">{waStatus.connected ? 'Conectado' : 'Desconectado'}</div>
            <p className="text-xs text-muted-foreground mt-1">{waStatus.connected ? (waMe?.name || 'Sessao ativa') : 'Escaneie o QR Code'}</p>
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
            <p className="text-xs text-muted-foreground mt-1">{odooStatus.connected ? odooStatus.url : 'Configure as credenciais'}</p>
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
          <div className="absolute top-0 left-0 w-1 h-full bg-violet-500" />
          <CardHeader className="pb-2 pl-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">Contatos WA</CardTitle>
              <Users className="size-4 text-violet-500" />
            </div>
          </CardHeader>
          <CardContent className="pl-5">
            <div className="text-2xl font-bold">{waContacts.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Contatos sincronizados</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Acoes Rapidas</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {!waStatus.connected && (
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
            {waStatus.connected && odooStatus.connected && (
              <Button variant="outline" className="justify-start gap-2 h-auto py-3" onClick={() => onNavigate('conversations')}>
                <Zap className="size-4 text-yellow-500" />
                <div className="text-left"><div className="text-sm font-medium">Criar Oportunidade</div><div className="text-xs text-muted-foreground">A partir de conversa</div></div>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// Helper to format conversation for Odoo description
function formatConversationForDescription(
  pushName: string | null,
  phone: string | null,
  messages: Array<{ fromMe: boolean; textContent: string | null; mediaType: string | null; timestamp: string }>
): string {
  const lines: string[] = []
  lines.push(`Conversa WhatsApp com ${pushName || phone || 'Contato'}`)
  lines.push(`Telefone: ${phone || 'N/A'}`)
  lines.push(`Data de criacao do lead: ${new Date().toLocaleString('pt-BR')}`)
  lines.push('')
  lines.push('--- Historico da Conversa ---')
  lines.push('')
  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleString('pt-BR')
    const sender = msg.fromMe ? 'Voce' : (pushName || phone || 'Contato')
    const content = msg.textContent || `[${msg.mediaType || 'Midia'}]`
    lines.push(`[${time}] ${sender}: ${content}`)
  }
  return lines.join('\n')
}

export default function HomePage() {
  const wa = useWhatsApp()
  const odoo = useOdoo()

  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  const [selectedJid, setSelectedJid] = useState<string | null>(null)

  const selectedConversation = useMemo(() => {
    if (!selectedJid) return null
    return wa.conversations.find(c => c.jid === selectedJid) || null
  }, [selectedJid, wa.conversations])

  const odooSyncInfo = useMemo(() => {
    if (!selectedJid) return null
    const sync = wa.odooSyncMap.get(selectedJid)
    return sync ? { partnerId: sync.partnerId, leadId: sync.leadId } : null
  }, [selectedJid, wa.odooSyncMap])

  const handleSelectConversation = (jid: string) => {
    setSelectedJid(jid)
    wa.loadMessages(jid)
    wa.markRead(jid)
  }

  // ========== Create Lead from Conversation ==========
  const handleCreateLeadFromChat = useCallback(async (
    jid: string,
    data: { name: string; phone: string; pushName: string | null; messages: any[]; partner_id?: number }
  ): Promise<boolean> => {
    try {
      // Ensure contact exists first
      let partnerId = data.partner_id
      if (!partnerId) {
        const contactResult = await odoo.searchOrCreateContact({
          phone: data.phone,
          name: data.pushName || data.phone,
        })
        if (!contactResult.success || !contactResult.id) {
          toast.error('Erro ao criar contato no Odoo', { description: contactResult.error })
          return false
        }
        partnerId = contactResult.id
      }
      const description = data.messages.length > 0
        ? formatConversationForDescription(data.pushName, data.phone, data.messages)
        : `Conversa iniciada via WhatsApp em ${new Date().toLocaleString('pt-BR')}`

      const leadResult = await odoo.createLead({
        name: data.name,
        phone: data.phone,
        partner_id: partnerId,
        description,
        type: 'lead',
        whatsapp_number: data.phone,
      })
      if (!leadResult.success || !leadResult.id) {
        toast.error('Erro ao criar lead no Odoo', { description: leadResult.error })
        return false
      }
      await odoo.linkConversation({ jid, model: 'crm.lead', recordId: leadResult.id, phone: data.phone })
      await odoo.linkConversation({ jid, model: 'res.partner', recordId: partnerId, phone: data.phone })

      wa.odooSyncMap.set(jid, {
        jid, phone: data.phone,
        partnerId: partnerId, leadId: leadResult.id,
        mailMessageId: null, activityId: null,
        created: { partner: true, lead: true },
        errors: [],
      })
      toast.success('Lead criado com sucesso!', { description: `Lead #${leadResult.id} para ${data.pushName || data.phone}` })
      return true
    } catch (error: any) {
      toast.error('Erro ao criar lead', { description: error.message })
      return false
    }
  }, [odoo, wa.odooSyncMap])

  // ========== Create Contact from Conversation ==========
  const handleCreateContactFromChat = useCallback(async (
    jid: string,
    data: { name: string; phone: string; pushName: string | null }
  ): Promise<boolean> => {
    try {
      // Use real phone number (strip device suffix from JID)
      const realPhone = data.phone || jid.split('@')[0].split(':')[0]
      const contactResult = await odoo.searchOrCreateContact({
        phone: realPhone,
        name: data.name || realPhone,
      })
      if (!contactResult.success || !contactResult.id) {
        toast.error('Erro ao criar contato no Odoo', { description: contactResult.error })
        return false
      }
      await odoo.linkConversation({ jid, model: 'res.partner', recordId: contactResult.id, phone: realPhone })
      const existing = wa.odooSyncMap.get(jid)
      wa.odooSyncMap.set(jid, {
        jid, phone: realPhone,
        partnerId: contactResult.id, leadId: existing?.leadId || null,
        mailMessageId: null, activityId: null,
        created: { partner: contactResult.created || true, lead: false }, errors: [],
      })
      toast.success('Contato criado com sucesso!', { description: `Contato #${contactResult.id} para ${data.name}` })
      return true
    } catch (error: any) {
      toast.error('Erro ao criar contato', { description: error.message })
      return false
    }
  }, [odoo, wa.odooSyncMap])

  return (
    <div className="flex h-screen">
      <nav className="w-14 lg:w-56 border-r bg-muted/30 flex flex-col shrink-0">
        <div className="h-14 flex items-center px-3 lg:px-4 border-b">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
              <MessageCircle className="size-4" />
            </div>
            <div className="hidden lg:block">
              <p className="text-sm font-bold leading-tight">WA-Odoo</p>
              <p className="text-[10px] text-muted-foreground">Middleware v6.0</p>
            </div>
          </div>
        </div>

        <div className="flex-1 py-2 space-y-1 px-2">
          <NavItem icon={<LayoutDashboard className="size-4" />} label="Dashboard" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} />
          <NavItem icon={<Smartphone className="size-4" />} label="WhatsApp" active={activeTab === 'whatsapp'} onClick={() => setActiveTab('whatsapp')} badge={wa.status.connected ? 'online' : undefined} />
          <NavItem icon={<MessageCircle className="size-4" />} label="Conversas" active={activeTab === 'conversations'} onClick={() => setActiveTab('conversations')}
            badge={wa.conversations.reduce((s, c) => s + c.unreadCount, 0) > 0 ? String(wa.conversations.reduce((s, c) => s + c.unreadCount, 0)) : undefined} />
          <NavItem icon={<Settings className="size-4" />} label="Configuracoes" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
        </div>

        <div className="p-2 border-t space-y-1">
          <StatusIndicator label="WhatsApp" connected={wa.status.connected} />
          <StatusIndicator label="Odoo" connected={odoo.status.connected} />
        </div>
      </nav>

      <main className="flex-1 overflow-hidden">
        {activeTab === 'dashboard' && (
          <div className="h-full overflow-y-auto">
          <DashboardView waStatus={wa.status} waMe={wa.me} waConversations={wa.conversations} waContacts={wa.contacts} odooStatus={odoo.status} onNavigate={setActiveTab} />
          </div>
        )}

        {activeTab === 'whatsapp' && (
          <div className="p-6 flex items-start justify-center min-h-full">
            <QRCodePanel qrCode={wa.qrCode} status={wa.status} me={wa.me} onRequestQR={wa.requestQR} onDisconnect={wa.disconnect} isConnected={wa.status.connected} />
          </div>
        )}

        {activeTab === 'conversations' && (
          <div className="flex h-full">
            <div className="w-80 lg:w-96 border-r bg-background shrink-0 h-full">
              <ConversationList
                conversations={wa.conversations}
                selectedJid={selectedJid}
                onSelect={handleSelectConversation}
                contacts={wa.contacts}
                onStartConversation={wa.startConversation}
                onCheckNumber={wa.checkNumber}
                onSyncConversations={wa.syncConversations}
                onMergeDuplicates={wa.mergeDuplicates}
                syncStatus={wa.syncStatus}
                mergeStatus={wa.mergeStatus}
                fetchRecentMessages={wa.fetchRecentMessages}
                onLoadMessages={wa.loadMessagesSocket}
              />
            </div>
            <div className="flex-1 min-w-0">
              <ChatView
                conversation={selectedConversation}
                messages={wa.currentMessages}
                onSendMessage={wa.sendMessage}
                onMarkRead={wa.markRead}
                odooConnected={odoo.status.connected}
                odooSyncInfo={odooSyncInfo}
                onCreateLead={handleCreateLeadFromChat}
                onCreateContact={handleCreateContactFromChat}
                onSearchContacts={odoo.searchContacts}
                onSearchLeads={odoo.searchLeads}
                onSearchSales={odoo.searchSales}
                onSearchTasks={odoo.searchTasks}
                onLinkConversation={odoo.linkConversation}
                onLogMessage={odoo.logMessage}
                onLinkAndPostChatter={odoo.linkAndPostChatter}
                fetchRecentMessages={wa.fetchRecentMessages}
                messagesLoading={wa.messagesLoading}
              />
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="h-full overflow-y-auto">
          <div className="p-6 max-w-2xl mx-auto space-y-6">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Configuracoes</h1>
              <p className="text-muted-foreground text-sm mt-1">Configure as conexoes e a sincronizacao automatica do middleware</p>
            </div>
            <OdooConfigForm status={odoo.status} onAuthenticate={odoo.authenticate} onDisconnect={odoo.disconnect} isConnected={odoo.status.connected} />
            <AutoSyncSettingsPanel odooConnected={odoo.status.connected} settings={odoo.autoSyncSettings} onUpdateSettings={odoo.updateAutoSyncSettings} />
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2"><Smartphone className="size-4 text-emerald-500" /><CardTitle className="text-base">Status WhatsApp</CardTitle></div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Conexao</span>
                  <Badge variant={wa.status.connected ? 'default' : 'outline'} className={wa.status.connected ? 'bg-emerald-100 text-emerald-800 border-emerald-200' : ''}>{wa.status.connected ? 'Conectado' : 'Desconectado'}</Badge>
                </div>
                {wa.me && (<>
                  <div className="flex items-center justify-between text-sm"><span className="text-muted-foreground">Numero</span><span className="font-mono text-xs">{wa.me.id?.split('@')[0]}</span></div>
                  <div className="flex items-center justify-between text-sm"><span className="text-muted-foreground">Nome</span><span>{wa.me.name || 'N/A'}</span></div>
                </>)}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Contatos sincronizados</span>
                  <span>{wa.contacts.length}</span>
                </div>
                <Button variant={wa.status.connected ? 'destructive' : 'default'} className="w-full" onClick={() => setActiveTab('whatsapp')}>{wa.status.connected ? 'Desconectar WhatsApp' : 'Conectar WhatsApp'}</Button>
                <Button variant="outline" className="w-full" onClick={async () => {
                  const result = await wa.resetSession()
                  if (result.success) {
                    toast.success('Sessao resetada!', { description: 'Escaneie o QR Code novamente' })
                  } else {
                    toast.error('Erro ao resetar sessao', { description: result.error })
                  }
                }}>
                  <Smartphone className="size-4 mr-2" /> Resetar Sessao WhatsApp
                </Button>
              </CardContent>
            </Card>

            {/* v5.1: User Manual */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2"><ClipboardList className="size-4 text-primary" /><CardTitle className="text-base">Manual do Usuario</CardTitle></div>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">1. Como conectar o WhatsApp</h4>
                  <p className="text-muted-foreground">Acesse a aba "WhatsApp" e escaneie o QR Code com o celular (WhatsApp &gt; Aparelhos conectados &gt; Conectar). Aguarde a sincronizacao das conversas.</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">2. Como ver conversas e mensagens</h4>
                  <p className="text-muted-foreground">Apos conectar, acesse a aba "Conversas". Clique em uma conversa para ver as mensagens. Use o botao de atualizar ao lado do campo de envio para buscar mensagens recentes.</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">3. Como criar um contato no Odoo</h4>
                  <p className="text-muted-foreground">Selecione uma conversa e clique no botao "Criar Contato" (verde). Isso cria um contato no Odoo com o nome e telefone do WhatsApp. Apos criado, o badge "Contato OK" aparece.</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">4. Como criar um lead no Odoo</h4>
                  <p className="text-muted-foreground">Depois de criar o contato, clique em "Criar Lead". Voce pode incluir o historico da conversa na descricao do lead. O lead sera criado no CRM do Odoo vinculado ao contato.</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">5. Como vincular conversa ao Chatter</h4>
                  <p className="text-muted-foreground">Clique no botao "Vincular" para abrir o dialogo de vinculacao. Busque contatos, leads, oportunidades ou tarefas no Odoo e vincule a conversa. Mensagens serao postadas no Chatter.</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">6. Como sincronizar conversas do telefone</h4>
                  <p className="text-muted-foreground">Clique no botao de sincronizar na lista de conversas. Isso solicita ao telefone o historico mais recente de mensagens. A sincronizacao e automatica ao conectar.</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">7. Como mesclar conversas duplicadas</h4>
                  <p className="text-muted-foreground">Clique no botao de mesclar duplicatas na lista de conversas. O sistema identifica conversas com o mesmo numero de telefone e as combina em uma so.</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">8. Como iniciar uma nova conversa</h4>
                  <p className="text-muted-foreground">Clique no botao "+ Nova Conversa" na lista de conversas. Digite o numero de telefone (com codigo do pais) ou selecione um contato da lista. O sistema verifica se o numero esta no WhatsApp.</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">9. Sincronizacao automatica</h4>
                  <p className="text-muted-foreground">Quando a sincronizacao automatica esta ativada, contatos e leads sao criados automaticamente no Odoo para cada nova mensagem recebida. Configure em "Configuracoes &gt; Auto-Sync".</p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <h4 className="font-semibold text-primary">10. Como resetar a sessao WhatsApp</h4>
                  <p className="text-muted-foreground">Se as mensagens estao desatualizadas ou a conexao esta com problemas, clique em "Resetar Sessao WhatsApp" acima. Isso limpa a sessao atual e gera um novo QR Code. Voce precisara escanear novamente.</p>
                </div>
              </CardContent>
            </Card>
          </div>
          </div>
        )}
      </main>
    </div>
  )
}

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
