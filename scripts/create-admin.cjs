// =====================================================================
// Script utilitário: criar admin ou promover user existente a admin.
// Uso:
//   node /home/z/my-project/scripts/create-admin.js
//
// Ele vai:
//  1) Listar todos os usuários atuais no banco
//  2) Se não houver nenhum admin, criar um novo (admin@whats-odoo.local / admin123)
//     OU promover um usuário existente, se você passar o email como argumento:
//       node /home/z/my-project/scripts/create-admin.js seuemail@empresa.com
//  3) Mostrar o estado final
// =====================================================================

const path = require('path')

// Carregar .env do whats-odoo ANTES de importar PrismaClient
require('dotenv').config({ path: path.join(__dirname, '..', 'whats-odoo', '.env') })

const { PrismaClient } = require(path.join(__dirname, '..', 'whats-odoo', 'node_modules', '@prisma', 'client'))
const bcrypt = require(path.join(__dirname, '..', 'whats-odoo', 'node_modules', 'bcryptjs'))

const prisma = new PrismaClient()

async function main() {
  const targetEmail = process.argv[2]?.trim().toLowerCase()

  console.log('\n=== Estado atual do banco ===')
  const allUsers = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, isActive: true }
  })
  console.table(allUsers)
  console.log(`Total de usuários: ${allUsers.length}`)

  // Caso 1: promote existing user
  if (targetEmail) {
    const existing = await prisma.user.findUnique({ where: { email: targetEmail } })
    if (!existing) {
      console.error(`\n[ERRO] Não encontrei usuário com email: ${targetEmail}`)
      process.exit(1)
    }
    if (existing.role === 'admin') {
      console.log(`\n[OK] ${targetEmail} já é admin.`)
      return
    }
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: 'admin' }
    })
    console.log(`\n[OK] Usuário ${targetEmail} promovido a admin com sucesso!`)
    console.log('Faça logout e login novamente para o painel "Usuários" aparecer.')
    return
  }

  // Caso 2: ensure at least one admin exists
  const adminCount = allUsers.filter(u => u.role === 'admin').length
  if (adminCount > 0) {
    console.log(`\n[OK] Já existe ${adminCount} admin(s). Nada a fazer.`)
    console.log('Se você quer promover outro usuário, rode:')
    console.log('  node create-admin.js email@exemplo.com')
    return
  }

  // Criar admin padrão
  const email = 'admin@whats-odoo.local'
  const password = 'admin123'
  const name = 'Administrador'
  const passwordHash = await bcrypt.hash(password, 10)

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
      role: 'admin',
      isActive: true
    }
  })

  console.log('\n=== Admin criado com sucesso! ===')
  console.log(`ID:    ${user.id}`)
  console.log(`Email: ${email}`)
  console.log(`Senha: ${password}`)
  console.log(`Nome:  ${name}`)
  console.log('\nIMPORTANTE: altere a senha após o primeiro login!')
  console.log('URL para login: http://localhost:3000/login')
}

main()
  .catch(e => {
    console.error('[ERRO]', e.message)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
