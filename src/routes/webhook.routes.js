// src/routes/webhook.routes.js
// MELHORIAS (além das correções anteriores):
//   - Rate limiting por telefone (anti-spam, anti-dreno Gemini)
//   - Transcrição automática de áudios com Gemini multimodal

const express = require("express");
const ENV = require("../config/env");
const { getTenantByPhoneNumberId, getClients } = require("../services/tenant.service");
const { findOrCreate, touchInteraction, setHandoff } = require("../services/customer.service");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const chatMemory = require("../services/chat-memory.service");
const baileys = require("../services/baileys.service");
const metaSocial = require("../services/meta-social.service");
const { requireAdminKey } = require("../middleware/auth.middleware");
const { checkWebhook } = require("../lib/rate-limiter");
const { transcribeAudio } = require("../services/audio-transcribe.service");

const router = express.Router();

// ── Verificação do Webhook (GET) ─────────────────────────────

router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === ENV.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  console.warn("⚠️ Verificação de webhook inválida");
  return res.sendStatus(403);
});

// ── Log dos últimos webhooks — PROTEGIDO ──────────────────────
const webhookLog = [];
function logWebhook(body) {
  webhookLog.unshift({ at: new Date().toISOString(), body });
  if (webhookLog.length > 10) webhookLog.pop();
}
router.get("/webhook-log", requireAdminKey, (_req, res) => res.json(webhookLog));

// ── Recebimento de Eventos (POST) ────────────────────────────

router.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    logWebhook(body);

    if (body.object === "instagram") {
      for (const m of metaSocial.parseWebhook(body)) await processSocialMessage(m);
      return;
    }
    if (body.object === "page") {
      for (const m of metaSocial.parseWebhook(body)) await processSocialMessage(m);
      return;
    }
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const tenant = await getTenantByPhoneNumberId(phoneNumberId);
        if (!tenant) {
          console.warn(`⚠️ Nenhum tenant para phoneNumberId=${phoneNumberId}`);
          continue;
        }

        const { wa } = await getClients(tenant.id);

        for (const msg of value.messages || []) {
          await processMessage({ tenant, wa, msg, contacts: value.contacts || [] });
        }
        for (const status of value.statuses || []) {
          await processStatus({ status });
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
  const phone = PhoneNormalizer.normalize(rawPhone);
  if (!phone) return;

  // ── Rate limiting por telefone ────────────────────────────
  const rl = checkWebhook(phone);
  if (!rl.allowed) {
    console.warn(`[RateLimit] ${phone} bloqueado — muitas mensagens (reset em ${Math.ceil(rl.resetIn / 1000)}s)`);
    return;
  }

  const contact = contacts.find((c) => c.wa_id === rawPhone);
  const name = contact?.profile?.name || null;
  const customer = await findOrCreate(tenant.id, phone, name);

  await wa.markRead(msg.id).catch(() => {});
  await touchInteraction(customer.id);

  const { text, mediaUrl, mediaType } = await extractContent(wa, msg, tenant.waToken);

  if (text || mediaUrl) {
    await chatMemory.push(customer.id, "customer", text || "", null, mediaUrl, mediaType, msg.id);
  }

  if (customer.handoff) {
    console.log(`[${tenant.id}] Handoff ativo para ${phone} — bot silencioso`);
    return;
  }

  if (!text) return;

  console.log(`[${tenant.id}] MSG de ${phone}: ${text.slice(0, 80)}`);

  // ── Handoff apenas fora de fluxo ativo ───────────────────
  const sessionService = require("../services/session.service");
  const session = await sessionService.get(tenant.id, phone);
  const inActiveFlow = session && !["MENU", "ASK_NAME", "FULFILLMENT"].includes(session.step);

  if (!inActiveFlow && isHandoffTrigger(text)) {
    await setHandoff(customer.id, true);
    await wa.sendText(phone, "Aguarde um momento, vou te transferir para um de nossos atendentes. 👨‍💼");
    const socketService = require("../services/socket.service");
    socketService.emitQueueUpdate();
    baileys
      .notify(
        `🔔 *Novo cliente na fila!*\n👤 ${customer.name || phone}\n📞 ${phone}\n⏰ ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`,
      )
      .catch(() => {});
    return;
  }

  const { handle } = require("./bot.handler");
  await handle({ tenant, wa, customer, msg, text, phone });
}

async function processStatus({ status }) {
  const { id, status: s, recipient_id } = status;
  if (s === "failed") console.error(`Mensagem ${id} falhou:`, status.errors);
  await chatMemory.updateStatus(recipient_id, id, s).catch(() => {});
}

