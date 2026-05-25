'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Search,
  Plus,
  Link2,
  CheckCircle2,
  Loader2,
  User,
  TrendingUp,
  ShoppingCart,
  ClipboardList,
  X,
  Phone,
  Mail,
  MessageSquare,
  Unlink,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { OdooRecordCard } from './OdooRecordCard'

// ---------- Types ----------

interface OdooLinkPanelProps {
  conversationJid: string
  conversationPhone: string | null
  onLinkConversation: (data: { jid: string; model: string; recordId: number; phone?: string }) => Promise<{ success: boolean }>
  onSearchContacts: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onSearchLeads: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onSearchSales: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onSearchTasks: (query?: string, limit?: number) => Promise<{ success: boolean; data?: any[] }>
  onCreateLead: (data: any) => Promise<{ success: boolean; id?: number }>
  onCreateContact: (data: any) => Promise<{ success: boolean; id?: number }>
  onCreateTask: (data: any) => Promise<{ success: boolean; id?: number }>
  onLogMessage: (data: { model: string; recordId: number; message: string; fromWhatsApp?: boolean }) => Promise<{ success: boolean }>
  odooConnected: boolean
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
  leads: { model: 'crm.lead', label: 'Leads', icon: TrendingUp, placeholder: 'Buscar lead por nome, empresa...' },
  sales: { model: 'sale.order', label: 'Vendas', icon: ShoppingCart, placeholder: 'Buscar venda por nome, cliente...' },
  tasks: { model: 'project.task', label: 'Projetos', icon: ClipboardList, placeholder: 'Buscar tarefa por nome, projeto...' },
}

// ---------- Debounce helper ----------

function useDebounce(callback: (tab: ModelKey, query: string) => void, delay: number) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbackRef = useRef(callback)

  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return useCallback((tab: ModelKey, query: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => callbackRef.current(tab, query), delay)
  }, [delay])
}

// ---------- Main Component ----------

