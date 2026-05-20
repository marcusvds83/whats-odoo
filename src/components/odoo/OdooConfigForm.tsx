'use client'

import { useState, useCallback } from 'react'
import {
  Server,
  Database,
  User,
  Lock,
  Plug,
  Unplug,
  CheckCircle2,
  XCircle,
  Loader2,
  Eye,
  EyeOff,
  Save,
  AlertTriangle,
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

// ---------- Types ----------

interface OdooConfigFormProps {
  status: { connected: boolean; url?: string; db?: string; username?: string }
  onAuthenticate: (config: { url: string; db: string; username: string; password: string }) => Promise<{ success: boolean; uid?: number; error?: string }>
  onDisconnect: () => Promise<{ success: boolean }>
  isConnected: boolean
}

// ---------- Component ----------

export function OdooConfigForm({ status, onAuthenticate, onDisconnect, isConnected }: OdooConfigFormProps) {
  const [url, setUrl] = useState(status.url ?? '')
  const [db, setDb] = useState(status.db ?? '')
  const [username, setUsername] = useState(status.username ?? '')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  const [testing, setTesting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; uid?: number; error?: string } | null>(null)
  const [saved, setSaved] = useState(false)

  // Validation
  const urlValid = url.trim().length > 0 && /^https?:\/\/.+/.test(url.trim())
  const dbValid = db.trim().length > 0
  const usernameValid = username.trim().length > 0
  const passwordValid = password.length > 0
  const formValid = urlValid && dbValid && usernameValid && passwordValid

  const handleTestConnection = useCallback(async () => {
    if (!formValid) return
    setTesting(true)
    setTestResult(null)
    setSaved(false)
    try {
      const result = await onAuthenticate({ url: url.trim(), db: db.trim(), username: username.trim(), password })
      setTestResult(result)
      if (result.success) {
        setSaved(true)
      }
    } catch (err) {
      setTestResult({ success: false, error: err instanceof Error ? err.message : 'Erro desconhecido' })
    } finally {
      setTesting(false)
    }
  }, [formValid, url, db, username, password, onAuthenticate])

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true)
    try {
      await onDisconnect()
      setTestResult(null)
      setSaved(false)
      setPassword('')
    } finally {
      setDisconnecting(false)
    }
  }, [onDisconnect])

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
              <Server className="size-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">Conexão Odoo</CardTitle>
              <CardDescription>Configure a conexão com o servidor Odoo</CardDescription>
            </div>
          </div>
          <ConnectionBadge connected={isConnected} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* URL */}
        <div className="space-y-2">
          <Label htmlFor="odoo-url" className="flex items-center gap-1.5">
            <Server className="size-3.5" />
            URL do Servidor
          </Label>
          <Input
            id="odoo-url"
            type="url"
            placeholder="https://seu-odoo.exemplo.com"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setTestResult(null); setSaved(false) }}
            disabled={isConnected}
            aria-invalid={url.length > 0 && !urlValid}
            className={url.length > 0 && !urlValid ? 'border-destructive' : ''}
          />
          {url.length > 0 && !urlValid && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertTriangle className="size-3" />
              Informe uma URL válida (ex: https://seu-odoo.exemplo.com)
            </p>
          )}
        </div>

        {/* Database */}
        <div className="space-y-2">
          <Label htmlFor="odoo-db" className="flex items-center gap-1.5">
            <Database className="size-3.5" />
            Banco de Dados
          </Label>
          <Input
            id="odoo-db"
            type="text"
            placeholder="nome_do_banco"
            value={db}
            onChange={(e) => { setDb(e.target.value); setTestResult(null); setSaved(false) }}
            disabled={isConnected}
            aria-invalid={db.length > 0 && !dbValid}
          />
        </div>

        {/* Username */}
        <div className="space-y-2">
          <Label htmlFor="odoo-username" className="flex items-center gap-1.5">
            <User className="size-3.5" />
            Usuário
          </Label>
          <Input
            id="odoo-username"
            type="text"
            placeholder="admin@exemplo.com"
            value={username}
            onChange={(e) => { setUsername(e.target.value); setTestResult(null); setSaved(false) }}
            disabled={isConnected}
            aria-invalid={username.length > 0 && !usernameValid}
          />
        </div>

        {/* Password */}
        <div className="space-y-2">
          <Label htmlFor="odoo-password" className="flex items-center gap-1.5">
            <Lock className="size-3.5" />
            Senha
          </Label>
          <div className="relative">
            <Input
              id="odoo-password"
              type={showPassword ? 'text' : 'password'}
              placeholder={isConnected ? '••••••••' : 'Sua senha'}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setTestResult(null); setSaved(false) }}
              disabled={isConnected}
              className="pr-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 size-9"
              onClick={() => setShowPassword((v) => !v)}
              tabIndex={-1}
              aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
            >
              {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
          </div>
        </div>

        {/* Test Result Feedback */}
        {testResult && (
          <div
            className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
              testResult.success
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-destructive/30 bg-destructive/5 text-destructive dark:border-destructive/50 dark:bg-destructive/10'
            }`}
          >
            {testResult.success ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0" />
            )}
            <div className="min-w-0">
              {testResult.success ? (
                <p>Conexão bem-sucedida! UID: {testResult.uid}</p>
              ) : (
                <p>Falha na conexão: {testResult.error || 'Erro desconhecido'}</p>
              )}
            </div>
          </div>
        )}

        {/* Connected info */}
        {isConnected && !testResult && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">Conectado ao Odoo</p>
              <p className="text-xs opacity-80 mt-0.5">
                {status.url} &middot; {status.db} &middot; {status.username}
              </p>
            </div>
          </div>
        )}
      </CardContent>

      <Separator />

      <CardFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
        {isConnected ? (
          <Button
            variant="destructive"
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="w-full sm:w-auto"
          >
            {disconnecting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Unplug className="size-4" />
            )}
            Desconectar
          </Button>
        ) : (
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button
              onClick={handleTestConnection}
              disabled={!formValid || testing}
              className="w-full sm:w-auto"
            >
              {testing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : saved ? (
                <CheckCircle2 className="size-4" />
              ) : (
                <Plug className="size-4" />
              )}
              {testing ? 'Testando...' : saved ? 'Conectado' : 'Testar Conexão'}
            </Button>
            {saved && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                <Save className="size-3.5" />
                Credenciais salvas
              </div>
            )}
          </div>
        )}
      </CardFooter>
    </Card>
  )
}

// ---------- Helpers ----------

function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <Badge
      variant={connected ? 'default' : 'outline'}
      className={`gap-1.5 text-xs ${
        connected
          ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
          : 'text-muted-foreground'
      }`}
    >
      <span
        className={`size-2 rounded-full ${
          connected ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/40'
        }`}
      />
      {connected ? 'Conectado' : 'Desconectado'}
    </Badge>
  )
}
