/**
 * Estatísticas de mensagens em public.messages para "ontem" (America/Sao_Paulo).
 * Uso: node scripts/stats-messages-yesterday.js
 */
require("dotenv").config();
const prisma = require("../src/lib/db");

async function main() {
  const diaRef = await prisma.$queryRaw`
    SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 1) AS dia_ref
  `;
  const byRole = await prisma.$queryRaw`
    SELECT m.role, COUNT(*)::int AS n
    FROM messages m
    WHERE (m."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date =
          ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 1)
    GROUP BY m.role
    ORDER BY n DESC
  `;
  const total = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS total
    FROM messages m
    WHERE (m."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date =
          ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 1)
  `;
  const distinctCustomers = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT m."customerId")::int AS n
    FROM messages m
    WHERE (m."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date =
          ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 1)
  `;
  const topCustomers = await prisma.$queryRaw`
    SELECT m."customerId", c.phone, c.name, COUNT(*)::int AS msg_count
    FROM messages m
    JOIN customers c ON c.id = m."customerId"
    WHERE (m."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date =
          ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 1)
    GROUP BY m."customerId", c.phone, c.name
    ORDER BY msg_count DESC
    LIMIT 15
  `;
  console.log(
    JSON.stringify(
      {
        diaReferenciaSaoPaulo: diaRef[0]?.dia_ref,
        totalOntem: total[0]?.total,
        clientesDistintosComMsg: distinctCustomers[0]?.n,
        porRole: byRole,
        top15ClientesPorVolume: topCustomers,
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
