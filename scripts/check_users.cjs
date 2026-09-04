// Check current users in the whats-odoo DB to debug admin role issue.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true }
  });
  console.log('=== Users in DB ===');
  console.log(JSON.stringify(users, null, 2));
  console.log('Total:', users.length);
  await prisma.$disconnect();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
