'use client'

import { useState, useEffect, Suspense, FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, MessageCircle, User, Lock, ShieldCheck } from 'lucide-react'

function LoginForm() {
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
        : { email, password }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    <Card className="shadow-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {mode === 'setup' ? (
            <>
              <ShieldCheck className="size-5 text-emerald-600" />
              Configuração inicial
            </>
          ) : (
            <>
              <Lock className="size-5 text-emerald-600" />
              Entrar
            </>
          )}
        </CardTitle>
        <CardDescription>
          {mode === 'setup'
            ? 'Crie a conta de administrador (primeiro acesso)'
            : 'Acesse com suas credenciais do middleware'}
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-3">
          {mode === 'setup' && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Nome (opcional)</Label>
              <Input
                id="name"
                type="text"
                placeholder="Seu nome"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <User className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                placeholder="voce@empresa.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="pl-9"
                required
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Senha</Label>
            <div className="relative">
              <Lock className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                id="password"
                type="password"
                placeholder={mode === 'setup' ? 'Mínimo 6 caracteres' : 'Sua senha'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                className="pl-9"
                required
              />
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {mode === 'setup' && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              Esta conta será o <strong>administrador</strong> do middleware.
              Você poderá criar e gerenciar outros usuários após o login.
            </div>
          )}
        </CardContent>

        <CardFooter className="flex flex-col gap-2">
          <Button
            type="submit"
            className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
            disabled={isLoading || !email || !password}
          >
            {isLoading ? (
              <Loader2 className="size-4 animate-spin mr-2" />
            ) : null}
            {mode === 'setup' ? 'Criar conta admin' : 'Entrar'}
          </Button>

          {needsSetup === false && (
            <div className="space-y-1 text-xs text-muted-foreground text-center mt-1">
              <p>Não tem conta? Peça ao administrador para criar uma para você.</p>
              <p>
                É administrador?{' '}
                <a href="/admin" className="text-emerald-600 hover:text-emerald-700 font-medium underline">
                  Entrar como admin
                </a>
              </p>
            </div>
          )}
        </CardFooter>
      </form>
    </Card>
  )
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-emerald-50 via-white to-emerald-50 px-4">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <div className="size-16 rounded-full bg-emerald-600 flex items-center justify-center mb-3 shadow-lg shadow-emerald-600/20">
            <MessageCircle className="size-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-center">WhatsApp ↔ Odoo</h1>
          <p className="text-sm text-muted-foreground text-center mt-1">
            Middleware de integração
          </p>
        </div>

        <Suspense
          fallback={
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <LoginForm />
        </Suspense>

        <p className="text-xs text-muted-foreground text-center mt-4">
          v7.25 • Multi-usuário
        </p>
      </div>
    </div>
  )
}