export function OdooLinkPanel({
  conversationJid,
  conversationPhone,
  onLinkConversation,
  onSearchContacts,
  onSearchLeads,
  onSearchSales,
  onSearchTasks,
  onCreateLead,
  onCreateContact,
  onCreateTask,
  onLogMessage,
  odooConnected,
}: OdooLinkPanelProps) {
  const [activeTab, setActiveTab] = useState<ModelKey>('contacts')

  // Search state per tab
  const [searchQueries, setSearchQueries] = useState<Record<ModelKey, string>>({
    contacts: '',
    leads: '',
    sales: '',
    tasks: '',
  })
  const [searchResults, setSearchResults] = useState<Record<ModelKey, any[]>>({
    contacts: [],
    leads: [],
    sales: [],
    tasks: [],
  })
  const [searchLoading, setSearchLoading] = useState<Record<ModelKey, boolean>>({
    contacts: false,
    leads: false,
    sales: false,
    tasks: false,
  })
  const [searchSearched, setSearchSearched] = useState<Record<ModelKey, boolean>>({
    contacts: false,
    leads: false,
    sales: false,
    tasks: false,
  })

  // Linking state
  const [linkingId, setLinkingId] = useState<number | null>(null)
  const [linkedRecords, setLinkedRecords] = useState<LinkedRecord[]>([])

  // Create dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  // Log message state
  const [logDialogOpen, setLogDialogOpen] = useState(false)
  const [logTarget, setLogTarget] = useState<LinkedRecord | null>(null)
  const [logMessage, setLogMessage] = useState('')
  const [logging, setLogging] = useState(false)

  // ---------- Search logic ----------

  const performSearch = useCallback(
    async (tab: ModelKey, query: string) => {
      setSearchLoading((prev) => ({ ...prev, [tab]: true }))
      setSearchSearched((prev) => ({ ...prev, [tab]: true }))

      try {
        let result: { success: boolean; data?: any[] }
        const trimmed = query.trim() || undefined

        switch (tab) {
          case 'contacts':
            result = await onSearchContacts(trimmed, 20)
            break
          case 'leads':
            result = await onSearchLeads(trimmed, 20)
            break
          case 'sales':
            result = await onSearchSales(trimmed, 20)
            break
          case 'tasks':
            result = await onSearchTasks(trimmed, 20)
            break
        }

        if (result.success && result.data) {
          setSearchResults((prev) => ({ ...prev, [tab]: result.data ?? [] }))
        } else {
          setSearchResults((prev) => ({ ...prev, [tab]: [] }))
        }
      } catch {
        setSearchResults((prev) => ({ ...prev, [tab]: [] }))
      } finally {
        setSearchLoading((prev) => ({ ...prev, [tab]: false }))
      }
    },
    [onSearchContacts, onSearchLeads, onSearchSales, onSearchTasks]
  )

  const debouncedSearch = useDebounce(performSearch, 400)

  const handleSearchChange = useCallback(
    (tab: ModelKey, value: string) => {
      setSearchQueries((prev) => ({ ...prev, [tab]: value }))
      if (odooConnected) {
        debouncedSearch(tab, value)
      }
    },
    [odooConnected, debouncedSearch]
  )

  // Auto-search on tab switch if not yet searched
  useEffect(() => {
    if (odooConnected && !searchSearched[activeTab]) {
      performSearch(activeTab, searchQueries[activeTab])
    }
    }, [activeTab, odooConnected, performSearch, searchQueries, searchSearched])

  // ---------- Link logic ----------

  const handleLink = useCallback(
    async (model: string, recordId: number) => {
      setLinkingId(recordId)
      try {
        const result = await onLinkConversation({
          jid: conversationJid,
          model,
          recordId,
          phone: conversationPhone ?? undefined,
        })
        if (result.success) {
          const record = searchResults[activeTab]?.find((r) => r.id === recordId)
          setLinkedRecords((prev) => {
            const filtered = prev.filter((lr) => lr.model !== model)
            return [...filtered, { model, recordId, record }]
          })
        }
      } finally {
        setLinkingId(null)
      }
    },
    [conversationJid, conversationPhone, onLinkConversation, searchResults, activeTab]
  )

  const handleUnlink = useCallback((model: string) => {
    setLinkedRecords((prev) => prev.filter((lr) => lr.model !== model))
  }, [])

  const isRecordLinked = useCallback(
    (model: string, recordId: number) => {
      return linkedRecords.some((lr) => lr.model === model && lr.recordId === recordId)
    },
    [linkedRecords]
  )

  // ---------- Create logic ----------

  const handleCreate = useCallback(
    async (data: Record<string, string>) => {
      setCreating(true)
      try {
        let result: { success: boolean; id?: number }
        switch (activeTab) {
          case 'contacts':
            result = await onCreateContact({
              name: data.name,
              phone: data.phone || conversationPhone || undefined,
              email: data.email || undefined,
              whatsapp: conversationPhone || undefined,
            })
            break
          case 'leads':
            result = await onCreateLead({
              name: data.name,
              phone: data.phone || conversationPhone || undefined,
              partner_name: data.partner_name || undefined,
              description: data.description || undefined,
              type: 'lead',
              whatsapp_number: conversationPhone || undefined,
            })
            break
          case 'tasks':
            result = await onCreateTask({
              name: data.name,
              description: data.description || undefined,
              whatsapp_number: conversationPhone || undefined,
            })
            break
          default:
            result = { success: false }
        }

        if (result.success && result.id) {
          // Auto-link the created record
          await onLinkConversation({
            jid: conversationJid,
            model: TAB_CONFIG[activeTab].model,
            recordId: result.id,
            phone: conversationPhone ?? undefined,
          })
          // Refresh search
          performSearch(activeTab, searchQueries[activeTab])
          setCreateDialogOpen(false)
        }
      } finally {
        setCreating(false)
      }
    },
    [activeTab, conversationJid, conversationPhone, onCreateContact, onCreateLead, onCreateTask, onLinkConversation, performSearch, searchQueries]
  )

  // ---------- Log message logic ----------

  const handleLogMessage = useCallback(async () => {
    if (!logTarget || !logMessage.trim()) return
    setLogging(true)
    try {
      await onLogMessage({
        model: logTarget.model,
        recordId: logTarget.recordId,
        message: logMessage.trim(),
        fromWhatsApp: true,
      })
      setLogMessage('')
      setLogDialogOpen(false)
      setLogTarget(null)
    } finally {
      setLogging(false)
    }
  }, [logTarget, logMessage, onLogMessage])

  // ---------- Render ----------

  if (!odooConnected) {
    return (
      <Card className="h-full">
        <CardContent className="flex flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <Link2 className="size-5 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground">
            Conecte ao Odoo para vincular registros
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Linked Records Summary */}
      {linkedRecords.length > 0 && (
        <div className="border-b p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Registros Vinculados
          </h3>
          <div className="flex flex-col gap-2">
            {linkedRecords.map((lr) => (
              <div
                key={`${lr.model}-${lr.recordId}`}
                className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2"
              >
                <OdooRecordCard
                  model={lr.model as any}
                  record={lr.record || { id: lr.recordId, name: `#${lr.recordId}` }}
                  compact
                />
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={() => {
                      setLogTarget(lr)
                      setLogDialogOpen(true)
                    }}
                  >
                    <MessageSquare className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-destructive hover:text-destructive"
                    onClick={() => handleUnlink(lr.model)}
                  >
                    <Unlink className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs + Search */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ModelKey)} className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b px-3 pt-3">
          <TabsList className="w-full">
            {(Object.entries(TAB_CONFIG) as [ModelKey, typeof TAB_CONFIG[ModelKey]][]).map(([key, cfg]) => {
              const Icon = cfg.icon
              return (
                <TabsTrigger key={key} value={key} className="flex-1 gap-1 text-xs">
                  <Icon className="size-3.5" />
                  <span className="hidden sm:inline">{cfg.label}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </div>

        {/* Search bar + create */}
        <div className="border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQueries[activeTab]}
                onChange={(e) => handleSearchChange(activeTab, e.target.value)}
                placeholder={TAB_CONFIG[activeTab].placeholder}
                className="h-8 pl-8 text-sm"
              />
              {searchQueries[activeTab] && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 size-8"
                  onClick={() => {
                    setSearchQueries((prev) => ({ ...prev, [activeTab]: '' }))
                    performSearch(activeTab, '')
                  }}
                >
                  <X className="size-3" />
                </Button>
              )}
            </div>

            {/* Create new */}
            {(activeTab === 'contacts' || activeTab === 'leads' || activeTab === 'tasks') && (
              <CreateRecordDialog
                tab={activeTab}
                open={createDialogOpen}
                onOpenChange={setCreateDialogOpen}
                onSubmit={handleCreate}
                creating={creating}
                conversationPhone={conversationPhone}
              />
            )}
          </div>
        </div>

        {/* Results */}
        {(Object.entries(TAB_CONFIG) as [ModelKey, typeof TAB_CONFIG[ModelKey]][]).map(([key, cfg]) => (
          <TabsContent key={key} value={key} className="flex-1 overflow-hidden mt-0">
            <div className="h-full overflow-y-auto">
              <div className="space-y-2 p-3">
                {/* Loading skeleton */}
                {searchLoading[key] && (
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

                {/* No results */}
                {!searchLoading[key] && searchSearched[key] && searchResults[key].length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-8 text-center">
                    <Search className="size-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">Nenhum resultado encontrado</p>
                    <p className="text-xs text-muted-foreground/70">Tente outro termo ou crie um novo registro</p>
                  </div>
                )}

                {/* Results list */}
                {!searchLoading[key] &&
                  searchResults[key].map((record) => {
                    const linked = isRecordLinked(cfg.model, record.id)
                    return (
                      <div key={record.id} className="relative">
                        <OdooRecordCard
                          model={cfg.model as any}
                          record={record}
                          compact
                          onLink={
                            linked
                              ? undefined
                              : () => handleLink(cfg.model, record.id)
                          }
                        />
                        {linked && (
                          <div className="absolute right-2 top-2">
                            <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px] dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800">
                              <CheckCircle2 className="size-3" />
                              Vinculado
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
          </TabsContent>
        ))}
      </Tabs>

      {/* Log Message Dialog */}
      <Dialog open={logDialogOpen} onOpenChange={setLogDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="size-4" />
              Registrar Mensagem
            </DialogTitle>
            <DialogDescription>
              Registre uma mensagem no registro vinculado do Odoo
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {logTarget && (
              <div className="text-sm text-muted-foreground">
                {logTarget.model} &middot; #{logTarget.recordId}
              </div>
            )}
            <Textarea
              value={logMessage}
              onChange={(e) => setLogMessage(e.target.value)}
              placeholder="Digite a mensagem para registrar no Odoo..."
              rows={4}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleLogMessage} disabled={!logMessage.trim() || logging}>
              {logging ? <Loader2 className="size-4 animate-spin" /> : <MessageSquare className="size-4" />}
              Registrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------- Create Record Dialog ----------

interface CreateRecordDialogProps {
  tab: ModelKey
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: Record<string, string>) => Promise<void>
  creating: boolean
  conversationPhone: string | null
}

function CreateRecordDialog({ tab, open, onOpenChange, onSubmit, creating, conversationPhone }: CreateRecordDialogProps) {
  const [formData, setFormData] = useState<Record<string, string>>(() => ({
    name: '',
    phone: conversationPhone ?? '',
    email: '',
    partner_name: '',
    description: '',
  }))

  const resetForm = useCallback(() => {
    setFormData({
      name: '',
      phone: conversationPhone ?? '',
      email: '',
      partner_name: '',
      description: '',
    })
  }, [conversationPhone])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.name?.trim()) return
    onSubmit(formData)
  }

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const config = TAB_CONFIG[tab]
  const Icon = config.icon

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
        if (nextOpen) resetForm()
        onOpenChange(nextOpen)
      }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon" className="size-8 shrink-0">
          <Plus className="size-3.5" />
          <span className="sr-only">Criar novo</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className="size-4" />
              Novo {config.label.slice(0, -1)}
            </DialogTitle>
            <DialogDescription>
              Crie um novo registro e vincule à conversa automaticamente
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            {/* Name - all models */}
            <div className="space-y-1.5">
              <Label htmlFor="create-name">Nome *</Label>
              <Input
                id="create-name"
                value={formData.name ?? ''}
                onChange={(e) => updateField('name', e.target.value)}
                placeholder="Nome do registro"
                required
              />
            </div>

            {/* Phone - contacts & leads */}
            {(tab === 'contacts' || tab === 'leads') && (
              <div className="space-y-1.5">
                <Label htmlFor="create-phone" className="flex items-center gap-1.5">
                  <Phone className="size-3" />
                  Telefone
                </Label>
                <Input
                  id="create-phone"
                  value={formData.phone ?? ''}
                  onChange={(e) => updateField('phone', e.target.value)}
                  placeholder="+55 11 99999-9999"
                />
              </div>
            )}

            {/* Email - contacts */}
            {tab === 'contacts' && (
              <div className="space-y-1.5">
                <Label htmlFor="create-email" className="flex items-center gap-1.5">
                  <Mail className="size-3" />
                  E-mail
                </Label>
                <Input
                  id="create-email"
                  type="email"
                  value={formData.email ?? ''}
                  onChange={(e) => updateField('email', e.target.value)}
                  placeholder="email@exemplo.com"
                />
              </div>
            )}

            {/* Partner name - leads */}
            {tab === 'leads' && (
              <div className="space-y-1.5">
                <Label htmlFor="create-partner-name">Nome da Empresa</Label>
                <Input
                  id="create-partner-name"
                  value={formData.partner_name ?? ''}
                  onChange={(e) => updateField('partner_name', e.target.value)}
                  placeholder="Nome da empresa"
                />
              </div>
            )}

            {/* Description - leads & tasks */}
            {(tab === 'leads' || tab === 'tasks') && (
              <div className="space-y-1.5">
                <Label htmlFor="create-description">Descrição</Label>
                <Textarea
                  id="create-description"
                  value={formData.description ?? ''}
                  onChange={(e) => updateField('description', e.target.value)}
                  placeholder="Detalhes adicionais..."
                  rows={3}
                />
              </div>
            )}
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!formData.name?.trim() || creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Criar e Vincular
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
