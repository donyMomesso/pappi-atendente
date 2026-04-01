/**
 * Exporta histórico de mensagens de ONTEM (America/Sao_Paulo) para clientes cujo phone contém o trecho informado.
 * Uso: node scripts/history-by-phone-yesterday.js [trechoTel]   (padrão: 3999)
 */
require("dotenv").config();
const prisma = require("../src/lib/db");

async function main() {
  const needle = process.argv[2] || "3999";
  const like = `%${String(needle).replace(/%/g, "")}%`;

  const rows = await prisma.$queryRaw`
    SELECT
      m.id AS "messageId",
      m.role,
      LEFT(m.text, 4000) AS text,
      m."createdAt" AS "createdAt",
      m.status,
      c.id AS "customerId",
      c.phone,
      c.name,
      c."tenantId"
    FROM messages m
    INNER JOIN customers c ON c.id = m."customerId"
    WHERE c.phone LIKE ${like}
      AND (m."createdAt" AT TIME ZONE 'America/Sao_Paulo')::date =
          ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 1)
    ORDER BY m."createdAt" ASC
  `;

  const list = Array.isArray(rows) ? rows : [];
  const summaryDate = await prisma.$queryRaw`
    SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - 1) AS dia_ref
  `;
  const diaRef = summaryDate?.[0]?.dia_ref;

  console.log(JSON.stringify({ ok: true, needle, diaReferenciaSaoPaulo: diaRef, total: list.length, messages: list }, null, 2));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exit(1);
});
