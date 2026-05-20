'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Search,
  Link2,
  CheckCircle2,
  Loader2,
  User,
  TrendingUp,
  ShoppingCart,
  ClipboardList,
  X,
  Phone,
  MessageSquare,
} from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
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
import { Separator } from '@/components/ui/separator'
import { OdooRecordCard } from './OdooRecordCard'

// ---------- Types ----------

interface ChatterLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationJid: string
  conversationPhone: string | null
  conversationPushName: string | null
  messages: Array<{ fromMe: boolean; textContent: string | null; mediaType: string | null; timestamp: string }>
  odooConnected: boolean
  onSearchContacts: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onSearchLeads: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onSearchSales: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onSearchTasks: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onLinkConversation: (data: { jid: string; model: string; recordId: number; phone?: string }) => Promise<{ success: boolean }>
  onLogMessage: (data: { model: string; recordId: number; message: string; fromWhatsApp?: boolean }) => Promise<{ success: boolean }>
  onLinkAndPostChatter?: (data: { jid: string; model: string; recordId: number; phone?: string; messages?: any[]; postToChatter?: boolean }) => Promise<{ success: boolean; messagesPosted?: number }>
}

type ModelKey = 'contacts' | 'leads' | 'sales' | 'tasks'

interface LinkedRecord {
  model: string
  recordId: number
  record: any
}

// ---------- Tab config ----------

const TAB_CONFIG: Record<ModelKey, { model: string; label: string; icon: React.ElementType; placeholder: string }> = {
  contacts: { model: 'res.partner', label: 'Contatos', icon: User, placeholder: 'Buscar contato por nome, telefone...' },
  leads: { model: 'crm.lead', label: 'Oportunidades', icon: TrendingUp, placeholder: 'Buscar oportunidade por nome, empresa...' },
  sales: { model: 'sale.order', label: 'Vendas', icon: ShoppingCart, placeholder: 'Buscar venda por nome, cliente...' },
  tasks: { model: 'project.task', label: 'Projetos', icon: ClipboardList, placeholder: 'Buscar tarefa por nome, projeto...' },
}

// ---------- Main Component ----------

