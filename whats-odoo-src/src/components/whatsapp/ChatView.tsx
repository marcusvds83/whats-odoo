'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  Send,
  Phone,
  User,
  ImageIcon,
  FileText,
  Video,
  Music,
  Paperclip,
  Check,
  CheckCheck,
  Clock,
  MessageSquare,
  ArrowDown,
  UserPlus,
  Target,
  Link2,
  Loader2,
  CheckCircle2,
} from 'lucide-react'
import { ChatterLinkDialog } from '@/components/odoo/ChatterLinkDialog'

interface ChatViewProps {
  conversation: {
    jid: string
    name: string | null
    phone: string | null
    pushName: string | null
    avatarUrl: string | null
  } | null
  messages: Array<{
    id: string
    whatsappId: string | null
    fromMe: boolean
    textContent: string | null
    mediaType: string | null
    timestamp: string
    status: string
  }>
  onSendMessage: (jid: string, text: string) => Promise<boolean>
  onMarkRead: (jid: string) => void
  // Odoo integration props
  odooConnected?: boolean
  odooSyncInfo?: {
    partnerId: number | null
    leadId: number | null
  } | null
  onCreateLead?: (jid: string, conversationData: { name: string; phone: string; pushName: string | null; messages: ChatViewProps['messages'] }) => Promise<boolean>
  onCreateContact?: (jid: string, conversationData: { name: string; phone: string; pushName: string | null }) => Promise<boolean>
  // ChatterLinkDialog props
  onSearchContacts?: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onSearchLeads?: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onSearchSales?: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onSearchTasks?: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onLinkConversation?: (data: { jid: string; model: string; recordId: number; phone?: string }) => Promise<{ success: boolean }>
  onLogMessage?: (data: { model: string; recordId: number; message: string; fromWhatsApp?: boolean }) => Promise<{ success: boolean }>
  onLinkAndPostChatter?: (data: { jid: string; model: string; recordId: number; phone?: string; messages?: any[]; postToChatter?: boolean }) => Promise<{ success: boolean; messagesPosted?: number }>
}

function formatMessageTime(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatMessageDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Hoje'
  if (diffDays === 1) return 'Ontem'
  return date.toLocaleDateString('pt-BR', { month: 'long', day: 'numeric', year: 'numeric' })
}

function getMediaIcon(mediaType: string | null) {
  switch (mediaType) {
    case 'image': return <ImageIcon className="size-4" />
    case 'video': return <Video className="size-4" />
    case 'audio': case 'ptt': return <Music className="size-4" />
    case 'document': case 'pdf': return <FileText className="size-4" />
    default: return <Paperclip className="size-4" />
  }
}

function getMediaLabel(mediaType: string | null): string {
  switch (mediaType) {
    case 'image': return 'Foto'
    case 'video': return 'Video'
    case 'audio': return 'Audio'
    case 'ptt': return 'Mensagem de voz'
    case 'document': return 'Documento'
    case 'pdf': return 'Documento PDF'
    case 'sticker': return 'Sticker'
    default: return 'Midia'
  }
}

function getMessageStatusIcon(status: string, fromMe: boolean) {
  if (!fromMe) return null
  switch (status) {
    case 'pending': return <Clock className="size-3.5 text-muted-foreground" />
    case 'sent': return <Check className="size-3.5 text-muted-foreground" />
    case 'delivered': return <CheckCheck className="size-3.5 text-muted-foreground" />
    case 'read': return <CheckCheck className="size-3.5 text-blue-500" />
    default: return <Clock className="size-3.5 text-muted-foreground" />
  }
}

function shouldShowDateDivider(currentMsg: { timestamp: string }, prevMsg: { timestamp: string } | undefined): boolean {
  if (!prevMsg) return true
  return new Date(currentMsg.timestamp).toDateString() !== new Date(prevMsg.timestamp).toDateString()
}

function formatConversationForDescription(
  pushName: string | null,
  phone: string | null,
  messages: ChatViewProps['messages']
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
    const content = msg.textContent || `[${getMediaLabel(msg.mediaType)}]`
    lines.push(`[${time}] ${sender}: ${content}`)
  }
  return lines.join('\n')
}

