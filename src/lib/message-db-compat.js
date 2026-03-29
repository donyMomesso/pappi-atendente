// src/lib/message-db-compat.js
// 1) Tabela public.messages ausente (banco legado / DATABASE_URL errado) → não chama Prisma em Message (evita derrubar o app).
// 2) Coluna senderEmail ausente → omitir no SQL até migrate aplicada.
// Sondagem no boot: index.js / bootstrap/http.js chamam refreshMessageSenderEmailSupport().

const prisma = require("./db");
const log = require("./logger").child({ module: "message-db-compat" });

/** @type {boolean | null} null = ainda não sondado; false = ausente; true = existe */
let messagesTablePresent = null;
/** @type {boolean | null} */
let senderEmailColumnPresent = null;
/** @type {boolean | null} */
let originalTimestampColumnPresent = null;
let probePromise = null;
let lastProbeAt = 0;
const PROBE_TTL_MS = 10 * 60 * 1000;

const MESSAGE_ROW_SELECT_WITHOUT_EMAIL = {
  id: true,
  customerId: true,
  role: true,
  text: true,
  sender: true,
  createdAt: true,
  originalTimestamp: true,
  mediaUrl: true,
  mediaType: true,
  waMessageId: true,
  status: true,
};

/**
 * Sonda information_schema: existência da tabela e da coluna senderEmail.
 * Export mantém o nome antigo (boot).
 */
async function refreshMessageSenderEmailSupport(force = false) {
  if (!force && probePromise) return probePromise;
  if (!force && lastProbeAt && Date.now() - lastProbeAt < PROBE_TTL_MS) {
    return { messagesTablePresent, senderEmailColumnPresent, originalTimestampColumnPresent };
  }

  probePromise = (async () => {
  messagesTablePresent = false;
  senderEmailColumnPresent = false;
  originalTimestampColumnPresent = false;

  try {
    const tbl = await prisma.$queryRaw`
      SELECT 1 AS ok
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'messages'
      LIMIT 1
    `;
    messagesTablePresent = Array.isArray(tbl) && tbl.length > 0;
  } catch (err) {
    messagesTablePresent = true;
    log.warn(
      { err: err.message },
      "messages: falha ao verificar tabela em information_schema; assumindo tabela presente",
    );
  }

  try {
    const rows = await prisma.$queryRaw`
      SELECT 1 AS ok
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'messages'
        AND column_name = 'original_timestamp'
      LIMIT 1
    `;
    originalTimestampColumnPresent = Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    originalTimestampColumnPresent = true;
    log.warn(
      { err: err.message },
      "messages.original_timestamp: falha ao consultar information_schema; assumindo coluna presente",
    );
  }

  if (!messagesTablePresent) {
    log.error(
      "public.messages não existe neste banco (relation does not exist). " +
        "Persistência de histórico desativada; app segue em modo degradado (memória / sem dedup BD). " +
        "Correção: confira DATABASE_URL; depois `npx prisma migrate deploy` ou aplique prisma/migrations/20260324140000_ensure_public_messages_table/migration.sql (ou bloco messages em prisma/pappi-init-public.sql).",
    );
    return;
  }

  try {
    const rows = await prisma.$queryRaw`
      SELECT 1 AS ok
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'messages'
        AND column_name = 'senderEmail'
      LIMIT 1
    `;
    senderEmailColumnPresent = Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    senderEmailColumnPresent = true;
    log.warn(
      { err: err.message },
      "messages.senderEmail: falha ao consultar information_schema; assumindo coluna presente",
    );
  }

  log.info(
    { messagesTablePresent, senderEmailColumnPresent, originalTimestampColumnPresent },
    "message-db-compat: sondagem public.messages",
  );
  lastProbeAt = Date.now();
  return { messagesTablePresent, senderEmailColumnPresent, originalTimestampColumnPresent };
  })();

  try {
    return await probePromise;
  } finally {
    probePromise = null;
  }
}

function isMessagesTableAvailable() {
  return messagesTablePresent === true;
}

function hasMessageSenderEmailColumn() {
  return messagesTablePresent === true && senderEmailColumnPresent === true;
}

function hasMessageOriginalTimestampColumn() {
  return messagesTablePresent === true && originalTimestampColumnPresent === true;
}

/** Select estável para findMany/findFirst/create return — evita senderEmail se a coluna não existir. */
function getMessageRowSelect() {
  const s = { ...MESSAGE_ROW_SELECT_WITHOUT_EMAIL };
  if (hasMessageSenderEmailColumn()) s.senderEmail = true;
  if (!hasMessageOriginalTimestampColumn()) delete s.originalTimestamp;
  return s;
}

/** Monta payload de create omitindo senderEmail quando a coluna não existe. */
function buildMessageCreateData(data) {
  const out = { ...data };
  if (!hasMessageSenderEmailColumn()) delete out.senderEmail;
  if (!hasMessageOriginalTimestampColumn()) delete out.originalTimestamp;
  return out;
}

/** Normaliza linha do Prisma para o formato usado no painel / memória. */
function mapRowToClientMessage(r) {
  if (!r) return r;
  return {
    role: r.role,
    text: r.text,
    sender: r.sender,
    senderEmail: hasMessageSenderEmailColumn() ? r.senderEmail ?? null : null,
    mediaUrl: r.mediaUrl,
    mediaType: r.mediaType,
    status: r.status,
    waMessageId: r.waMessageId,
    originalTimestamp: r.originalTimestamp ? r.originalTimestamp.toISOString() : null,
    createdAt: r.createdAt ? r.createdAt.toISOString() : undefined,
    at: (r.originalTimestamp || r.createdAt) ? (r.originalTimestamp || r.createdAt).toISOString() : undefined,
  };
}

module.exports = {
  refreshMessageSenderEmailSupport,
  isMessagesTableAvailable,
  hasMessageSenderEmailColumn,
  hasMessageOriginalTimestampColumn,
  getMessageRowSelect,
  buildMessageCreateData,
  mapRowToClientMessage,
};