// ── extractContent — com transcrição de áudio ────────────────

async function extractContent(wa, msg, waToken) {
  let text = null,
    mediaUrl = null,
    mediaType = "text";

  if (msg.type === "text") {
    text = msg.text?.body?.trim() || null;
  } else if (msg.type === "interactive") {
    text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || null;
  } else if (msg.type === "image") {
    mediaType = "image";
    mediaUrl = await wa.getMediaUrl(msg.image.id);
    text = msg.image.caption || "📷 Imagem";
  } else if (msg.type === "audio") {
    mediaType = "audio";
    mediaUrl = await wa.getMediaUrl(msg.audio.id);

    // MELHORIA: tenta transcrever o áudio antes de passar para o bot
    if (mediaUrl && waToken) {
      const transcription = await transcribeAudio(mediaUrl, waToken);
      if (transcription) {
        text = transcription;
        console.log(`[Webhook] Áudio transcrito: "${transcription.slice(0, 60)}..."`);
      } else {
        text = "🎵 Áudio (não foi possível transcrever)";
      }
    } else {
      text = "🎵 Áudio";
    }
  } else if (msg.type === "document") {
    mediaType = "document";
    text = msg.document.filename || "📄 Documento";
    mediaUrl = await wa.getMediaUrl(msg.document.id);
  } else if (msg.type === "video") {
    mediaType = "video";
    text = msg.video.caption || "🎥 Vídeo";
    mediaUrl = await wa.getMediaUrl(msg.video.id);
  } else if (msg.type === "location") {
    // Localização enviada pelo cliente — usada para endereço de entrega
    mediaType = "location";
    const { latitude, longitude, name: locName, address: locAddr } = msg.location;
    text = `📍 Localização: ${locName || ""} ${locAddr || ""} (${latitude},${longitude})`.trim();
  }

  return { text, mediaUrl, mediaType };
}

// Palavras que ativam handoff — SEM "cancelar"/"errado" (conflitavam com pedidos)
const HANDOFF_WORDS = [
  "atendente",
  "humano",
  "pessoa",
  "falar com alguém",
  "falar com alguem",
  "quero ajuda",
  "preciso de ajuda",
  "reclamação",
  "reclamacao",
  "não recebi",
  "nao recebi",
];

function isHandoffTrigger(text) {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return HANDOFF_WORDS.some((w) => t.includes(w));
}

// ── Instagram / Facebook Messenger ───────────────────────────

async function processSocialMessage({ platform, senderId, senderName, text }) {
  if (!senderId || !text?.trim()) return;
  try {
    const prisma = require("../lib/db");
    const tenantId = "tenant-pappi-001";
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return;

    const socialId = `${platform}:${senderId}`;
    let customer = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId, phone: socialId } },
    });
    if (!customer) {
      customer = await prisma.customer.create({
        data: { tenantId, phone: socialId, name: senderName || null },
      });
    }

    await touchInteraction(customer.id);
    await chatMemory.push(customer.id, "customer", text.trim(), null, null, "text");

    if (customer.handoff) return;

    if (isHandoffTrigger(text)) {
      await setHandoff(customer.id, true);
      const reply = "Aguarde um momento, vou te transferir para um atendente. 👨‍💼";
      if (platform === "instagram") await metaSocial.sendInstagram(senderId, reply);
      if (platform === "facebook") await metaSocial.sendFacebook(senderId, reply);
      baileys
        .notify(`🔔 *Nova mensagem ${platform}!*\n👤 ${senderName || senderId}\n💬 ${text.slice(0, 60)}`)
        .catch(() => {});
      return;
    }

    const { getClients } = require("../services/tenant.service");
    const { cw } = await getClients(tenantId);
    const gemini = require("../services/gemini.service");
    const history = (await chatMemory.get(customer.id)).slice(-10);
    const catalog = await cw.getCatalog().catch(() => null);

    const result = await gemini.chatOrder({
      history: history.map((m) => ({ role: m.role === "customer" ? "customer" : "assistant", text: m.text })),
      catalog,
      customerName: customer.name,
      storeName: tenant.name,
    });

    await chatMemory.push(customer.id, "assistant", result.reply, "Pappi", null, "text");
    if (platform === "instagram") await metaSocial.sendInstagram(senderId, result.reply);
    if (platform === "facebook") await metaSocial.sendFacebook(senderId, result.reply);
  } catch (err) {
    console.error(`[${platform}] Erro:`, err.message);
  }
}

module.exports = router;
