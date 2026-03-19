// src/routes/webhook.routes.js
// Recebe e processa eventos do WhatsApp Cloud API, Instagram DM e Facebook Messenger

const express = require("express");
const ENV = require("../config/env");
const { getTenantByPhoneNumberId, getClients } = require("../services/tenant.service");
const { findOrCreate, touchInteraction, setHandoff } = require("../services/customer.service");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const chatMemory = require("../services/chat-memory.service");
const baileys    = require("../services/baileys.service");
const metaSocial = require("../services/meta-social.service");

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

    // ── Instagram DM ──────────────────────────────────────────
    if (body.object === "instagram") {
      const msgs = metaSocial.parseWebhook(body);
      for (const m of msgs) {
        await processSocialMessage(m);
      }
      return;
    }

    // ── Facebook Messenger ────────────────────────────────────
    if (body.object === "page") {
      const msgs = metaSocial.parseWebhook(body);
      for (const m of msgs) {
        await processSocialMessage(m);
      }
      return;
    }

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

  // ── Extrai texto e mídia da mensagem ──────────────────────
  const { text, mediaUrl, mediaType } = await extractContent(wa, msg);

  // Salva mensagem do cliente no histórico (memória e banco)
  if (text || mediaUrl) {
    await chatMemory.push(customer.id, "customer", text || "", mediaUrl, mediaType);
  }

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
    // Notifica painel em tempo real
    const socketService = require("../services/socket.service");
    socketService.emitQueueUpdate();
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
  const { id, status: s, recipient_id } = status;
  if (s === "failed") {
    console.error(`[${tenant.id}] Mensagem ${id} falhou:`, status.errors);
  }
  
  // Atualiza status no banco para o check azul
  await chatMemory.updateStatus(recipient_id, id, s).catch(() => {});
}

// ── Helpers ──────────────────────────────────────────────────

async function extractContent(wa, msg) {
  let text = null;
  let mediaUrl = null;
  let mediaType = "text";

  if (msg.type === "text") {
    text = msg.text?.body?.trim() || null;
  } else if (msg.type === "interactive") {
    text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || null;
  } else if (msg.type === "image") {
    mediaType = "image";
    text = msg.image.caption || "📷 Imagem";
    mediaUrl = await wa.getMediaUrl(msg.image.id);
  } else if (msg.type === "audio") {
    mediaType = "audio";
    text = "🎵 Áudio";
    mediaUrl = await wa.getMediaUrl(msg.audio.id);
  } else if (msg.type === "document") {
    mediaType = "document";
    text = msg.document.filename || "📄 Documento";
    mediaUrl = await wa.getMediaUrl(msg.document.id);
  } else if (msg.type === "video") {
    mediaType = "video";
    text = msg.video.caption || "🎥 Vídeo";
    mediaUrl = await wa.getMediaUrl(msg.video.id);
  }

  return { text, mediaUrl, mediaType };
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

// ── Instagram / Facebook Messenger ───────────────────────────

async function processSocialMessage({ platform, senderId, senderName, text }) {
  if (!senderId || !text?.trim()) return;
  console.log(`[${platform}] MSG de ${senderId}: ${text.slice(0, 80)}`);

  try {
    // Usa tenant padrão (futuro: multi-tenant por página)
    const tenantId = "tenant-pappi-001";
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) { await prisma.$disconnect(); return; }

    // Cria/busca customer usando senderId como identificador social
    // Não passa pelo PhoneNormalizer pois não é telefone
    const socialId = `${platform}:${senderId}`;
    let customer = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId, phone: socialId } },
    });
    if (!customer) {
      customer = await prisma.customer.create({
        data: { tenantId, phone: socialId, name: senderName || null },
      });
    }
    await prisma.$disconnect();
    await touchInteraction(customer.id);
    await chatMemory.push(customer.id, "customer", text.trim(), null, null, "text");

    // Handoff ativo: bot silencioso
    if (customer.handoff) return;

    // Gatilho de handoff
    if (isHandoffTrigger(text)) {
      await setHandoff(customer.id, true);
      const reply = "Aguarde um momento, vou te transferir para um atendente. 👨‍💼";
      if (platform === "instagram") await metaSocial.sendInstagram(senderId, reply);
      if (platform === "facebook") await metaSocial.sendFacebook(senderId, reply);
      baileys.notify(`🔔 *Nova mensagem ${platform === "instagram" ? "Instagram" : "Facebook"}!*\n👤 ${senderName || senderId}\n💬 ${text.slice(0, 60)}`).catch(() => {});
      return;
    }

    // Gera resposta com Gemini
    const { getClients } = require("../services/tenant.service");
    const { cw } = await getClients(tenantId);
    const gemini = require("../services/gemini.service");
    const history = (await chatMemory.get(customer.id)).slice(-10);

    // Resposta simples via classifyIntent
    const catalog = await cw.getCatalog().catch(() => null);
    const { chatOrder } = gemini;
    let reply;
    if (chatOrder) {
      const result = await chatOrder({
        history: history.map(m => ({ role: m.role === "customer" ? "customer" : "assistant", text: m.text })),
        catalog,
        customerName: customer.name,
        storeName: tenant.name,
      });
      reply = result.reply;
    } else {
      reply = "Olá! Como posso ajudar? 😊";
    }

    await chatMemory.push(customer.id, "assistant", reply, "Pappi", null, "text");
    if (platform === "instagram") await metaSocial.sendInstagram(senderId, reply);
    if (platform === "facebook") await metaSocial.sendFacebook(senderId, reply);

  } catch (err) {
    console.error(`[${platform}] Erro ao processar mensagem:`, err.message);
  }
}

module.exports = router;
