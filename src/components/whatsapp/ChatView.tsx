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
  Mic,
  Monitor,
  Square,
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
  // v7.24: Send media from raw base64 (used by screenshot capture + mic recording)
  onSendMediaBase64?: (jid: string, opts: { type: 'image' | 'audio' | 'video' | 'document'; base64: string; mimeType: string; fileName?: string; caption?: string }) => Promise<{ success: boolean; error?: string }>
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
  onSendMediaBase64,
  onMarkRead,
  odooConnected,
  odooLinkedRecords,
  onFetchOdooHistory,
  onInjectHistory,
  onDeleteConversation,
}: ChatViewProps) {
  const [inputText, setInputText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isSendingMedia, setIsSendingMedia] = useState(false)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const [isPullingHistory, setIsPullingHistory] = useState(false)
  const [pullResult, setPullResult] = useState<{ added: number; skipped: number } | null>(null)
  // v7.24: Microphone recording state (R4)
  const [isRecording, setIsRecording] = useState(false)
  const [recordSeconds, setRecordSeconds] = useState(0)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // v7.24: MediaRecorder + active stream refs (R4 mic recording)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const recordingStreamRef = useRef<MediaStream | null>(null)
  const recordTimerRef = useRef<NodeJS.Timeout | null>(null)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages.length, scrollToBottom])

  useEffect(() => {
    if (conversation) onMarkRead(conversation.jid)
  }, [conversation?.jid, onMarkRead])

  // Reset pull result when conversation changes
  // v7.29.5: REMOVED stray `setRefreshResult(null)` call — that setter was
  // never declared (the state was renamed to `pullResult`/`setPullResult`
  // long ago). Calling an undefined function threw `setRefreshResult is not
  // defined` inside a useEffect, which crashed the entire ChatView component
  // the moment the user clicked a conversation. The error was uncaught by
  // React's render path (it happened inside useEffect) and surfaced as the
  // error boundary "Algo deu errado" page — making it look like the app
  // was broken on every conversation click.
  useEffect(() => {
    setPullResult(null)
  }, [conversation?.jid])

  // v7.24 (R5): Auto-focus the text input when the conversation changes,
  // so the user can immediately type without clicking the input.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [conversation?.jid])

  // v7.24 (R4): cleanup any ongoing recording if the conversation changes
  // or the component unmounts — we don't want to leak mic streams.
  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop() } catch {}
      }
      recordingStreamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

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

  // (v7.28: "Buscar no aparelho" button removed — auto-sync now handles this)
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
      // v7.24 (R5): always re-focus the input after sending
      requestAnimationFrame(() => inputRef.current?.focus())
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
        setMediaError(result.error || 'Falha ao enviar mídia')
      }
    } finally {
      setIsSendingMedia(false)
      // v7.24 (R5): re-focus the text input after sending media
      requestAnimationFrame(() => inputRef.current?.focus())
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

  // v7.24 (R3): Capture a screenshot via getDisplayMedia and send as image.
  // Works in Chrome/Edge/Firefox (requires HTTPS or localhost). The user
  // will be prompted to pick a screen/window/tab to share; we grab one
  // frame from the resulting video track, draw it to a canvas, and ship
  // the PNG via the base64 socket event.
  const handleScreenshot = async () => {
    if (!conversation || !onSendMediaBase64 || isSendingMedia) return
    setMediaError(null)
    setIsSendingMedia(true)
    let stream: MediaStream | null = null
    try {
      // @ts-ignore — some TS lib versions don't include getDisplayMedia
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('Nenhuma faixa de vídeo disponível')

      // Wait for the track to actually produce a frame. The browser needs
      // a moment after the user picks the source before frames are ready.
      await new Promise(r => setTimeout(r, 300))

      // Use ImageCapture when available (cleaner API), otherwise fall back
      // to the video element + canvas approach.
      let blob: Blob | null = null
      // @ts-ignore
      if (typeof window !== 'undefined' && 'ImageCapture' in window && track) {
        try {
          // @ts-ignore
          const ic = new window.ImageCapture(track)
          // @ts-ignore
          const bitmap = await ic.grabFrame()
          const canvas = document.createElement('canvas')
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
          blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
        } catch {
          // fall through to video-element approach
        }
      }

      if (!blob) {
        // Fallback: render the track to a <video> element and snapshot it.
        const video = document.createElement('video')
        video.srcObject = new MediaStream([track])
        video.muted = true
        await video.play()
        await new Promise(r => setTimeout(r, 200))
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth || 1280
        canvas.height = video.videoHeight || 720
        canvas.getContext('2d')!.drawImage(video, 0, 0)
        blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
        video.pause()
        video.srcObject = null
      }

      if (!blob) throw new Error('Falha ao capturar a imagem')

      // Convert blob to base64 and ship via the base64 socket event.
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          resolve(dataUrl.split(',')[1])
        }
        reader.onerror = () => reject(new Error('Falha ao ler o arquivo'))
        reader.readAsDataURL(blob!)
      })

      const fileName = `print-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
      const result = await onSendMediaBase64(conversation.jid, {
        type: 'image', base64, mimeType: 'image/png', fileName,
      })
      if (!result.success) {
        setMediaError(result.error || 'Falha ao enviar print')
      }
    } catch (err: any) {
      console.error('[ChatView] Screenshot error:', err)
      if (err?.name === 'NotAllowedError') {
        setMediaError('Permissão de captura de tela negada')
      } else {
        setMediaError(err?.message || 'Falha ao capturar a tela')
      }
    } finally {
      // Always stop the screen-share stream so the browser UI stops the
      // "sharing" indicator.
      stream?.getTracks().forEach(t => t.stop())
      setIsSendingMedia(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  // v7.24 (R4): Start microphone recording. Requests getUserMedia and
  // records audio via MediaRecorder. The red pulsing indicator + timer
  // show the user that recording is in progress. On stop, the audio is
  // converted to base64 and sent via the base64 socket event.
  const handleStartRecording = async () => {
    if (!conversation || !onSendMediaBase64 || isRecording) return
    setMediaError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recordingStreamRef.current = stream
      recordedChunksRef.current = []

      // Pick the best mime type the browser supports. Chrome supports
      // audio/webm; Safari supports audio/mp4. Fall back to '' (default).
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', '']
      let mimeType = ''
      for (const c of candidates) {
        if (c === '' || MediaRecorder.isTypeSupported(c)) { mimeType = c; break }
      }

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        const chunks = recordedChunksRef.current
        if (chunks.length === 0) {
          cleanupRecording()
          return
        }
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve((reader.result as string).split(',')[1])
          reader.onerror = () => reject(new Error('Falha ao ler áudio'))
          reader.readAsDataURL(blob)
        })
        const ext = mimeType.includes('mp4') ? 'm4a' : 'webm'
        const fileName = `audio-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`
        try {
          const result = await onSendMediaBase64!(conversation.jid, {
            type: 'audio', base64,
            mimeType: mimeType || 'audio/webm',
            fileName,
          })
          if (!result.success) {
            setMediaError(result.error || 'Falha ao enviar áudio')
          }
        } finally {
          cleanupRecording()
          requestAnimationFrame(() => inputRef.current?.focus())
        }
      }

      recorder.start()
      setIsRecording(true)
      setRecordSeconds(0)
      recordTimerRef.current = setInterval(() => {
        setRecordSeconds(s => s + 1)
      }, 1000)
    } catch (err: any) {
      console.error('[ChatView] Mic recording error:', err)
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        setMediaError('Permissão de microfone negada. Verifique as permissões do navegador.')
      } else if (err?.name === 'NotFoundError') {
        setMediaError('Nenhum microfone encontrado no dispositivo.')
      } else {
        setMediaError(err?.message || 'Falha ao iniciar gravação')
      }
      cleanupRecording()
    }
  }

  const cleanupRecording = () => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null }
    recordingStreamRef.current?.getTracks().forEach(t => t.stop())
    recordingStreamRef.current = null
    mediaRecorderRef.current = null
    recordedChunksRef.current = []
    setIsRecording(false)
    setRecordSeconds(0)
  }

  const handleStopRecording = () => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch {}
    } else {
      cleanupRecording()
    }
    // isRecording will be cleared in cleanupRecording() (called from onstop)
    // but we set it false here too so the UI flips immediately.
    setIsRecording(false)
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null }
  }

  // v7.24 (R4): Format seconds as MM:SS for the recording timer.
  const formatRecordTime = (s: number) => {
    const m = Math.floor(s / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
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
        {/* v7.24 (R4): Recording indicator + error banner */}
        {isRecording && (
          <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-red-50 border border-red-200 rounded-lg">
            <span className="size-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-medium text-red-700">Gravando áudio…</span>
            <span className="text-xs text-red-600 font-mono">{formatRecordTime(recordSeconds)}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2 text-red-700 hover:bg-red-100"
              onClick={handleStopRecording}
            >
              <Square className="size-3.5 fill-current" />
              <span className="ml-1 text-xs">Parar</span>
            </Button>
          </div>
        )}
        {mediaError && (
          <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
            <span className="text-xs text-amber-800 flex-1">{mediaError}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-amber-700 hover:bg-amber-100"
              onClick={() => setMediaError(null)}
            >
              <span className="text-xs">Dispensar</span>
            </Button>
          </div>
        )}
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
                    disabled={isSendingMedia || isRecording}
                    onClick={() => imageInputRef.current?.click()}
                  >
                    {isSendingMedia ? <Loader2 className="size-5 animate-spin" /> : <ImageIcon className="size-5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Enviar imagem</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* v7.22: Audio upload button (file picker — for uploading existing audio) */}
          {onSendMedia && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                    disabled={isSendingMedia || isRecording}
                    onClick={() => audioInputRef.current?.click()}
                  >
                    <FileText className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Enviar arquivo de áudio</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* v7.24 (R4): Microphone recording button — records from the
              computer's mic and sends as audio/webm. Toggles between
              "start" (Mic icon, normal color) and "stop" (Square icon, red). */}
          {onSendMediaBase64 && !isRecording && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                    disabled={isSendingMedia}
                    onClick={handleStartRecording}
                  >
                    <Mic className="size-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Gravar áudio do microfone</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {onSendMediaBase64 && isRecording && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0 rounded-full text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={handleStopRecording}
                  >
                    <Square className="size-5 fill-current" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Parar gravação</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* v7.24 (R3): Screenshot / screen-capture button */}
          {onSendMediaBase64 && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                    disabled={isSendingMedia || isRecording}
                    onClick={handleScreenshot}
                  >
                    {isSendingMedia ? <Loader2 className="size-5 animate-spin" /> : <Monitor className="size-5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Print de tela</TooltipContent>
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
                    disabled={isSendingMedia || isRecording}
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

          <Input ref={inputRef} placeholder="Digite uma mensagem..." className="flex-1 h-10 text-sm" value={inputText} onChange={(e) => setInputText(e.target.value)} onKeyDown={handleKeyDown} disabled={isSending || isRecording} />
          <Button size="icon" className="size-10 shrink-0 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleSend} disabled={!inputText.trim() || isSending || isRecording}>
            {isSending ? <span className="size-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
