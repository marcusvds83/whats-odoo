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
  BookOpen,
  RefreshCw,
  MessageSquare,
  CheckCircle2,
  Target,
  UserPlus,
  HelpCircle,
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

// v5.0: User Manual Component
function UserManual() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold flex items-center gap-2"><BookOpen className="size-5 text-primary" /> Manual do Usuario</h2>
        <p className="text-muted-foreground text-sm mt-1">Guia completo de uso do middleware WhatsApp-Odoo</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Smartphone className="size-4 text-emerald-500" /> 1. Conectando o WhatsApp</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Para conectar seu WhatsApp ao middleware, siga estes passos:</p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li>Acesse a aba <strong>WhatsApp</strong> no menu lateral</li>
            <li>Clique no botao <strong>&quot;Solicitar QR Code&quot;</strong></li>
            <li>Aguarde de <strong>20 a 30 segundos</strong> para o QR Code aparecer</li>
            <li>No seu celular, abra o <strong>WhatsApp</strong></li>
            <li>Va em <strong>Aparelhos conectados → Conectar um aparelho</strong></li>
            <li>Aponte a camera para o QR Code exibido na tela</li>
            <li>Aguarde a confirmacao de conexao</li>
          </ol>
          <p className="text-xs text-muted-foreground">A sessao permanece ativa mesmo apos recarregar a pagina. Se a conexao cair, o sistema tenta reconectar automaticamente.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><MessageCircle className="size-4 text-primary" /> 2. Conversas e Mensagens</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Apos conectar, suas conversas do WhatsApp sao sincronizadas automaticamente:</p>
          <ul className="list-disc list-inside space-y-2 ml-2">
            <li><strong>Conversas atuais:</strong> As conversas mais recentes do seu aparelho sao carregadas automaticamente</li>
            <li><strong>Mensagens em tempo real:</strong> Novas mensagens aparecem instantaneamente sem precisar recarregar</li>
            <li><strong>Enviar mensagens:</strong> Digite no campo de texto e pressione Enter ou clique no botao de envio</li>
            <li><strong>Nova conversa:</strong> Clique no botao &quot;+&quot; na lista de conversas para iniciar uma conversa com um numero novo</li>
            <li><strong>Atualizar conversas:</strong> Clique no botao de sincronizacao (seta circular) para buscar conversas atualizadas do aparelho</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Server className="size-4 text-amber-500" /> 3. Configurando o Odoo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Para integrar com o Odoo CRM, configure as credenciais:</p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li>Acesse a aba <strong>Configuracoes</strong></li>
            <li>Preencha a <strong>URL do Odoo</strong> (ex: https://suaempresa.odoo.com)</li>
            <li>Preencha o <strong>nome do banco de dados</strong></li>
            <li>Informe seu <strong>usuario</strong> e <strong>senha</strong> do Odoo</li>
            <li>Clique em <strong>Conectar</strong></li>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><UserPlus className="size-4 text-emerald-500" /> 4. Criando Contatos e Leads no Odoo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Com o Odoo conectado, voce pode criar contatos e leads diretamente das conversas:</p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li>Selecione uma conversa na lista</li>
            <li>No cabecalho da conversa, clique em <strong>&quot;Criar Contato&quot;</strong></li>
            <li>Apos criar o contato, uma notificacao aparecera confirmando a criacao</li>
            <li>Agora o botao <strong>&quot;Criar Lead&quot;</strong> ficara disponivel</li>
            <li>Clique em <strong>&quot;Criar Lead&quot;</strong> para gerar um lead no CRM com o historico da conversa</li>
          </ol>
          <p className="text-xs text-amber-600">Importante: O botao &quot;Criar Lead&quot; so aparece depois que o contato for criado no Odoo. Isso evita criacao de leads sem contato vinculado.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Zap className="size-4 text-yellow-500" /> 5. Sincronizacao Automatica</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>O middleware pode sincronizar automaticamente mensagens do WhatsApp com o Odoo:</p>
          <ul className="list-disc list-inside space-y-2 ml-2">
            <li><strong>Criar contato automaticamente:</strong> Quando uma nova mensagem chega, um contato e criado no Odoo</li>
            <li><strong>Criar lead automaticamente:</strong> Um lead e gerado para cada novo contato que envia mensagem</li>
            <li><strong>Registrar mensagens:</strong> As mensagens sao postadas no chatter do Odoo</li>
            <li><strong>Criar atividade:</strong> Uma atividade de notificacao e criada para novos leads</li>
          </ul>
          <p className="text-xs text-muted-foreground">Configure a sincronizacao automatica na secao &quot;Sincronizacao Automatica&quot; das Configuracoes.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Link2 className="size-4 text-primary" /> 6. Vinculando Conversas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Voce pode vincular uma conversa do WhatsApp a qualquer registro do Odoo:</p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li>Com uma conversa aberta, clique no botao <strong>&quot;Vincular&quot;</strong></li>
            <li>Busque por contatos, leads, vendas ou tarefas no Odoo</li>
            <li>Selecione o registro desejado</li>
            <li>O numero WhatsApp sera vinculado ao registro e o historico sera postado no chatter</li>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><HelpCircle className="size-4 text-muted-foreground" /> 7. Solucao de Problemas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ul className="list-disc list-inside space-y-2 ml-2">
            <li><strong>QR Code nao aparece:</strong> Aguarde 20-30 segundos. Se nao aparecer, clique em &quot;Solicitar QR Code&quot; novamente</li>
            <li><strong>Conversas desatualizadas:</strong> Clique no botao de sincronizacao (seta circular) para atualizar</li>
            <li><strong>Mensagens nao chegam em tempo real:</strong> Verifique sua conexao com a internet e recarregue a pagina</li>
            <li><strong>Erro ao criar contato/lead:</strong> Verifique se as credenciais do Odoo estao corretas nas Configuracoes</li>
            <li><strong>Conexao cai frequentemente:</strong> Isso e normal no plano gratuito do Render. O sistema reconecta automaticamente</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
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
          toast.error('Erro ao criar contato no Odoo', { description: contactResult.error, duration: 8000 })
          return false
        }
        partnerId = contactResult.id
        // v5.0: Notify that contact was created
        toast.success('Contato criado no Odoo!', {
          description: 'Agora voce pode criar o Lead.',
          duration: 8000,
        })
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
        toast.error('Erro ao criar lead no Odoo', { description: leadResult.error, duration: 8000 })
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
      // v5.0: Clear success message - the ChatView handles its own toasts
      return true
    } catch (error: any) {
      toast.error('Erro ao criar lead', { description: error.message, duration: 8000 })
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
        toast.error('Erro ao criar contato no Odoo', { description: contactResult.error, duration: 8000 })
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
      // v5.0: Don't show toast here - ChatView handles it with better message
      return true
    } catch (error: any) {
      toast.error('Erro ao criar contato', { description: error.message, duration: 8000 })
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
              <p className="text-[10px] text-muted-foreground">Middleware v5.0</p>
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
                onStartConversation={wa.startConversation}
                onCheckNumber={wa.checkNumber}
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
              </CardContent>
            </Card>

            {/* v5.0: User Manual */}
            <div className="pt-4 border-t">
              <UserManual />
            </div>
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
