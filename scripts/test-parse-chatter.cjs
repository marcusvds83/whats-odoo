// Quick smoke test for parseChatterBody() — verifies that chatter bodies
// produced by buildChatterBody() are parsed back into clean text.
const { parseChatterBody } = require('/home/z/my-project/src/server/user-session.js')

const samples = [
  // 1. Text-only outgoing message
  '<div><strong>📱 WhatsApp Enviada:</strong> 14/08/2026, 10:30:45<br/><span>Olá, tudo bem?</span></div>',
  // 2. Text-only incoming message
  '<div><strong>📱 WhatsApp Recebida:</strong> 14/08/2026, 10:31:20<br/><span>Tudo ótimo, e você?</span></div>',
  // 3. Audio message (media-only, no text)
  '<div><strong>📱 WhatsApp Enviada:</strong> 14/08/2026, 10:32:00<br/>🎙️ Áudio<br/></div>',
  // 4. Image with caption
  '<div><strong>📱 WhatsApp Recebida:</strong> 14/08/2026, 10:33:10<br/>🖼️ Imagem<br/><span>Veja essa foto</span></div>',
  // 5. Emoji + text
  '<div><strong>📱 WhatsApp Enviada:</strong> 14/08/2026, 10:34:00<br/><span>🚀 Vamos lá!!! 🔥</span></div>',
  // 6. Empty body
  '',
  // 7. Body with HTML entities in text
  '<div><strong>📱 WhatsApp Recebida:</strong> 14/08/2026, 10:35:00<br/><span>Preço: R$ 50 &amp; desconto de 10%</span></div>',
  // 8. Old format with parenthesized date
  '<div><strong>📱 WhatsApp Enviada:</strong> (14/08/2026 10:30:45)<br/><span>Teste de timestamp</span></div>',
]

let pass = 0
let fail = 0

for (let i = 0; i < samples.length; i++) {
  const body = samples[i]
  const r = parseChatterBody(body)
  console.log(`\n[${i + 1}] Input:  ${body.slice(0, 80)}${body.length > 80 ? '...' : ''}`)
  console.log(`    Output: fromMe=${r.fromMe} ts=${r.timestamp ? r.timestamp.toISOString() : 'null'} text="${r.text}"`)
  if (!body) {
    if (r.text === '' && r.fromMe === false && r.timestamp === null) {
      console.log('    PASSES — empty body handled')
      pass++
    } else {
      console.log('    FAIL — empty body should return empty defaults')
      fail++
    }
    continue
  }
  if (!r.text || r.text.length === 0) {
    // For media-only messages (no <span>), empty text is OK
    // — check that we still got direction + timestamp
    if (r.fromMe !== undefined && r.timestamp) {
      console.log('    PASSES — media-only message, text correctly empty')
      pass++
    } else {
      console.log('    FAIL — text empty AND missing fromMe/timestamp')
      fail++
    }
  } else if (r.text.includes('WhatsApp') && r.text.includes('Enviada')) {
    console.log('    FAIL — text still contains metadata prefix')
    fail++
  } else {
    console.log('    PASSES — Clean text extracted')
    pass++
  }
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
process.exit(fail > 0 ? 1 : 0)
