// src/routes/webhook.routes.js
// MELHORIAS (além das correções anteriores):
//   - Rate limiting por telefone (anti-spam, anti-dreno Gemini)
//   - Transcrição automática de áudios com Gemini multimodal

const express = require("express");
const ENV = require("../config/env");
const {
  getTenantByPhoneNumberId,
  normalizeWaPhoneNumberId,
  getClients,
  isLikelyPlaceholderWaPhoneNumberId,
} = require("../services/tenant.service");
const { findOrCreate, touchInteraction, setHandoff } = require("../services/customer.service");
const convState = require("../services/conversation-state.service");
const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
const chatMemory = require("../services/chat-memory.service");
const baileys = require("../services/baileys.service");
const metaSocial = require("../services/meta-social.service");
const metaTelemetry = require("../lib/meta-telemetry");
const { requireAdminKey } = require("../middleware/auth.middleware");
const { checkWebhook } = require("../lib/rate-limiter");
const { transcribeAudio } = require("../services/audio-transcribe.service");
const prisma = require("../lib/db");

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
      const msgs = metaSocial.parseWebhook(body);
      if (msgs.length > 0) {
        const first = msgs[0];
        metaTelemetry.recordInstagramWebhook({
          at: new Date().toISOString(),
          senderId: first.senderId,
          recipientId: first.recipientId,
        });
      }
      for (const m of msgs) await processSocialMessage(m);
      return;
    }
    if (body.object === "page") {
      const msgs = metaSocial.parseWebhook(body);
      if (msgs.length > 0) {
        const first = msgs[0];
        metaTelemetry.recordFacebookWebhook({
          at: new Date().toISOString(),
          senderId: first.senderId,
          recipientId: first.recipientId,
        });
      }
      for (const m of msgs) await processSocialMessage(m);
      return;
    }
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        const phoneNumberId = normalizeWaPhoneNumberId(value?.metadata?.phone_number_id);
        if (!phoneNumberId) continue;

        const tenant = await getTenantByPhoneNumberId(phoneNumberId);
        if (!tenant) {
          const wlog = require("../lib/logger").child({ service: "webhook" });
          const inactive = await prisma.tenant.findFirst({
            where: { waPhoneNumberId: phoneNumberId, active: false },
            select: { id: true, name: true },
          });
          const activeRefs = await prisma.tenant.findMany({
            where: { active: true },
            select: { id: true, name: true, waPhoneNumberId: true },
            orderBy: { name: "asc" },
            take: 50,
          });
          if (inactive) {
            metaTelemetry.recordWhatsAppCloudRouting({
              phoneNumberId,
              resolution: "inactive",
              tenantId: inactive.id,
              tenantName: inactive.name,
            });
            wlog.warn(
              {
                phoneNumberIdReceived: phoneNumberId,
                tenantId: inactive.id,
                tenantName: inactive.name,
                activeTenantsWaPhoneNumberIds: activeRefs.map((t) => ({
                  id: t.id,
                  name: t.name,
                  waPhoneNumberId: t.waPhoneNumberId,
                })),
              },
              "WhatsApp Cloud API: webhook com phone_number_id que bate com tenant INATIVO — reative o tenant ou atualize tenants.waPhoneNumberId para o ID do Meta (número da API). Baileys/QR é outro canal.",
            );
          } else {
            metaTelemetry.recordWhatsAppCloudRouting({
              phoneNumberId,
              resolution: "unmatched",
            });
            const placeholderTenants = activeRefs.filter((t) => isLikelyPlaceholderWaPhoneNumberId(t.waPhoneNumberId));
            const firstBad = placeholderTenants[0];
            wlog.warn(
              {
                phoneNumberIdReceived: phoneNumberId,
                hint: "No Meta: WhatsApp > API do WhatsApp > número > Phone number ID (não é o número de telefone).",
                activeTenantCount: activeRefs.length,
                activeTenantsWaPhoneNumberIds: activeRefs.map((t) => ({
                  id: t.id,
                  name: t.name,
                  waPhoneNumberId: t.waPhoneNumberId,
                })),
                tenantsWithPlaceholderWaPhoneNumberId: placeholderTenants.map((t) => t.id),
                suggestedFix:
                  firstBad != null
                    ? `PATCH /admin/tenants/${firstBad.id} body {"waPhoneNumberId":"${phoneNumberId}"}`
                    : activeRefs.length === 1
                      ? `PATCH /admin/tenants/${activeRefs[0].id} body {"waPhoneNumberId":"${phoneNumberId}"}`
                      : undefined,
              },
              placeholderTenants.length > 0
                ? "WhatsApp Cloud API: waPhoneNumberId no banco parece PLACEHOLDER (ex. SEU_PHONE_NUMBER_ID). Substitua pelo phone_number_id que este log mostra em phoneNumberIdReceived — use suggestedFix."
                : "WhatsApp Cloud API: nenhum tenant ATIVO com waPhoneNumberId igual ao phone_number_id do webhook — mensagens ignoradas até alinhar o banco (PATCH /admin/tenants/:id ou painel). Baileys não usa waPhoneNumberId.",
            );
          }
          continue;
        }

        metaTelemetry.recordWhatsAppCloudRouting({
          phoneNumberId,
          resolution: "matched",
          tenantId: tenant.id,
          tenantName: tenant.name,
        });

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
    require("../lib/logger").child({ service: "webhook" }).error({ err }, "Erro no processamento do webhook");
  }
});

