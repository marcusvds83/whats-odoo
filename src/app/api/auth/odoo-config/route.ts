// ====================================================================
// v7.22: GET /api/auth/odoo-config
// Returns the per-user Odoo config (or falls back to global OdooConfig)
// Used by the socket server (via fetch) to know which Odoo credentials
// to use for the current user.
// ====================================================================

import { NextRequest, NextResponse } from 'next/server'
import { userStore } from '@/lib/user-store'
import { db } from '@/lib/db'
import { getSessionFromRequest } from '@/lib/auth'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const session = await getSessionFromRequest(req)
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autenticado' }, { status: 401 })
    }

    const raw = await userStore.findUnique({ where: { id: session.userId } })
    if (!raw) {
      return NextResponse.json({ success: false, error: 'Usuário não encontrado' }, { status: 404 })
    }
    // Pull only the Odoo fields into the shape the old select returned.
    const user = {
      odooUrl: raw.odooUrl,
      odooDb: raw.odooDb,
      odooUsername: raw.odooUsername,
      odooPassword: raw.odooPassword,
    }

    // If user has per-user Odoo config, use it
    if (user && user.odooUrl && user.odooDb && user.odooUsername && user.odooPassword) {
      return NextResponse.json({
        success: true,
        source: 'user',
        config: {
          url: user.odooUrl,
          db: user.odooDb,
          username: user.odooUsername,
          password: user.odooPassword,
        },
      })
    }

    // Otherwise fall back to global OdooConfig
    const globalConfig = await db.odooConfig.findFirst({
      where: { active: true },
      orderBy: { updatedAt: 'desc' },
    })

    if (globalConfig) {
      return NextResponse.json({
        success: true,
        source: 'global',
        config: {
          url: globalConfig.url,
          db: globalConfig.db,
          username: globalConfig.username,
          password: globalConfig.password,
        },
      })
    }

    return NextResponse.json({
      success: false,
      error: 'Nenhuma configuração Odoo encontrada (nem por usuário, nem global)',
    })
  } catch (err: any) {
    console.error('[/api/auth/odoo-config] error:', err.message)
    return NextResponse.json({ success: false, error: 'Erro interno do servidor' }, { status: 500 })
  }
}
