'use client'

import { useState, useCallback, useEffect } from 'react'
import {
  Zap,
  UserPlus,
  TrendingUp,
  MessageSquare,
  Bell,
  Settings2,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'

import type { AutoSyncSettings } from '@/lib/use-odoo'

interface AutoSyncSettingsPanelProps {
  odooConnected: boolean
  settings: AutoSyncSettings
  onUpdateSettings: (settings: Partial<AutoSyncSettings>) => Promise<{ success: boolean; settings?: AutoSyncSettings; error?: string }>
}

export function AutoSyncSettingsPanel({
  odooConnected,
  settings,
  onUpdateSettings,
}: AutoSyncSettingsPanelProps) {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleToggle = useCallback(async (key: keyof AutoSyncSettings, value: boolean | string | number | null) => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const result = await onUpdateSettings({ [key]: value })
      if (result.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      } else {
        setError(result.error || 'Erro ao salvar')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro desconhecido')
    } finally {
      setSaving(false)
    }
  }, [onUpdateSettings])

  if (!odooConnected) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-amber-500" />
            <CardTitle className="text-base">Sincronização Automática</CardTitle>
          </div>
          <CardDescription>
            Configure como as mensagens WhatsApp são sincronizadas com o Odoo
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <AlertCircle className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Conecte ao Odoo primeiro para configurar a sincronização automática
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="size-4 text-amber-500" />
            <div>
              <CardTitle className="text-base">Sincronização Automática</CardTitle>
              <CardDescription>
                Quando uma mensagem WhatsApp chega, o middleware pode automaticamente criar registros no Odoo
              </CardDescription>
            </div>
          </div>
          {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {saved && <CheckCircle2 className="size-4 text-emerald-500" />}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Master toggle */}
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-950/40">
              <Zap className="size-4 text-amber-700 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-sm font-medium">Auto-Sync Ativo</p>
              <p className="text-xs text-muted-foreground">Ativa a sincronização automática de mensagens</p>
            </div>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(v) => handleToggle('enabled', v)}
            disabled={saving}
          />
        </div>

        {/* Individual settings */}
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Ações Automáticas
          </p>

          {/* Auto-create contact */}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-950/40">
                <UserPlus className="size-3.5 text-emerald-700 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-sm font-medium">Criar Contato</p>
                <p className="text-xs text-muted-foreground">
                  Cria um contato em res.partner com o número WhatsApp
                </p>
              </div>
            </div>
            <Switch
              checked={settings.autoCreateContact}
              onCheckedChange={(v) => handleToggle('autoCreateContact', v)}
              disabled={saving || !settings.enabled}
            />
          </div>

          {/* Auto-create lead */}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-lg bg-amber-100 dark:bg-amber-950/40">
                <TrendingUp className="size-3.5 text-amber-700 dark:text-amber-400" />
              </div>
              <div>
                <p className="text-sm font-medium">Criar Lead</p>
                <p className="text-xs text-muted-foreground">
                  Cria um lead no CRM automaticamente para novas conversas
                </p>
              </div>
            </div>
            <Switch
              checked={settings.autoCreateLead}
              onCheckedChange={(v) => handleToggle('autoCreateLead', v)}
              disabled={saving || !settings.enabled}
            />
          </div>

          {/* Auto-post messages */}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-lg bg-sky-100 dark:bg-sky-950/40">
                <MessageSquare className="size-3.5 text-sky-700 dark:text-sky-400" />
              </div>
              <div>
                <p className="text-sm font-medium">Registrar Mensagens</p>
                <p className="text-xs text-muted-foreground">
                  Posta mensagens WhatsApp no chatter do Lead/Contato no Odoo
                </p>
              </div>
            </div>
            <Switch
              checked={settings.autoPostMessages}
              onCheckedChange={(v) => handleToggle('autoPostMessages', v)}
              disabled={saving || !settings.enabled}
            />
          </div>

          {/* Auto-create activity */}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-950/40">
                <Bell className="size-3.5 text-violet-700 dark:text-violet-400" />
              </div>
              <div>
                <p className="text-sm font-medium">Criar Atividade</p>
                <p className="text-xs text-muted-foreground">
                  Cria uma atividade de notificação no lead quando chega a primeira mensagem
                </p>
              </div>
            </div>
            <Switch
              checked={settings.autoCreateActivity}
              onCheckedChange={(v) => handleToggle('autoCreateActivity', v)}
              disabled={saving || !settings.enabled}
            />
          </div>
        </div>

        <Separator />

        {/* Lead settings */}
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Configurações do Lead
          </p>

          <div className="space-y-2">
            <Label htmlFor="lead-prefix" className="text-sm">Prefixo do Lead</Label>
            <Input
              id="lead-prefix"
              value={settings.leadPrefix}
              onChange={(e) => handleToggle('leadPrefix', e.target.value)}
              placeholder="[WhatsApp] "
              disabled={saving || !settings.enabled}
              className="h-9"
            />
            <p className="text-xs text-muted-foreground">
              Prefixo adicionado ao nome do lead criado automaticamente
            </p>
          </div>
        </div>

        <Separator />

        {/* How it works */}
        <div className="rounded-lg bg-muted/50 p-4 space-y-3">
          <p className="text-sm font-medium flex items-center gap-2">
            <Settings2 className="size-4" />
            Como funciona no Odoo
          </p>
          <div className="space-y-2 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">1</span>
              <p>Quando uma mensagem WhatsApp chega, o middleware busca ou cria um <strong>Contato</strong> (res.partner) com o número de telefone.</p>
            </div>
            <div className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold">2</span>
              <p>Se for uma nova conversa, cria um <strong>Lead</strong> no CRM vinculado ao contato. O lead aparece na listagem do CRM normalmente.</p>
            </div>
            <div className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sky-700 text-[10px] font-bold">3</span>
              <p>A mensagem e registrada no <strong>Chatter</strong> do Lead - igual a qualquer mensagem interna do Odoo. Voce pode ver, responder e gerenciar dentro do Odoo.</p>
            </div>
            <div className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 text-[10px] font-bold">4</span>
              <p>Uma <strong>Atividade</strong> de notificação é criada para avisar que chegou uma mensagem WhatsApp nova.</p>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
