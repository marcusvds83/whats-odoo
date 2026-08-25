// Analyze a WhatsApp-Odoo middleware web app screenshot using the z-ai-web-dev-sdk VLM.
// Reads the image from disk, converts to base64, and sends a structured prompt to the
// vision model to describe what is visible on screen (conversations, contacts,
// connection status, error banners, message content).

import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';
import path from 'path';

const IMAGE_PATH = '/home/z/my-project/upload/pasted_image_1787094769086.png';

const PROMPT = `You are looking at a screenshot of a WhatsApp-Odoo middleware web app.

CONTEXT (do not hallucinate — only describe what is actually visible in the image):
- After the latest deploy (v7.37), the user reports they can see phone contacts
  but NO messages are arriving — not from Odoo contacts, not from new external contacts.
- Both admin and normal users are affected.
- Before, everything arrived.

Please describe in detail what you see in the screenshot, answering EACH of these
questions in a numbered list. Be literal and only mention things actually visible:

1. What page/view is shown? (Conversations tab? Contacts list? Single chat view?
   Settings? Login?) Describe the active tab/section.
2. What conversations or contacts are listed? Quote the exact names, phone numbers,
   timestamps, and any preview text shown next to each row. If the list is empty,
   say so explicitly.
3. Are there any error messages, warning banners, toast notifications, or red/yellow
   status indicators visible anywhere on the page? Quote them verbatim if present.
4. What does the connection status show? Is WhatsApp shown as connected,
   disconnected, syncing, scanning QR, etc.? Quote any status text.
5. Are there any visible message bubbles in any conversation/chat panel shown?
   If a chat panel is open, describe whether it is empty or has messages, and
   quote the visible message text.
6. Mention any visible UI version number, build number, environment label
   (e.g. "v7.37", "production", "staging").
7. Mention any visible user role indicator (admin vs. normal user) and who the
   currently logged-in user appears to be.

After answering the numbered questions, give a one-paragraph SUMMARY of what the
UI state implies about the bug (empty conversation list vs. conversations with no
messages vs. error state vs. connection issue).`;

async function main() {
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error('ERROR: image not found at', IMAGE_PATH);
    process.exit(1);
  }

  const buf = fs.readFileSync(IMAGE_PATH);
  const base64 = buf.toString('base64');
  const ext = path.extname(IMAGE_PATH).toLowerCase();
  const mimeType =
    ext === '.png' ? 'image/png'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/jpeg';

  console.error(`[analyze-screenshot] image bytes=${buf.length} mime=${mimeType}`);

  const zai = await ZAI.create();

  const response = await zai.chat.completions.createVision({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}` },
          },
        ],
      },
    ],
    thinking: { type: 'disabled' },
  });

  const content = response?.choices?.[0]?.message?.content;

  if (!content) {
    console.error('ERROR: no content returned from VLM');
    console.error('Full response:', JSON.stringify(response, null, 2));
    process.exit(2);
  }

  // Print the description to stdout so the caller can capture it.
  console.log(content);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(3);
});
