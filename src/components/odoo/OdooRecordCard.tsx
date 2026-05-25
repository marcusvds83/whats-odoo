'use client'

import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale/pt-BR'
import {
  User,
  TrendingUp,
  ShoppingCart,
  ClipboardList,
  ExternalLink,
  Link2,
  Phone,
  Mail,
  MapPin,
  Calendar,
  DollarSign,
  AlertCircle,
} from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

// ---------- Types ----------

type OdooModel = 'res.partner' | 'crm.lead' | 'sale.order' | 'project.task'

interface OdooRecordCardProps {
  model: OdooModel
  record: any
  onLink?: () => void
  onOpen?: () => void
  compact?: boolean
}

// ---------- Helpers ----------

const MODEL_CONFIG: Record<
  OdooModel,
  {
    label: string
    icon: React.ElementType
    colorClass: string
    bgClass: string
    borderClass: string
  }
> = {
  'res.partner': {
    label: 'Contato',
    icon: User,
    colorClass: 'text-emerald-700 dark:text-emerald-400',
    bgClass: 'bg-emerald-50 dark:bg-emerald-950/40',
    borderClass: 'border-emerald-200 dark:border-emerald-800',
  },
  'crm.lead': {
    label: 'Lead',
    icon: TrendingUp,
    colorClass: 'text-amber-700 dark:text-amber-400',
    bgClass: 'bg-amber-50 dark:bg-amber-950/40',
    borderClass: 'border-amber-200 dark:border-amber-800',
  },
  'sale.order': {
    label: 'Venda',
    icon: ShoppingCart,
    colorClass: 'text-sky-700 dark:text-sky-400',
    bgClass: 'bg-sky-50 dark:bg-sky-950/40',
    borderClass: 'border-sky-200 dark:border-sky-800',
  },
  'project.task': {
    label: 'Tarefa',
    icon: ClipboardList,
    colorClass: 'text-violet-700 dark:text-violet-400',
    bgClass: 'bg-violet-50 dark:bg-violet-950/40',
    borderClass: 'border-violet-200 dark:border-violet-800',
  },
}

function formatCurrency(value: number | undefined | null): string {
  if (value == null) return '—'
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value)
}

function formatDate(value: string | undefined | null): string {
  if (!value) return '—'
  try {
    return format(new Date(value), "dd/MM/yyyy", { locale: ptBR })
  } catch {
    return value
  }
}

function extractName(tupleOrString: [number, string] | string | false | undefined | null): string {
  if (!tupleOrString) return '—'
  if (Array.isArray(tupleOrString)) return tupleOrString[1] || '—'
  return String(tupleOrString)
}

// ---------- Sub-components ----------

function FieldRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{value}</span>
    </div>
  )
}

// ---------- Model-specific renderers ----------

function ContactFields({ record, compact }: { record: any; compact?: boolean }) {
  return (
    <>
      <FieldRow icon={Phone} label="Telefone" value={record.phone || record.mobile || record.whatsapp} />
      <FieldRow icon={Mail} label="E-mail" value={record.email} />
      {!compact && (
        <>
          <FieldRow icon={MapPin} label="Cidade" value={[record.city, extractName(record.state_id)].filter(Boolean).join(' - ')} />
          {record.is_company && (
            <Badge variant="secondary" className="mt-1 text-[10px]">Empresa</Badge>
          )}
        </>
      )}
    </>
  )
}

function LeadFields({ record, compact }: { record: any; compact?: boolean }) {
  return (
    <>
      <FieldRow icon={Phone} label="Telefone" value={record.phone || record.mobile} />
      {!compact && (
        <>
          <FieldRow icon={Calendar} label="Estágio" value={extractName(record.stage_id)} />
          <FieldRow icon={User} label="Responsável" value={extractName(record.user_id)} />
          {record.probability != null && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TrendingUp className="size-3 shrink-0" />
              <span>Probabilidade: {record.probability}%</span>
            </div>
          )}
        </>
      )}
      <Badge variant="outline" className="mt-1 text-[10px]">
        {record.type === 'opportunity' ? 'Oportunidade' : 'Lead'}
      </Badge>
    </>
  )
}