export function ChatterLinkDialog({
  open,
  onOpenChange,
  conversationJid,
  conversationPhone,
  conversationPushName,
  messages,
  odooConnected,
  onSearchContacts,
  onSearchLeads,
  onSearchSales,
  onSearchTasks,
  onLinkConversation,
  onLogMessage,
  onLinkAndPostChatter,
}: ChatterLinkDialogProps) {
  const [activeTab, setActiveTab] = useState<ModelKey>('contacts')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchSearched, setSearchSearched] = useState(false)
  const [linkingId, setLinkingId] = useState<number | null>(null)
  const [linkedRecords, setLinkedRecords] = useState<LinkedRecord[]>([])
  const [postToChatter, setPostToChatter] = useState(true)
  const [logDialogOpen, setLogDialogOpen] = useState(false)
  const [logTarget, setLogTarget] = useState<LinkedRecord | null>(null)
  const [logMessage, setLogMessage] = useState('')
  const [logging, setLogging] = useState(false)

  // ---------- Search ----------
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const performSearch = useCallback(async (query: string) => {
    setSearchLoading(true)
    setSearchSearched(true)
    try {
      const trimmed = query.trim() || undefined
      let result: { success: boolean; data?: any[] }
      switch (activeTab) {
        case 'contacts': result = await onSearchContacts(trimmed, 20); break
        case 'leads': result = await onSearchLeads(trimmed, 20); break
        case 'sales': result = await onSearchSales(trimmed, 20); break
        case 'tasks': result = await onSearchTasks(trimmed, 20); break
        default: result = { success: false }
      }
      setSearchResults(result.success && result.data ? result.data : [])
    } catch {
      setSearchResults([])
    } finally {
      setSearchLoading(false)
    }
  }, [activeTab, onSearchContacts, onSearchLeads, onSearchSales, onSearchTasks])

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      if (odooConnected) performSearch(value)
    }, 400)
  }, [odooConnected, performSearch])

  // Auto-search on open/tab change
  useEffect(() => {
    if (open && odooConnected) {
      setSearchResults([])
      setSearchSearched(false)
      performSearch('')
    }
  }, [open, activeTab, odooConnected, performSearch])

  // ---------- Link ----------
  const handleLink = useCallback(async (model: string, recordId: number) => {
    setLinkingId(recordId)
    try {
      const record = searchResults.find(r => r.id === recordId)
      const phone = conversationPhone || conversationJid.split('@')[0]

      if (onLinkAndPostChatter && postToChatter && messages.length > 0) {
        await onLinkAndPostChatter({
          jid: conversationJid,
          model,
          recordId,
          phone,
          messages: messages.map(m => ({
            fromMe: m.fromMe,
            textContent: m.textContent,
            mediaType: m.mediaType,
            timestamp: m.timestamp,
          })),
          postToChatter: true,
        })
      } else {
        await onLinkConversation({ jid: conversationJid, model, recordId, phone })
      }

      setLinkedRecords(prev => {
        const filtered = prev.filter(lr => lr.model !== model)
        return [...filtered, { model, recordId, record }]
      })
    } catch (err) {
      console.error('Link error:', err)
    } finally {
      setLinkingId(null)
    }
  }, [conversationJid, conversationPhone, searchResults, onLinkConversation, onLinkAndPostChatter, postToChatter, messages])

  const isRecordLinked = useCallback((model: string, recordId: number) => {
    return linkedRecords.some(lr => lr.model === model && lr.recordId === recordId)
  }, [linkedRecords])

  // ---------- Log ----------
  const handleLogMessage = useCallback(async () => {
    if (!logTarget || !logMessage.trim()) return
    setLogging(true)
    try {
      await onLogMessage({ model: logTarget.model, recordId: logTarget.recordId, message: logMessage.trim(), fromWhatsApp: true })
      setLogMessage('')
      setLogDialogOpen(false)
      setLogTarget(null)
    } finally {
      setLogging(false)
    }
  }, [logTarget, logMessage, onLogMessage])

  const displayName = conversationPushName || conversationPhone || conversationJid.split('@')[0]

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="size-5 text-primary" />
              Vincular ao Chatter do Odoo
            </DialogTitle>
            <DialogDescription>
              Vincule esta conversa de WhatsApp com {displayName} a um registro do Odoo e poste o historico no chatter
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Phone className="size-3.5" />
            <span>{conversationPhone || conversationJid.split('@')[0]}</span>
            {conversationPushName && (
              <Badge variant="outline" className="text-[10px]">{conversationPushName}</Badge>
            )}
            <Badge variant="outline" className="text-[10px]">{messages.length} mensagens</Badge>
          </div>

          {/* Post to chatter option */}
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <input
              type="checkbox"
              id="post-chatter"
              checked={postToChatter}
              onChange={(e) => setPostToChatter(e.target.checked)}
              className="size-4 rounded border-gray-300"
            />
            <div className="flex-1">
              <Label htmlFor="post-chatter" className="text-sm font-medium cursor-pointer">
                Postar historico da conversa no Chatter
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {postToChatter
                  ? `${messages.length} mensagens serao postadas no chatter do registro vinculado`
                  : 'Apenas vincular o numero de WhatsApp ao registro, sem postar mensagens'
                }
              </p>
            </div>
          </div>

          {/* Linked records */}
          {linkedRecords.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Vinculados</h4>
              <div className="flex flex-col gap-1.5">
                {linkedRecords.map(lr => (
                  <div key={`${lr.model}-${lr.recordId}`} className="flex items-center gap-2 rounded-lg border bg-emerald-50 p-2">
                    <CheckCircle2 className="size-4 text-emerald-600" />
                    <OdooRecordCard model={lr.model as any} record={lr.record || { id: lr.recordId, name: `#${lr.recordId}` }} compact />
                    <div className="flex shrink-0 items-center gap-1 ml-auto">
                      <Button variant="ghost" size="icon" className="size-7" onClick={() => { setLogTarget(lr); setLogDialogOpen(true) }}>
                        <MessageSquare className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Separator />

          {/* Model Tabs */}
          <div className="flex gap-1">
            {(Object.entries(TAB_CONFIG) as [ModelKey, typeof TAB_CONFIG[ModelKey]][]).map(([key, cfg]) => {
              const Icon = cfg.icon
              return (
                <Button
                  key={key}
                  variant={activeTab === key ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1 gap-1 text-xs h-8"
                  onClick={() => setActiveTab(key)}
                >
                  <Icon className="size-3.5" />
                  {cfg.label}
                </Button>
              )
            })}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={TAB_CONFIG[activeTab].placeholder}
              className="h-9 pl-8 text-sm pr-8"
            />
            {searchQuery && (
              <Button variant="ghost" size="icon" className="absolute right-0 top-0 size-9" onClick={() => { setSearchQuery(''); performSearch('') }}>
                <X className="size-3" />
              </Button>
            )}
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto max-h-[400px]">
            <div className="space-y-2 p-1">
              {searchLoading && (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
                      <Skeleton className="size-9 rounded-lg" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!searchLoading && searchSearched && searchResults.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Search className="size-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">Nenhum resultado encontrado</p>
                </div>
              )}

              {!searchLoading && searchResults.map((record) => {
                const linked = isRecordLinked(TAB_CONFIG[activeTab].model, record.id)
                return (
                  <div key={record.id} className="relative">
                    <OdooRecordCard
                      model={TAB_CONFIG[activeTab].model as any}
                      record={record}
                      compact
                      onLink={linked ? undefined : () => handleLink(TAB_CONFIG[activeTab].model, record.id)}
                    />
                    {linked && (
                      <div className="absolute right-2 top-2">
                        <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px]">
                          <CheckCircle2 className="size-3" /> Vinculado
                        </Badge>
                      </div>
                    )}
                    {linkingId === record.id && (
                      <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/80">
                        <Loader2 className="size-5 animate-spin text-primary" />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Log Message Dialog */}
      <Dialog open={logDialogOpen} onOpenChange={setLogDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="size-4" /> Registrar Mensagem
            </DialogTitle>
            <DialogDescription>Registre uma mensagem no registro vinculado do Odoo</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {logTarget && <div className="text-sm text-muted-foreground">{logTarget.model} #{logTarget.recordId}</div>}
            <Textarea value={logMessage} onChange={(e) => setLogMessage(e.target.value)} placeholder="Digite a mensagem..." rows={4} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogDialogOpen(false)}>Cancelar</Button>
            <Button onClick={handleLogMessage} disabled={!logMessage.trim() || logging}>
              {logging ? <Loader2 className="size-4 animate-spin" /> : <MessageSquare className="size-4" />} Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
