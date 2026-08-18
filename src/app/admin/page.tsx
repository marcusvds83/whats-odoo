// ====================================================================
// v7.25: /admin — Dedicated admin login page.
// Visual theme: dark + amber accents (signals "admin area").
// Only users with role='admin' can login here. Regular users get a
// clear error message directing them to /login.
//
// If no users exist in DB yet, this page shows the setup form
// (creates the first admin) — same behavior as /login.
// ====================================================================

'use client'

import { useState, useEffect, Suspense, FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, ShieldCheck, Lock, User, Crown, AlertTriangle } from 'lucide-react'

function AdminLoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectPath = searchParams.get('redirect') || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [mode, setMode] = useState<'login' | 'setup'>('login')

  useEffect(() => {
    fetch('/api/auth/setup')
      .then(r => r.json())
      .then(data => {
        if (data.success && data.needsSetup) {
          setNeedsSetup(true)
          setMode('setup')
        } else {
          setNeedsSetup(false)
        }
      })
      .catch(() => setNeedsSetup(false))
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    try {
      const endpoint = mode === 'setup' ? '/api/auth/setup' : '/api/auth/login'
      const body = mode === 'setup'
        ? { email, password, name }
        : { email, password, requireAdmin: true }  // v7.25: enforce admin-only

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'same-origin',  // v7.27: ensure cookies are sent/received
      })
      const data = await res.json()

      if (data.success) {
        router.push(redirectPath)
        router.refresh()
      } else {
        setError(data.error || 'Falha na autenticação')
      }
    } catch (err: any) {
      setError(err.message || 'Erro de rede')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-amber-950 px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="flex flex-col items-center mb-6">
          <div className="size-16 rounded-full bg-amber-500 flex items-center justify-center mb-3 shadow-lg shadow-amber-500/30 ring-4 ring-amber-500/20">
            <Crown className="size-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-center text-white">
            Área do Administrador
          </h1>
          <p className="text-sm text-amber-200/80 text-center mt-1">
            WhatsApp ↔ Odoo Middleware
          </p>
        </div>

        <Card className="shadow-2xl border-amber-900/40 bg-slate-900/95 text-slate-100">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-amber-100">
              {mode === 'setup' ? (
                <>
                  <ShieldCheck className="size-5 text-amber-400" />
                  Configuração inicial do admin
                </>
              ) : (
                <>
                  <Lock className="size-5 text-amber-400" />
                  Acesso restrito
                </>
              )}
            </CardTitle>
            <CardDescription className="text-slate-400">
              {mode === 'setup'
                ? 'Crie a conta de administrador (primeiro acesso)'
                : 'Somente contas com privilégio de administrador'}
            </CardDescription>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-3">
              {mode === 'setup' && (
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-slate-300">Nome (opcional)</Label>
                  <Input
                    id="name"
                    type="text"
                    placeholder="Seu nome"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    className="bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500"
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-slate-300">Email</Label>
                <div className="relative">
                  <User className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="admin@empresa.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    className="pl-9 bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500"
                    required
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-slate-300">Senha</Label>
                <div className="relative">
                  <Lock className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
                  <Input
                    id="password"
                    type="password"
                    placeholder={mode === 'setup' ? 'Mínimo 6 caracteres' : 'Sua senha'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                    className="pl-9 bg-slate-800 border-slate-700 text-slate-100 placeholder:text-slate-500"
                    required
                  />
                </div>
              </div>

              {error && (
                <Alert variant="destructive" className="bg-red-950/60 border-red-800 text-red-200">
                  <AlertTriangle className="size-4" />
                  <AlertDescription className="text-red-200">{error}</AlertDescription>
                </Alert>
              )}

              {mode === 'setup' && (
                <div className="rounded-md bg-amber-950/60 border border-amber-800/60 px-3 py-2 text-xs text-amber-200">
                  Esta conta será o <strong>administrador</strong> do middleware.
                  Você poderá criar e gerenciar outros usuários após o login.
                </div>
              )}

              {mode === 'login' && (
                <div className="rounded-md bg-slate-800/60 border border-slate-700 px-3 py-2 text-xs text-slate-400">
                  Não é administrador? Use o <a href="/login" className="underline text-amber-400 hover:text-amber-300">login normal</a>.
                </div>
              )}
            </CardContent>

            <CardFooter className="flex flex-col gap-2">
              <Button
                type="submit"
                className="w-full bg-amber-600 hover:bg-amber-700 text-white"
                disabled={isLoading || !email || !password}
              >
                {isLoading ? (
                  <Loader2 className="size-4 animate-spin mr-2" />
                ) : null}
                {mode === 'setup' ? 'Criar conta admin' : 'Entrar como admin'}
              </Button>

              {needsSetup === false && (
                <p className="text-xs text-slate-500 text-center mt-1">
                  Esqueceu a senha de admin? Use o token de recuperação em{' '}
                  <code className="text-amber-400">/api/auth/setup-admin</code>.
                </p>
              )}
            </CardFooter>
          </form>
        </Card>

        <p className="text-xs text-slate-500 text-center mt-4">
          v7.31 • Área administrativa
        </p>
      </div>
    </div>
  )
}

export default function AdminPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-900">
          <Loader2 className="size-6 animate-spin text-amber-400" />
        </div>
      }
    >
      <AdminLoginForm />
    </Suspense>
  )
}
