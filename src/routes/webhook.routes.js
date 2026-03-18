// src/routes/webhook.routes.js
// Recebe e processa eventos do WhatsApp Cloud API

const express = require("express");
const ENV = require("../config/env");
const { getTenantByPhoneNumberId, getClients } = require("../services/tenant.service");
const { findOrCreate, touchInteraction, setHandoff } = require("../services/customer.service");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const chatMemory = require("../services/chat-memory.service");
const baileys   = require("../services/baileys.service");

const router = express.Router();

// ── Verificação do Webhook (GET) ─────────────────────────────

router.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // Aceita qualquer token que bata com algum tenant ou com o token global
  // (em produção, cada tenant pode ter seu verify_token no banco)
  if (mode === "subscribe" && token === ENV.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }

  console.warn("⚠️ Verificação de webhook inválida");
  return res.sendStatus(403);
});

// Log dos últimos webhooks recebidos (em memória)
const webhookLog = [];
function logWebhook(body) {
  webhookLog.unshift({ at: new Date().toISOString(), body });
  if (webhookLog.length > 10) webhookLog.pop();
}
router.get("/webhook-log", (req, res) => res.json(webhookLog));

// ── Recebimento de Eventos (POST) ────────────────────────────

router.post("/webhook", async (req, res) => {
  // Meta exige 200 imediato
  res.sendStatus(200);

  try {
    const body = req.body;
    logWebhook(body);
    console.log("[Webhook] recebido:", JSON.stringify(body).slice(0, 200));
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;

        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        // ── Identifica o tenant pelo número que recebeu ────
        const tenant = await getTenantByPhoneNumberId(phoneNumberId);
        if (!tenant) {
          console.warn(`⚠️ Nenhum tenant para phoneNumberId=${phoneNumberId}`);
          continue;
        }

        const { wa } = await getClients(tenant.id);

        // ── Processa mensagens recebidas ──────────────────
        for (const msg of value.messages || []) {
          await processMessage({ tenant, wa, msg, contacts: value.contacts || [] });
        }

        // ── Processa atualizações de status ───────────────
        for (const status of value.statuses || []) {
          await processStatus({ tenant, status });
        }
      }
    }
  } catch (err) {
    console.error("🔥 Erro no webhook:", err);
  }
});

// ── Processamento de Mensagem ────────────────────────────────

async function processMessage({ tenant, wa, msg, contacts }) {
  const rawPhone = msg.from;
  const phone    = PhoneNormalizer.normalize(rawPhone);
  if (!phone) return;

  // Nome do contato (se disponível no payload)
  const contact = contacts.find((c) => c.wa_id === rawPhone);
  const name    = contact?.profile?.name || null;

  // Busca ou cria customer
  const customer = await findOrCreate(tenant.id, phone, name);

  // Marca como lida
  await wa.markRead(msg.id).catch(() => {});

  // Atualiza última interação
  await touchInteraction(customer.id);

  // ── Extrai texto da mensagem ──────────────────────────────
  const text = extractText(msg);

  // Salva mensagem do cliente no histórico temporário
  if (text) chatMemory.push(customer.id, "customer", text);

  // ── Handoff ativo: bot silencioso ─────────────────────────
  if (customer.handoff) {
    console.log(`[${tenant.id}] Handoff ativo para ${phone} — bot silencioso`);
    return;
  }

  if (!text) return;

  console.log(`[${tenant.id}] MSG de ${phone}: ${text.slice(0, 80)}`);

  // ── Gatilhos de handoff ───────────────────────────────────
  if (isHandoffTrigger(text)) {
    await setHandoff(customer.id, true);
    await wa.sendText(
      phone,
      "Aguarde um momento, vou te transferir para um de nossos atendentes. 👨‍💼"
    );
    // Notifica equipe interna via Baileys
    const displayName = customer.name || phone;
    baileys.notify(
      `🔔 *Novo cliente na fila!*\n👤 ${displayName}\n📞 ${phone}\n⏰ ${new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"})}`
    ).catch(() => {});
    return;
  }

  // ── Passa para o bot handler ──────────────────────────────
  // (importado dinamicamente para evitar dependência circular)
  const { handle } = require("./bot.handler");
  await handle({ tenant, wa, customer, msg, text, phone });
}

async function processStatus({ tenant, status }) {
  // Processar status de entrega de mensagem (sent, delivered, read, failed)
  if (status.status === "failed") {
    console.error(`[${tenant.id}] Mensagem ${status.id} falhou:`, status.errors);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function extractText(msg) {
  if (msg.type === "text") return msg.text?.body?.trim() || null;
  if (msg.type === "interactive") {
    return (
      msg.interactive?.button_reply?.title ||
      msg.interactive?.list_reply?.title ||
      null
    );
  }
  return null;
}

const HANDOFF_WORDS = [
  "atendente", "humano", "pessoa", "falar com alguém",
  "quero ajuda", "preciso de ajuda", "reclamação", "problema",
  "cancelar", "não recebi", "errado",
];

function isHandoffTrigger(text) {
  const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return HANDOFF_WORDS.some((w) => t.includes(w));
}

module.exports = router;
