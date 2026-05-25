'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
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
} from 'lucide-react'

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
}

function formatMessageTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatMessageDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Hoje'
  if (diffDays === 1) return 'Ontem'
  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
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
    case 'pdf': return 'PDF'
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

export function ChatView({
  conversation,
  messages,
  onSendMessage,
  onMarkRead,
}: ChatViewProps) {
  const [inputText, setInputText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages.length, scrollToBottom])

  useEffect(() => {
    if (conversation) onMarkRead(conversation.jid)
  }, [conversation?.jid, onMarkRead])

  // Track scroll position for scroll-to-bottom button
  useEffect(() => {
    // The ScrollArea viewport is the element with data-slot="scroll-area-viewport"
    const viewport = scrollViewportRef.current?.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (!viewport) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      setShowScrollButton(scrollHeight - scrollTop - clientHeight > 150)
    }
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

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

  const displayName = conversation?.name || conversation?.pushName || conversation?.phone || conversation?.jid?.split('@')[0] || ''

  if (!conversation) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-muted/20">
        <div className="flex flex-col items-center gap-3 text-center px-4">
          <div className="size-20 rounded-full bg-muted/60 flex items-center justify-center">
            <MessageSquare className="size-8 text-muted-foreground/50" />
          </div>
          <h3 className="text-lg font-semibold text-muted-foreground">Nenhuma conversa selecionada</h3>
          <p className="text-sm text-muted-foreground/70 max-w-[280px]">
            Selecione uma conversa da lista para ver as mensagens
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header — fixed */}
      <div className="shrink-0 border-b bg-background/95 backdrop-blur">
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
            </div>
          </div>
        </div>
      </div>

      {/* Messages — scrollable */}
      <div className="flex-1 min-h-0 relative">
        <ScrollArea ref={scrollViewportRef} className="h-full">
          <div className="px-4 py-3 space-y-1">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16">
                <div className="size-14 rounded-full bg-muted/50 flex items-center justify-center mb-3">
                  <MessageSquare className="size-6 text-muted-foreground/40" />
                </div>
                <p className="text-sm text-muted-foreground">Sem mensagens</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Envie uma mensagem para iniciar</p>
              </div>
            ) : (
              messages.map((message, index) => {
                const prevMessage = index > 0 ? messages[index - 1] : undefined
                const showDateDivider = shouldShowDateDivider(message, prevMessage)
                const isConsecutive = prevMessage && prevMessage.fromMe === message.fromMe &&
                  new Date(message.timestamp).getTime() - new Date(prevMessage.timestamp).getTime() < 60000

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
                        {message.textContent && (
                          <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">{message.textContent}</p>
                        )}
                        {message.mediaType && !message.textContent && (
                          <p className="text-[13px] leading-relaxed italic opacity-70">{getMediaLabel(message.mediaType)}</p>
                        )}
                        <div className={cn('flex items-center gap-1 mt-0.5', message.fromMe ? 'justify-end' : 'justify-start')}>
                          <span className={cn('text-[10px]', message.fromMe ? 'text-white/60' : 'text-muted-foreground')}>
                            {formatMessageTime(message.timestamp)}
                          </span>
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

      {/* Input — fixed */}
      <Separator />
      <div className="shrink-0 px-4 py-3 bg-background">
        <div className="flex items-center gap-2">
          <Input ref={inputRef} placeholder="Digite uma mensagem..." className="flex-1 h-10 text-sm" value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={handleKeyDown} disabled={isSending} />
          <Button size="icon" className="size-10 shrink-0 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleSend} disabled={!inputText.trim() || isSending}>
            {isSending ? <span className="size-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
