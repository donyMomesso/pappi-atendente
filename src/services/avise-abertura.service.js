// Lista "Me avise quando abrir" — itens podem ser telefone normalizado ou BSUID (objeto).

const prisma = require("../lib/db");
const { getClients, listActive } = require("./tenant.service");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");

const CONFIG_KEY_PREFIX = "avise_abertura:";

function configKey(tenantId) {
  return `${CONFIG_KEY_PREFIX}${tenantId}`;
}

function entryKey(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  if (entry.kind === "phone") return `p:${entry.value}`;
  if (entry.kind === "wauser") return `u:${entry.value}`;
  if (entry.kind === "cid") return `c:${entry.value}`;
  return JSON.stringify(entry);
}

/** Monta entrada a partir do cliente (Cloud com BSUID ou telefone Baileys). */
function entryFromCustomer(customer) {
  if (!customer) return null;
  const raw = customer.phone != null ? String(customer.phone).trim() : "";
  if (raw && !raw.includes(":")) {
    const n = PhoneNormalizer.normalize(raw) || raw.replace(/\D/g, "");
    if (n && n.length >= 12) return { kind: "phone", value: n };
    const d = raw.replace(/\D/g, "");
    if (d.length >= 10) return { kind: "phone", value: d.startsWith("55") ? d : `55${d}` };
  }
  const uid = customer.waUserId != null ? String(customer.waUserId).trim() : "";
  if (uid) return { kind: "wauser", value: uid };
  return { kind: "cid", value: customer.id };
}

/**
 * @param {string} tenantId
 * @param {object} customer — modelo Customer (telefone e/ou waUserId)
 */
async function addToAberturaList(tenantId, customer) {
  const entry = entryFromCustomer(customer);
  if (!entry) return false;

  const key = configKey(tenantId);
  const cfg = await prisma.config.findUnique({ where: { key } });
  let list = cfg ? JSON.parse(cfg.value) : [];

  if (!Array.isArray(list)) list = [];

  const incoming = entryKey(entry);
  const exists = list.some((e) => entryKey(e) === incoming);
  if (exists) return false;

  list.push(entry);
  await prisma.config.upsert({
    where: { key },
    create: { key, value: JSON.stringify(list) },
    update: { value: JSON.stringify(list) },
  });
  return true;
}

async function getAberturaList(tenantId) {
  const cfg = await prisma.config.findUnique({ where: { key: configKey(tenantId) } });
  if (!cfg) return [];
  try {
    const v = JSON.parse(cfg.value);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function clearAberturaList(tenantId) {
  await prisma.config.upsert({
    where: { key: configKey(tenantId) },
    create: { key: configKey(tenantId), value: "[]" },
    update: { value: "[]" },
  });
}

function destinationForWa(entry) {
  if (entry == null) return null;
  if (typeof entry === "string") {
    const to = String(entry).replace(/\D/g, "");
    return to || null;
  }
  if (entry.kind === "phone") return String(entry.value).replace(/\D/g, "");
  if (entry.kind === "wauser") return { recipientUserId: String(entry.value) };
  return null;
}

async function notificarClientesAbertura(tenantId) {
  const tenants = tenantId ? [{ id: tenantId }] : await listActive();
  const results = [];

  for (const t of tenants) {
    const list = await getAberturaList(t.id);
    if (!list.length) {
      results.push({ tenantId: t.id, sent: 0, total: 0 });
      continue;
    }

    let sent = 0;
    try {
      const { cw, wa } = await getClients(t.id);
      const merchant = await cw.getMerchant().catch(() => null);
      const menuUrl = merchant?.url || merchant?.website || merchant?.catalog_url || "";
      const msg = menuUrl
        ? `Ei! Prometido é devido: o forno da Pappi Pizza já está a todo vapor! 🔥🍕\n\nQual vai ser a de hoje? Confira o cardápio: ${menuUrl}`
        : `Ei! Prometido é devido: o forno da Pappi Pizza já está a todo vapor! 🔥🍕\n\nQual vai ser a de hoje? É só mandar seu pedido!`;

      for (const entry of list) {
        try {
          const dest = destinationForWa(entry);
          if (!dest) continue;
          await wa.sendText(dest, msg);
          sent++;
        } catch (err) {
          console.warn(`[AviseAbertura] Erro ao enviar:`, err.message);
        }
      }

      await clearAberturaList(t.id);
    } catch (err) {
      console.error(`[AviseAbertura] Erro tenant ${t.id}:`, err.message);
    }
    results.push({ tenantId: t.id, sent, total: list.length });
  }
  return results;
}

module.exports = {
  addToAberturaList,
  getAberturaList,
  clearAberturaList,
  notificarClientesAbertura,
};