// ── Processamento de Mensagem ────────────────────────────────

async function processMessage({ tenant, wa, msg, contacts }) {
  const isEcho = isMessageEcho(msg, tenant.waPhoneNumberId);
  const rawPhone = isEcho ? msg.to || msg.recipient_id : msg.from;
  const phone = PhoneNormalizer.normalize(rawPhone);
  if (!phone) return;

  // Marca como lido (sem "digitando" — evita ficar travado quando não há resposta)
  if (!isEcho && msg.id) wa.markRead(msg.id, false).catch(() => {});

  const rl = checkWebhook(phone);

  const contact = contacts.find((c) => c.wa_id === rawPhone);
  const name = contact?.profile?.name || null;
  const customer = await findOrCreate(tenant.id, phone, name);

  await touchInteraction(customer.id);
  baileys.setReplyChannel(customer.id, "cloud").catch(() => {});

  const { text, mediaUrl, mediaType } = await extractContent(wa, msg, tenant.waToken);

  // Salva mensagem SEMPRE (mesmo rate limited) — para aparecer no painel
  if (!isEcho && (text || mediaUrl)) {
    await chatMemory.push(customer.id, "customer", text || "", null, mediaUrl, mediaType, msg.id);

    // Análise de sentimento automática
    if (text) {
      try {
        const learning = require("../services/bot-learning.service");
        await learning.analyzeMessage(tenant.id, phone, customer.name, text);
      } catch {}
    }
  }

  // Rate limit: bloqueia processamento do bot, mas mensagem já foi salva e aparece no painel
  if (!rl.allowed) {
    console.warn(`[RateLimit] ${phone} bloqueado — muitas mensagens (reset em ${Math.ceil(rl.resetIn / 1000)}s)`);
    return;
  }

  if (isEcho) {
    const echoText = extractEchoContent(msg) || text;
    if (echoText) {
      await chatMemory.push(customer.id, "human", echoText, "WhatsApp App", null, "text", msg.id);
      const socketService = require("../services/socket.service");
      socketService.emitMessage(customer.id, {
        role: "human",
        text: echoText,
        sender: "WhatsApp App",
        at: new Date().toISOString(),
      });
    }
    return;
  }
  // Mensagem do cliente já foi salva acima (antes do rate limit)

  await convState.resetIfEncerrado(customer);

  const botMayRespond = await convState.shouldBotRespond(customer);
  if (!botMayRespond) {
    console.log(`[${tenant.id}] Estado ${await convState.getState(customer)} para ${phone} — bot silencioso`);
    return;
  }

  if (!text) return;

  const log = require("../lib/logger").child({ service: "webhook" });
  log.info({ tenantId: tenant.id, phone, text: text.slice(0, 80) }, "MSG Cloud recebida");

  // ── Handoff apenas fora de fluxo ativo ───────────────────
  const sessionService = require("../services/session.service");
  const session = await sessionService.get(tenant.id, phone);
  const inActiveFlow = session && !["MENU", "ASK_NAME", "CHOOSE_PRODUCT_TYPE", "FULFILLMENT"].includes(session.step);

  if (!inActiveFlow && isHandoffTrigger(text)) {
    await setHandoff(customer.id, true);
    try {
      await wa.sendText(phone, "Aguarde um momento, vou te transferir para um de nossos atendentes. 👨‍💼");
    } catch (e) {
      log.warn(
        { tenantId: tenant.id, phone, err: e.message, code: e.code },
        "Handoff Cloud: falha ao enviar mensagem automática (token/phoneNumberId ou API)",
      );
    }
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
  const { id, status: s } = status;
  if (s === "failed") console.error(`Mensagem ${id} falhou:`, status.errors);

  const messageDbCompat = require("../lib/message-db-compat");
  if (!messageDbCompat.isMessagesTableAvailable()) return;

  const row = await prisma.message
    .findFirst({
      where: { waMessageId: id },
      select: { customerId: true },
    })
    .catch(() => null);

  if (row?.customerId) {
    await chatMemory.updateStatus(row.customerId, id, s).catch(() => {});
  }
}

// ── extractContent — com transcrição de áudio ────────────────

async function extractContent(wa, msg, waToken) {
  let text = null,
    mediaUrl = null,
    mediaType = "text";

  if (msg.type === "text") {
    text = msg.text?.body?.trim() || null;
  } else if (msg.type === "interactive") {
    const btn = msg.interactive?.button_reply;
    const list = msg.interactive?.list_reply;
    if (btn) {
      const id = btn.id;
      const flowIds = ["delivery", "takeout", "confirm_addr", "change_addr", "CONFIRMAR", "CANCELAR", "AVISE_ABERTURA"];
      text = flowIds.includes(id) ? id : btn.title || id || null;
    } else if (list) {
      text = list.title || list.id || null;
    }
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

function isMessageEcho(msg, phoneNumberId) {
  if (!msg || !phoneNumberId) return false;
  if (msg.from === String(phoneNumberId)) return true;
  if (msg.context?.from === String(phoneNumberId)) return true;
  return false;
}

function extractEchoContent(msg) {
  if (msg?.text?.body) return msg.text.body.trim();
  if (msg?.caption) return msg.caption.trim();
  return null;
}

// Comandos PT-BR que ativam handoff (falar com humano) — SEM "cancelar"/"errado" (conflitam com pedidos)
const HANDOFF_WORDS = [
  "atendente",
  "humano",
  "pessoa",
  "falar com alguém",
  "falar com alguem",
  "quero ajuda",
  "preciso de ajuda",
  "preciso ajuda",
  "reclamação",
  "reclamacao",
  "reclamar",
  "não recebi",
  "nao recebi",
  "erro no pedido",
  "pedido errado",
  "cobrança",
  "cobranca",
  "motoboy",
  "entregador",
  "cancelamento",
  "problema",
  "devolução",
  "devolucao",
  "urgente",
  "emergência",
  "emergencia",
];

function isHandoffTrigger(text) {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return HANDOFF_WORDS.some((w) => t.includes(w));
}

// ── Instagram / Facebook Messenger ───────────────────────────

async function processSocialMessage({ platform, senderId, recipientId, senderName, text, attachmentType, attachmentUrl }) {
  if (!senderId) return;

  const txt = text && typeof text === "string" ? text.trim() : "";
  const attachLabel = attachmentType && typeof attachmentType === "string" ? `📎 ${attachmentType}` : "";
  const displayText = txt || attachLabel || (attachmentUrl ? "📎 anexo" : "");
  if (!displayText) return;

  const log = require("../lib/logger").child({ service: "webhook" });

  try {
    const tenantId = await metaSocial.resolveTenantId({ platform, recipientId, senderId });
    if (!tenantId) {
      log.warn({ platform, senderId, recipientId }, "Social: tenant não encontrado — mensagem ignorada");
      return;
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return;

    const socialId = `${platform}:${senderId}`;
    let customer = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId, phone: socialId } },
    });
    if (!customer) {
      const resolvedName = senderName || (await metaSocial.resolveSenderName({ platform, senderId, tenantId }));
      customer = await prisma.customer.create({
        data: { tenantId, phone: socialId, name: resolvedName || null },
      });
    } else if (!customer.name) {
      const resolvedName = senderName || (await metaSocial.resolveSenderName({ platform, senderId, tenantId }));
      if (resolvedName) {
        customer = await prisma.customer.update({
          where: { id: customer.id },
          data: { name: resolvedName },
        });
      }
    }

    await touchInteraction(customer.id);
    let mediaType = "text";
    if (attachmentType) {
      const t = String(attachmentType).toLowerCase();
      if (t.includes("image") || t.includes("photo")) mediaType = "image";
      else if (t.includes("audio")) mediaType = "audio";
      else if (t.includes("video")) mediaType = "video";
      else mediaType = "document";
    }
    const mediaUrl = typeof attachmentUrl === "string" ? attachmentUrl.trim() : null;
    await chatMemory.push(customer.id, "customer", displayText, null, mediaUrl, mediaType, null);

    await convState.resetIfEncerrado(customer);

    const botMayRespond = await convState.shouldBotRespond(customer);
    if (!botMayRespond) return;

    if (isHandoffTrigger(displayText)) {
      await setHandoff(customer.id, true);
      const reply = "Aguarde um momento, vou te transferir para um atendente. 👨‍💼";
      if (platform === "instagram") {
        const r = await metaSocial.sendInstagram(senderId, reply, tenantId);
        if (r?.error) log.warn({ tenantId, code: r.code, message: r.message }, "Social handoff: falha Instagram");
      }
      if (platform === "facebook") {
        const r = await metaSocial.sendFacebook(senderId, reply, tenantId);
        if (r?.error) log.warn({ tenantId, code: r.code, message: r.message }, "Social handoff: falha Facebook");
      }
      baileys
        .notify(`🔔 *Nova mensagem ${platform}!*\n👤 ${senderName || senderId}\n💬 ${displayText.slice(0, 60)}`)
        .catch(() => {});

      const socketService = require("../services/socket.service");
      socketService.emitQueueUpdate();
      socketService.emitConvUpdate(customer.id);
      return;
    }

    const { getClients } = require("../services/tenant.service");
    const { cw } = await getClients(tenantId);
    const ai = require("../services/ai.service");
    const history = (await chatMemory.get(customer.id)).slice(-10);
    const catalog = await cw.getCatalog().catch(() => null);

    const result = await ai.chatOrder({
      history: history.map((m) => ({ role: m.role === "customer" ? "customer" : "assistant", text: m.text })),
      catalog,
      customerName: customer.name,
      storeName: tenant.name,
    });

    const reply = typeof result?.reply === "string" ? result.reply.trim() : "";
    if (reply) {
      await chatMemory.push(customer.id, "assistant", reply, "Pappi", null, "text");
      if (platform === "instagram") {
        const r = await metaSocial.sendInstagram(senderId, reply, tenantId);
        if (r?.error) log.warn({ tenantId, code: r.code, message: r.message }, "Social bot: falha Instagram");
      }
      if (platform === "facebook") {
        const r = await metaSocial.sendFacebook(senderId, reply, tenantId);
        if (r?.error) log.warn({ tenantId, code: r.code, message: r.message }, "Social bot: falha Facebook");
      }
    }
  } catch (err) {
    log.error({ platform, senderId, err }, "Social: erro ao processar mensagem");
  }
}

module.exports = router;
