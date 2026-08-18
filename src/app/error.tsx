'use client'

// v7.29.3: Global Error Boundary.
// Next.js App Router requires error.tsx at the route root to catch
// unhandled runtime exceptions in client components and show a friendly
// fallback UI instead of the bare "Application error: a client-side
// exception has occurred" white screen.
//
// This component:
//  - Catches errors thrown during render of the homepage (or any nested route)
//  - Shows a friendly message with a "Recarregar" button so the user can
//    recover without manually clearing cookies / hard refreshing
//  - Logs the error to the browser console for debugging

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AlertCircle, RotateCw } from 'lucide-react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[GlobalError] Uncaught client-side error:', error)
  }, [error])

  return (
    <html lang="pt-BR">
      <body className="bg-background text-foreground antialiased">
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="max-w-md w-full space-y-4">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="size-14 rounded-full bg-red-100 dark:bg-red-950/40 flex items-center justify-center">
                <AlertCircle className="size-7 text-red-600 dark:text-red-400" />
              </div>
              <h1 className="text-xl font-bold tracking-tight">
                Algo deu errado
              </h1>
              <p className="text-sm text-muted-foreground">
                A página encontrou um erro inesperado. Tente recarregar — se o
                erro persistir, faça logout e login novamente.
              </p>
              {error?.message && (
                <p className="text-[11px] text-muted-foreground/70 font-mono break-all bg-muted/50 px-3 py-2 rounded">
                  {error.message}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Button
                onClick={() => reset()}
                className="w-full"
                size="lg"
              >
                <RotateCw className="size-4 mr-2" />
                Recarregar página
              </Button>
              <Button
                variant="outline"
                className="w-full"
                size="lg"
                onClick={() => {
                  window.location.href = '/login'
                }}
              >
                Voltar para o login
              </Button>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
