#!/usr/bin/env node
// ====================================================================
// whats-odoo • Firebase Service Account Validator & Firestore Tester
// --------------------------------------------------------------------
// Use this BEFORE pasting the service account into Render, to confirm:
//   1. The JSON file you downloaded from Firebase is valid
//   2. It has all required fields (project_id, client_email, private_key)
//   3. The private_key's \n escapes are correctly handled
//   4. The Admin SDK can initialize with it
//   5. The SDK can actually READ + WRITE to Firestore (rules permitting)
//
// Usage:
//   node scripts/validate-firebase.js /path/to/service-account.json
//
// Or with the env var already set:
//   FIREBASE_SERVICE_ACCOUNT='...' node scripts/validate-firebase.js
//
// Or with B64:
//   FIREBASE_SERVICE_ACCOUNT_B64='...' node scripts/validate-firebase.js
// ====================================================================

const fs = require('fs')
const path = require('path')

function normalizePrivateKey(pk) {
  if (!pk) return undefined
  if (pk.includes('\\n')) return pk.replace(/\\n/g, '\n')
  return pk
}

function loadServiceAccountFromFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const sa = JSON.parse(raw)
    return { sa, source: `file:${filePath}` }
  } catch (err) {
    return { sa: null, source: `file:${filePath}`, error: err.message }
  }
}

function loadServiceAccountFromEnv() {
  // 1) raw JSON inline
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT
  if (inline && inline.trim().length > 0) {
    try {
      const sa = JSON.parse(inline)
      return { sa, source: 'FIREBASE_SERVICE_ACCOUNT' }
    } catch (err) {
      return { sa: null, source: 'FIREBASE_SERVICE_ACCOUNT', error: `JSON parse failed: ${err.message}` }
    }
  }
  // 2) base64
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
  if (b64 && b64.trim().length > 0) {
    try {
      const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
      return { sa, source: 'FIREBASE_SERVICE_ACCOUNT_B64' }
    } catch (err) {
      return { sa: null, source: 'FIREBASE_SERVICE_ACCOUNT_B64', error: `base64 decode/parse failed: ${err.message}` }
    }
  }
  // 3) split vars
  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
  if (projectId && clientEmail && privateKey) {
    return {
      sa: {
        type: 'service_account',
        project_id: projectId,
        client_email: clientEmail,
        private_key: privateKey,
      },
      source: 'FIREBASE_PROJECT_ID+EMAIL+KEY',
    }
  }
  return { sa: null, source: null }
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  Whats-Odoo • Firebase Service Account Validator')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  // 1) Load service account
  let result
  const filePath = process.argv[2]
  if (filePath) {
    if (!fs.existsSync(filePath)) {
      console.error(`\n❌ Arquivo não encontrado: ${filePath}`)
      process.exit(1)
    }
    result = loadServiceAccountFromFile(filePath)
  } else {
    result = loadServiceAccountFromEnv()
  }

  if (!result.sa) {
    console.error('\n❌ Não foi possível carregar a service account.')
    console.error(`   Source: ${result.source || 'nenhuma'}`)
    console.error(`   Error: ${result.error || 'variáveis de ambiente não encontradas'}`)
    console.error('\n📝 Como usar:')
    console.error('   1. node scripts/validate-firebase.js /path/to/service-account.json')
    console.error('   2. FIREBASE_SERVICE_ACCOUNT=\'<json>\' node scripts/validate-firebase.js')
    console.error('   3. FIREBASE_SERVICE_ACCOUNT_B64=\'<base64>\' node scripts/validate-firebase.js')
    process.exit(1)
  }

  const sa = result.sa
  console.log(`\n✓ Service account carregada via: ${result.source}`)
  console.log(`  • project_id   : ${sa.project_id || '(AUSENTE!)'}`)
  console.log(`  • client_email : ${sa.client_email || '(AUSENTE!)'}`)
  console.log(`  • private_key  : ${sa.private_key ? `${sa.private_key.length} chars, starts with ${sa.private_key.substring(0, 26)}...` : '(AUSENTE!)'}`)
  console.log(`  • type         : ${sa.type || '(default)'}`)

  // 2) Validate required fields
  const missing = []
  if (!sa.project_id) missing.push('project_id')
  if (!sa.client_email) missing.push('client_email')
  if (!sa.private_key) missing.push('private_key')
  if (missing.length > 0) {
    console.error(`\n❌ Campos obrigatórios ausentes: ${missing.join(', ')}`)
    console.error('   Baixe novamente o JSON da service account no Firebase Console:')
    console.error('   → Project Settings → Service Accounts → Generate new private key')
    process.exit(1)
  }

  // 3) Validate private_key format
  if (!sa.private_key.includes('-----BEGIN PRIVATE KEY-----')) {
    console.error('\n❌ private_key não tem o header "-----BEGIN PRIVATE KEY-----"')
    console.error('   Provavelmente o JSON foi corrompido ou truncado.')
    process.exit(1)
  }
  if (!sa.private_key.includes('-----END PRIVATE KEY-----')) {
    console.error('\n❌ private_key não tem o footer "-----END PRIVATE KEY-----"')
    console.error('   Provavelmente o JSON foi corrompido ou truncado.')
    process.exit(1)
  }
  console.log('\n✓ private_key está bem-formada (BEGIN/END presentes)')

  // 4) Generate the single-line JSON for Render (with \n escapes preserved)
  const jsonForRender = JSON.stringify(sa)
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('  ✓ JSON pronto para colar no Render (variável FIREBASE_SERVICE_ACCOUNT)')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`\n${jsonForRender}\n`)

  // 5) Optionally test Firestore connectivity
  if (!process.env.SKIP_FIRESTORE_TEST) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  Testando conexão com Firestore...')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    try {
      const { initializeApp, getApps, cert } = require('firebase-admin/app')
      const { getFirestore } = require('firebase-admin/firestore')
      if (getApps().length === 0) {
        initializeApp({ credential: cert(sa) })
      }
      const db = getFirestore()
      console.log('✓ Firebase Admin SDK inicializado com sucesso')

      // Write a test doc to a dedicated test collection
      const testRef = db.collection('_validate_test').doc('connection_test')
      await testRef.set({
        ok: true,
        testedAt: new Date(),
        source: 'scripts/validate-firebase.js',
      })
      console.log('✓ Escrita de teste OK (_validate_test/connection_test)')

      const snap = await testRef.get()
      if (!snap.exists) {
        throw new Error('Documento não apareceu após a escrita (verificação falhou)')
      }
      console.log('✓ Leitura de teste OK')

      // Try to read the users collection (should return empty or actual users)
      const usersSnap = await db.collection('users').limit(5).get()
      console.log(`✓ Coleção "users" acessível — ${usersSnap.size} usuário(s) encontrado(s)`)
      if (usersSnap.size > 0) {
        usersSnap.forEach(d => {
          const data = d.data()
          console.log(`    • id=${d.id}  email=${data.email}  role=${data.role}  active=${data.isActive}`)
        })
      } else {
        console.log('    (coleção vazia — normal na primeira vez; usuários serão criados após o deploy)')
      }

      // Clean up the test doc
      await testRef.delete()
      console.log('✓ Documento de teste removido')

      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('  ✅ TUDO OK! Cole o JSON acima no Render e faça redeploy.')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    } catch (err) {
      console.error('\n❌ Falha ao conectar com Firestore:', err.message)
      console.error(err.stack || '')
      process.exit(1)
    }
  }
}

main().catch(err => {
  console.error('\n❌ Erro inesperado:', err.message)
  console.error(err.stack || '')
  process.exit(1)
})