export function ChatView({
  conversation,
  messages,
  onSendMessage,
  onMarkRead,
  odooConnected = false,
  odooSyncInfo = null,
  onCreateLead,
  onCreateContact,
  onSearchContacts,
  onSearchLeads,
  onSearchSales,
  onSearchTasks,
  onLinkConversation,
  onLogMessage,
  onLinkAndPostChatter,
}: ChatViewProps) {
  const [inputText, setInputText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Dialog states
  const [createLeadOpen, setCreateLeadOpen] = useState(false)
  const [leadName, setLeadName] = useState('')
  const [includeConversation, setIncludeConversation] = useState(true)
  const [creating, setCreating] = useState(false)

  const [createContactOpen, setCreateContactOpen] = useState(false)
  const [contactName, setContactName] = useState('')
  const [creatingContact, setCreatingContact] = useState(false)

  const [chatterLinkOpen, setChatterLinkOpen] = useState(false)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages.length, scrollToBottom])
  useEffect(() => { if (conversation) onMarkRead(conversation.jid) }, [conversation?.jid, onMarkRead])

  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector('[data-slot="scroll-area-viewport"]')
    if (!viewport) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport as HTMLElement
      setShowScrollButton(scrollHeight - scrollTop - clientHeight > 150)
    }
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (conversation) {
      const name = conversation.pushName || conversation.phone || conversation.jid.split('@')[0]
      setLeadName(`[WhatsApp] ${name}`)
      setContactName(name)
    }
  }, [conversation])

  const handleSend = async () => {
    const text = inputText.trim()
    if (!text || !conversation || isSending) return
    setIsSending(true)
    try {
      const success = await onSendMessage(conversation.jid, text)
      if (success) setInputText('')
    } finally {
      setIsSending(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const handleCreateLead = async () => {
    if (!conversation || !onCreateLead) return
    setCreating(true)
    try {
      const success = await onCreateLead(conversation.jid, {
        name: leadName,
        phone: conversation.phone || conversation.jid.split('@')[0],
        pushName: conversation.pushName,
        messages: includeConversation ? messages : [],
      })
      if (success) setCreateLeadOpen(false)
    } finally {
      setCreating(false)
    }
  }

  const handleCreateContact = async () => {
    if (!conversation || !onCreateContact) return
    setCreatingContact(true)
    try {
      const success = await onCreateContact(conversation.jid, {
        name: contactName,
        phone: conversation.phone || conversation.jid.split('@')[0],
        pushName: conversation.pushName,
      })
      if (success) setCreateContactOpen(false)
    } finally {
      setCreatingContact(false)
    }
  }

  const displayName =
    conversation?.name || conversation?.pushName || conversation?.phone || conversation?.jid?.split('@')[0] || ''

  if (!conversation) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-muted/20">
        <div className="flex flex-col items-center gap-3 text-center px-4">
          <div className="size-20 rounded-full bg-muted/60 flex items-center justify-center">
            <MessageSquare className="size-8 text-muted-foreground/50" />
          </div>
          <h3 className="text-lg font-semibold text-muted-foreground">Nenhuma conversa selecionada</h3>
          <p className="text-sm text-muted-foreground/70 max-w-[280px]">
            Selecione uma conversa da lista ou inicie uma nova conversa
          </p>
        </div>
      </div>
    )
  }

  const hasExistingPartner = odooSyncInfo?.partnerId != null
  const hasExistingLead = odooSyncInfo?.leadId != null

  return (
    <div className="flex flex-col h-full">
      {/* Chat Header */}
      <div className="shrink-0 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-3 px-4 py-3">
          <Avatar className="size-10">
            {conversation.avatarUrl && <AvatarImage src={conversation.avatarUrl} alt={displayName} />}
            <AvatarFallback className="bg-primary/10 text-primary text-sm">
              {displayName.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || <User className="size-4" />}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm truncate">{displayName}</h3>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {conversation.phone ? (
                <><Phone className="size-3" /><span>{conversation.phone}</span></>
              ) : (
                <span>{conversation.jid.split('@')[0]}</span>
              )}
              {hasExistingPartner && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 ml-1 bg-emerald-50 text-emerald-700 border-emerald-200">Contato #{odooSyncInfo!.partnerId}</Badge>
              )}
              {hasExistingLead && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 ml-1 bg-amber-50 text-amber-700 border-amber-200">Lead #{odooSyncInfo!.leadId}</Badge>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          {odooConnected && (
            <div className="flex items-center gap-1.5">
              <Button variant={hasExistingPartner ? "ghost" : "outline"} size="sm"
                className={cn("h-8 gap-1.5 text-xs", !hasExistingPartner && "border-emerald-300 text-emerald-700 hover:bg-emerald-50 bg-emerald-50/50")}
                onClick={() => setCreateContactOpen(true)} disabled={hasExistingPartner}
                title={hasExistingPartner ? 'Contato ja existe no Odoo' : 'Criar contato no Odoo'}>
                {hasExistingPartner ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <UserPlus className="size-3.5" />}
                <span className="hidden sm:inline">{hasExistingPartner ? 'Contato OK' : 'Contato'}</span>
              </Button>
              <Button variant={hasExistingLead ? "ghost" : "outline"} size="sm"
                className={cn("h-8 gap-1.5 text-xs", !hasExistingLead && "border-amber-300 text-amber-700 hover:bg-amber-50 bg-amber-50/50")}
                onClick={() => setCreateLeadOpen(true)} disabled={hasExistingLead}
                title={hasExistingLead ? 'Lead ja existe no Odoo' : 'Criar lead no Odoo'}>
                {hasExistingLead ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <Target className="size-3.5" />}
                <span className="hidden sm:inline">{hasExistingLead ? 'Lead OK' : 'Lead'}</span>
              </Button>
              <Button variant="outline" size="sm"
                className="h-8 gap-1.5 text-xs border-primary/40 text-primary hover:bg-primary/10"
                onClick={() => setChatterLinkOpen(true)}
                title="Vincular conversa ao chatter do Odoo">
                <Link2 className="size-3.5" />
                <span className="hidden sm:inline">Vincular</span>
              </Button>
            </div>
          )}
          {!odooConnected && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">Odoo offline</Badge>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 relative overflow-hidden">
        <ScrollArea ref={scrollAreaRef} className="h-full">
          <div className="px-4 py-3 space-y-1">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16">
                <div className="size-14 rounded-full bg-muted/50 flex items-center justify-center mb-3">
                  <MessageSquare className="size-6 text-muted-foreground/40" />
                </div>
                <p className="text-sm text-muted-foreground">Sem mensagens ainda</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Envie uma mensagem para iniciar a conversa</p>
              </div>
            ) : (
              messages.map((message, index) => {
                const prevMessage = index > 0 ? messages[index - 1] : undefined
                const showDateDivider = shouldShowDateDivider(message, prevMessage)
                const isConsecutive = prevMessage && prevMessage.fromMe === message.fromMe && new Date(message.timestamp).getTime() - new Date(prevMessage.timestamp).getTime() < 60000
                return (
                  <div key={message.id}>
                    {showDateDivider && (
                      <div className="flex items-center justify-center py-3">
                        <Badge variant="secondary" className="text-[10px] px-3 py-0.5 font-normal bg-muted/80 text-muted-foreground">
                          {formatMessageDate(message.timestamp)}
                        </Badge>
                      </div>
                    )}
                    <div className={cn('flex', message.fromMe ? 'justify-end' : 'justify-start', isConsecutive ? 'mt-0.5' : 'mt-2')}>
                      <div className={cn(
                        'max-w-[75%] sm:max-w-[65%] rounded-2xl px-3 py-1.5 shadow-sm',
                        message.fromMe ? 'bg-emerald-600 text-white rounded-br-md' : 'bg-muted rounded-bl-md',
                        isConsecutive && (message.fromMe ? 'rounded-br-md' : 'rounded-bl-md')
                      )}>
                        {message.mediaType && message.mediaType !== '' && (
                          <div className={cn('flex items-center gap-2 mb-1 px-2 py-1.5 rounded-lg text-xs', message.fromMe ? 'bg-emerald-500/50' : 'bg-background/50')}>
                            {getMediaIcon(message.mediaType)}
                            <span className="font-medium">{getMediaLabel(message.mediaType)}</span>
                          </div>
                        )}
                        {message.textContent && <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">{message.textContent}</p>}
                        {message.mediaType && !message.textContent && <p className="text-[13px] leading-relaxed italic opacity-70">{getMediaLabel(message.mediaType)}</p>}
                        <div className={cn('flex items-center gap-1 mt-0.5', message.fromMe ? 'justify-end' : 'justify-start')}>
                          <span className={cn('text-[10px]', message.fromMe ? 'text-white/60' : 'text-muted-foreground')}>{formatMessageTime(message.timestamp)}</span>
                          {getMessageStatusIcon(message.status, message.fromMe)}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>
        {showScrollButton && (
          <Button variant="secondary" size="icon" className="absolute bottom-4 right-4 size-9 rounded-full shadow-lg opacity-80 hover:opacity-100" onClick={() => scrollToBottom()}>
            <ArrowDown className="size-4" />
          </Button>
        )}
      </div>

      {/* Message Input */}
      <Separator />
      <div className="shrink-0 px-4 py-3 bg-background">
        <div className="flex items-center gap-2">
          <Input ref={inputRef} placeholder="Digite uma mensagem..." className="flex-1 h-10 text-sm" value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={handleKeyDown} disabled={isSending} />
          <Button size="icon" className="size-10 shrink-0 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleSend} disabled={!inputText.trim() || isSending}>
            {isSending ? <span className="size-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>

      {/* ========== Create Lead Dialog ========== */}
      <Dialog open={createLeadOpen} onOpenChange={setCreateLeadOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Target className="size-5 text-amber-500" /> Criar Lead no Odoo</DialogTitle>
            <DialogDescription>Crie um lead no CRM do Odoo a partir desta conversa do WhatsApp</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label htmlFor="lead-name">Nome do Lead</Label>
              <Input id="lead-name" value={leadName} onChange={(e) => setLeadName(e.target.value)} placeholder="Nome do lead" />
            </div>
            <div className="flex items-center gap-3 text-sm">
              <div className="flex items-center gap-1.5 text-muted-foreground"><Phone className="size-3.5" /><span>{conversation.phone || conversation.jid.split('@')[0]}</span></div>
              {conversation.pushName && <div className="flex items-center gap-1.5 text-muted-foreground"><User className="size-3.5" /><span>{conversation.pushName}</span></div>}
            </div>
            <div className="flex items-center gap-3 rounded-lg border p-3">
              <input type="checkbox" id="include-conversation" checked={includeConversation} onChange={(e) => setIncludeConversation(e.target.checked)} className="size-4 rounded border-gray-300" />
              <div className="flex-1">
                <Label htmlFor="include-conversation" className="text-sm font-medium cursor-pointer">Incluir historico da conversa na descricao</Label>
                <p className="text-xs text-muted-foreground mt-0.5">{includeConversation ? `${messages.length} mensagens serao incluidas` : 'O lead sera criado sem o historico'}</p>
              </div>
            </div>
            {includeConversation && messages.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Previa da conversa</Label>
                <div className="max-h-40 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap">
                  {formatConversationForDescription(conversation.pushName, conversation.phone, messages.slice(-20))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateLeadOpen(false)}>Cancelar</Button>
            <Button onClick={handleCreateLead} disabled={!leadName.trim() || creating} className="bg-amber-600 hover:bg-amber-700 text-white">
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Target className="size-4" />} Criar Lead
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ========== Create Contact Dialog ========== */}
      <Dialog open={createContactOpen} onOpenChange={setCreateContactOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><UserPlus className="size-5 text-emerald-500" /> Criar Contato no Odoo</DialogTitle>
            <DialogDescription>Crie um contato no Odoo a partir desta conversa do WhatsApp</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label htmlFor="contact-name">Nome do Contato</Label>
              <Input id="contact-name" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Nome do contato" />
            </div>
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground"><Phone className="size-3.5" /><span>{conversation.phone || conversation.jid.split('@')[0]}</span></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateContactOpen(false)}>Cancelar</Button>
            <Button onClick={handleCreateContact} disabled={!contactName.trim() || creatingContact} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              {creatingContact ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />} Criar Contato
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ========== ChatterLink Dialog ========== */}
      <ChatterLinkDialog
        open={chatterLinkOpen}
        onOpenChange={setChatterLinkOpen}
        conversationJid={conversation.jid}
        conversationPhone={conversation.phone}
        conversationPushName={conversation.pushName}
        messages={messages}
        odooConnected={odooConnected}
        onSearchContacts={onSearchContacts || async () => ({ success: false })}
        onSearchLeads={onSearchLeads || async () => ({ success: false })}
        onSearchSales={onSearchSales || async () => ({ success: false })}
        onSearchTasks={onSearchTasks || async () => ({ success: false })}
        onLinkConversation={onLinkConversation || async () => ({ success: false })}
        onLogMessage={onLogMessage || async () => ({ success: false })}
        onLinkAndPostChatter={onLinkAndPostChatter}
      />
    </div>
  )
}
