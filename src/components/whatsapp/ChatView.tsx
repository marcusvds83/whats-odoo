'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { MediaMessage } from '@/components/whatsapp/MediaMessage'
import { EmojiPicker } from '@/components/whatsapp/EmojiPicker'
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
  DownloadCloud,
  Loader2,
  Link2,
  Trash2,
  RefreshCw,
  Mic,
  Smile,
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
    mediaUrl?: string | null
    mediaBase64?: string | null
    fileName?: string | null
    mimeType?: string | null
    mediaDuration?: number | null
    timestamp: string
    status: string
  }>
  onSendMessage: (jid: string, text: string) => Promise<boolean>
  // v7.22: Send media (image/audio/video/document)
  onSendMedia?: (jid: string, file: File, caption?: string) => Promise<{ success: boolean; error?: string }>
  onMarkRead: (jid: string) => void
  // New in v7.9: pull history from Odoo
  odooConnected?: boolean
  odooLinkedRecords?: Array<{ model: string; recordId: number; recordName?: string }>
  onFetchOdooHistory?: (model: string, recordId: number) => Promise<{ success: boolean; data?: Array<{
    externalId: string
    fromMe: boolean
    textContent: string | null
    mediaType: string | null
    timestamp: string
    source: string
  }>; error?: string }>
  onInjectHistory?: (jid: string, messages: any[]) => Promise<{ success: boolean; added?: number; skipped?: number; error?: string }>
  // New in v7.12: delete conversation
  onDeleteConversation?: (jid: string) => void
  // New in v7.14/v7.15: manual refresh messages button — fetches FROM THE PHONE
  onRefreshMessages?: (jid: string) => Promise<{ success: boolean; count?: number; serverFetchAttempted?: boolean; serverFetchMethods?: string[]; error?: string }>
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
  onSendMedia,
  onMarkRead,
  odooConnected,
  odooLinkedRecords,
  onFetchOdooHistory,
  onInjectHistory,
  onDeleteConversation,
  onRefreshMessages,
}: ChatViewProps) {
  const [inputText, setInputText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isSendingMedia, setIsSendingMedia] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [isPullingHistory, setIsPullingHistory] = useState(false)
  const [pullResult, setPullResult] = useState<{ added: number; skipped: number } | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState<{ count: number; serverFetchAttempted: boolean; methods?: string[] } | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages.length, scrollToBottom])

  useEffect(() => {
    if (conversation) onMarkRead(conversation.jid)
  }, [conversation?.jid, onMarkRead])

  // Reset pull result when conversation changes
  useEffect(() => {
    setPullResult(null)
    setRefreshResult(null)
  }, [conversation?.jid])

  // Pull history from Odoo — used when the user comes back the next day
  // and the local conversation history was lost from memory.
  const handlePullFromOdoo = useCallback(async () => {
    if (!conversation || !odooLinkedRecords || odooLinkedRecords.length === 0) return
    if (!onFetchOdooHistory || !onInjectHistory) return

    setIsPullingHistory(true)
    setPullResult(null)
    try {
      // Pull from all linked records (typically just one lead or contact)
      const allMessages: any[] = []
      for (const rec of odooLinkedRecords) {
        const result = await onFetchOdooHistory(rec.model, rec.recordId)
        if (result.success && result.data) {
          allMessages.push(...result.data)
        }
      }

      if (allMessages.length === 0) {
        setPullResult({ added: 0, skipped: 0 })
        setTimeout(() => setPullResult(null), 3000)
        return
      }

      // Inject into local conversation
      const injectResult = await onInjectHistory(conversation.jid, allMessages)
      if (injectResult.success) {
        setPullResult({
          added: injectResult.added || 0,
          skipped: injectResult.skipped || 0,
        })
        setTimeout(() => setPullResult(null), 5000)
      } else {
        setPullResult({ added: 0, skipped: 0 })
        setTimeout(() => setPullResult(null), 3000)
      }
    } catch (err) {
      setPullResult({ added: 0, skipped: 0 })
      setTimeout(() => setPullResult(null), 3000)
    } finally {
      setIsPullingHistory(false)
    }
  }, [conversation, odooLinkedRecords, onFetchOdooHistory, onInjectHistory])

  // v7.14/v7.15: Manual refresh messages — fetches latest messages FROM THE PHONE.
  // Calls server which uses BOTH `fetchMessageHistory` (older messages) AND
  // `resyncAppState` (force full app-state re-sync) to bring in messages that
  // may have been missed by `messages.upsert`. This is the manual fallback the
  // user requested — "o botão na conversa pra trazer mensagens... do aparelho".
  const handleRefreshMessages = useCallback(async () => {
    if (!conversation || !onRefreshMessages) return
    setIsRefreshing(true)
    setRefreshResult(null)
    try {
      const result = await onRefreshMessages(conversation.jid)
      if (result.success) {
        setRefreshResult({
          count: result.count || 0,
          serverFetchAttempted: !!result.serverFetchAttempted,
          // v7.15: show what server methods were attempted
          methods: (result as any).serverFetchMethods || [],
        })
        setTimeout(() => setRefreshResult(null), 5000)
      } else {
        setRefreshResult({ count: 0, serverFetchAttempted: false, methods: [] })
        setTimeout(() => setRefreshResult(null), 3000)
      }
    } catch (err) {
      setRefreshResult({ count: 0, serverFetchAttempted: false, methods: [] })
      setTimeout(() => setRefreshResult(null), 3000)
    } finally {
      setIsRefreshing(false)
    }
  }, [conversation, onRefreshMessages])

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

  // v7.22: Handle media file selection (image/audio/document)
  const handleFileSelect = async (file: File, caption?: string) => {
    if (!conversation || !onSendMedia || isSendingMedia) return
    setIsSendingMedia(true)
    try {
      const result = await onSendMedia(conversation.jid, file, caption)
      if (!result.success) {
        console.error('[ChatView] Failed to send media:', result.error)
        // Could add a toast here, but the existing code uses console only
      }
    } finally {
      setIsSendingMedia(false)
    }
  }

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
    // Reset input so same file can be selected again
    e.target.value = ''
  }

  const handleAudioSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
    e.target.value = ''
  }

  const handleDocumentSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
    e.target.value = ''
  }

  // Insert emoji at cursor position in the input
  const handleEmojiSelect = (emoji: string) => {
    const input = inputRef.current
    if (!input) {
      setInputText(prev => prev + emoji)
      return
    }
    const start = input.selectionStart ?? inputText.length
    const end = input.selectionEnd ?? inputText.length
    const next = inputText.slice(0, start) + emoji + inputText.slice(end)
    setInputText(next)
    // Restore cursor position after emoji
    requestAnimationFrame(() => {
      const pos = start + emoji.length
      input.focus()
      input.setSelectionRange(pos, pos)
    })
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
          <Avatar className="size-10 shrink-0">
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
              {odooLinkedRecords && odooLinkedRecords.length > 0 && (
                <Badge variant="outline" className="ml-1 text-[10px] gap-0.5 py-0 h-4 bg-amber-50 text-amber-700 border-amber-200">
                  <Link2 className="size-2.5" />
                  Odoo
                </Badge>
              )}
            </div>
          </div>

          {/* Pull from Odoo button — only shown when conversation is linked to Odoo */}
          {odooConnected && odooLinkedRecords && odooLinkedRecords.length > 0 && onFetchOdooHistory && onInjectHistory && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 shrink-0 text-xs"
                    disabled={isPullingHistory}
                    onClick={handlePullFromOdoo}
                  >
                    {isPullingHistory ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <DownloadCloud className="size-3.5" />
                    )}
                    <span className="hidden sm:inline">
                      {isPullingHistory ? 'Buscando...' : 'Trazer do Odoo'}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p>Busca o histórico da conversa armazenado no Odoo (chatter) e mescla com a conversa local atual.</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Use quando voltar no dia seguinte e o histórico do WhatsApp não estiver mais carregado.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* v7.15: Refresh messages button — fetches latest messages FROM THE PHONE */}
          {onRefreshMessages && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 shrink-0 text-xs border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                    disabled={isRefreshing}
                    onClick={handleRefreshMessages}
                  >
                    {isRefreshing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    <span className="hidden sm:inline">
                      {isRefreshing ? 'Buscando...' : 'Buscar no aparelho'}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  <p className="font-medium">Busca as mensagens mais recentes do aparelho conectado.</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Força uma ressincronização com o WhatsApp (resyncAppState + fetchMessageHistory).
                    Use se uma mensagem não chegou automaticamente.
                  </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* v7.15: Refresh result feedback */}
          {refreshResult && (
            <div className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] shrink-0',
              refreshResult.count > 0
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-muted text-muted-foreground border'
            )}>
              <CheckCheck className="size-3" />
              <span>{refreshResult.count} msgs</span>
              {refreshResult.serverFetchAttempted && (
                <span className="text-[9px] text-muted-foreground ml-1">
                  ({refreshResult.methods?.join('+') || 'servidor'})
                </span>
              )}
            </div>
          )}

          {/* Pull result feedback */}
          {pullResult && (
            <div className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] shrink-0',
              pullResult.added > 0
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : 'bg-muted text-muted-foreground border'
            )}>
              {pullResult.added > 0 ? (
                <>
                  <CheckCheck className="size-3" />
                  <span>+{pullResult.added} mensagens</span>
                </>
              ) : (
                <span>Nada novo</span>
              )}
            </div>
          )}

          {/* Delete conversation button */}
          {onDeleteConversation && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => onDeleteConversation(conversation.jid)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  Excluir conversa
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
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
                        {/* v7.22: Render actual media (image/audio/video/document) inline */}
                        {message.mediaType && message.mediaType !== '' && (
                          <MediaMessage
                            mediaType={message.mediaType}
                            mediaUrl={message.mediaUrl}
                            mediaBase64={message.mediaBase64}
                            fileName={message.fileName}
                            mimeType={message.mimeType}
                            mediaDuration={message.mediaDuration}
                            fromMe={message.fromMe}
                          />
                        )}
                        {message.textContent && (
                          <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">{message.textContent}</p>
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

      {/* Hidden file inputs for media uploads */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageSelect}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleAudioSelect}
      />
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleDocumentSelect}
      />

      {/* Input — fixed */}
      <Separator />
      <div className="shrink-0 px-3 py-2 bg-background">
        <div className="flex items-center gap-1">
          {/* v7.22: Image upload button */}
          {onSendMedia && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                    disabled={isSendingMedia}
                    onClick={() => imageInputRef.current?.click()}
                  >
                    {isSendingMedia ? <Loader2 className="size-5 animate-spin" /> : <ImageIcon className="size-5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Enviar imagem</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* v7.22: Audio upload button */}
          {onSendMedia && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                    disabled={isSendingMedia}
                    onClick={() => audioInputRef.current?.click()}
                  >
                    <Mic className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Enviar áudio</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* v7.22: Document upload button */}
          {onSendMedia && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                    disabled={isSendingMedia}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Enviar documento</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* v7.22: Emoji picker */}
          <EmojiPicker onEmojiSelect={handleEmojiSelect} />

          <Input ref={inputRef} placeholder="Digite uma mensagem..." className="flex-1 h-10 text-sm" value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={handleKeyDown} disabled={isSending} />
          <Button size="icon" className="size-10 shrink-0 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleSend} disabled={!inputText.trim() || isSending}>
            {isSending ? <span className="size-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