function SaleFields({ record, compact }: { record: any; compact?: boolean }) {
  const stateLabels: Record<string, string> = {
    draft: 'Orçamento',
    sent: 'Enviado',
    sale: 'Venda',
    done: 'Concluído',
    cancel: 'Cancelado',
  }
  return (
    <>
      <FieldRow icon={DollarSign} label="Total" value={formatCurrency(record.amount_total)} />
      {!compact && (
        <>
          <FieldRow icon={User} label="Cliente" value={extractName(record.partner_id)} />
          <FieldRow icon={Calendar} label="Data" value={formatDate(record.date_order)} />
          <FieldRow icon={User} label="Responsável" value={extractName(record.user_id)} />
        </>
      )}
      <Badge
        variant={record.state === 'sale' ? 'default' : 'outline'}
        className="mt-1 text-[10px]"
      >
        {stateLabels[record.state] || record.state}
      </Badge>
    </>
  )
}

function TaskFields({ record, compact }: { record: any; compact?: boolean }) {
  const priorityLabels: Record<string, string> = {
    '0': 'Baixa',
    '1': 'Normal',
    '2': 'Alta',
    '3': 'Muito Alta',
  }
  return (
    <>
      <FieldRow icon={ClipboardList} label="Projeto" value={extractName(record.project_id)} />
      {!compact && (
        <>
          <FieldRow icon={Calendar} label="Estágio" value={extractName(record.stage_id)} />
          <FieldRow icon={Calendar} label="Prazo" value={formatDate(record.date_deadline)} />
          <FieldRow icon={User} label="Responsável" value={extractName(record.partner_id)} />
        </>
      )}
      {record.priority && record.priority !== '0' && (
        <Badge variant="destructive" className="mt-1 text-[10px]">
          <AlertCircle className="size-3" />
          {priorityLabels[record.priority] || 'Prioridade'}
        </Badge>
      )}
    </>
  )
}

// ---------- Main Component ----------

export function OdooRecordCard({ model, record, onLink, onOpen, compact = false }: OdooRecordCardProps) {
  const config = MODEL_CONFIG[model]
  const Icon = config.icon

  if (!record) return null

  const modelName = config.label
  const recordName = record.name || record.display_name || `#${record.id}`

  const renderFields = () => {
    switch (model) {
      case 'res.partner':
        return <ContactFields record={record} compact={compact} />
      case 'crm.lead':
        return <LeadFields record={record} compact={compact} />
      case 'sale.order':
        return <SaleFields record={record} compact={compact} />
      case 'project.task':
        return <TaskFields record={record} compact={compact} />
      default:
        return null
    }
  }

  return (
    <Card
      className={`group transition-all hover:shadow-md ${config.borderClass} border`}
    >
      <CardContent className={`${compact ? 'p-3' : 'p-4'}`}>
        {/* Header */}
        <div className="flex items-start gap-3">
          {/* Model icon */}
          <div
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${config.bgClass}`}
          >
            <Icon className={`size-4 ${config.colorClass}`} />
          </div>

          {/* Name + badge */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 className="truncate text-sm font-semibold leading-tight">
                {recordName}
              </h4>
              <Badge
                variant="secondary"
                className={`shrink-0 text-[10px] ${config.bgClass} ${config.colorClass} border-0`}
              >
                {modelName}
              </Badge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              ID: {record.id}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex shrink-0 items-center gap-1">
            {onOpen && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={onOpen}
                  >
                    <ExternalLink className="size-3.5" />
                    <span className="sr-only">Abrir no Odoo</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Abrir no Odoo</TooltipContent>
              </Tooltip>
            )}
            {onLink && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={onLink}
                  >
                    <Link2 className="size-3.5" />
                    <span className="sr-only">Vincular à conversa</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Vincular à conversa</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Fields */}
        {!compact && renderFields() && (
          <>
            <Separator className="my-2.5" />
            <div className="flex flex-col gap-1.5">{renderFields()}</div>
          </>
        )}

        {/* Compact: show first field inline */}
        {compact && (
          <div className="mt-1.5 ml-12">
            {renderFields()}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
