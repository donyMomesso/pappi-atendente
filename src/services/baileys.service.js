// src/services/baileys.service.js
// Multi-WhatsApp via Baileys (QR Code) para notificações INTERNAS da equipe
//
// IMPORTANTE: Toda a lógica usa o instanceId (a CONEXÃO), nunca o número conectado.
// Qualquer número pode ser conectado a qualquer instância — ao reconectar/reescanear
// o QR, o número pode mudar. O que importa é a instância (ex: "default", "drmlogistica").

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { useDbAuthState, clearDbAuth, listInstances } = require("./baileys-db-auth");
const QRCode = require("qrcode");
const prisma = require("../lib/db");
const log = require("../lib/logger").child({ service: "baileys" });

// ── Limites de segurança por instância (bot + notificações) ─────
const LIMITS = { perHour: 60, perDay: 200, alertAt: 0.7 };

const INSTANCES = new Map();

// Cache da versão Baileys — evita chamar URL externa a cada reconexão
let _cachedVersion = null;
async function getBaileysVersion() {
  if (_cachedVersion) return _cachedVersion;
  const { version } = await fetchLatestBaileysVersion();
  _cachedVersion = version;
  // Invalida o cache após 1h para não usar versão muito antiga
  setTimeout(() => {
    _cachedVersion = null;
  }, 3_600_000);
  return version;
}

function createInstanceData(id) {
  return {
    id,
    socket: null,
    qrBase64: null,
    status: "disconnected",
    starting: false,
    lastAlert: null,
    account: null,
    notifyTo: [],
    botEnabled: true,
    _reconnectDelay: 8000,
    _replaced440Count: 0,
    _genericDisconnectCount: 0,
    _lastDisconnectAt: 0,
    counters: {
      hour: 0,
      day: 0,
      hourReset: Date.now() + 3600_000,
      dayReset: Date.now() + 86_400_000,
      alerted: { hour: false, day: false },
    },
  };
}

function resetCounters(inst) {
  const now = Date.now();
  if (now >= inst.counters.hourReset) {
    inst.counters.hour = 0;
    inst.counters.hourReset = now + 3600_000;
    inst.counters.alerted.hour = false;
  }
  if (now >= inst.counters.dayReset) {
    inst.counters.day = 0;
    inst.counters.dayReset = now + 86_400_000;
    inst.counters.alerted.day = false;
  }
}

function checkLimits(inst) {
  resetCounters(inst);
  const hourPct = inst.counters.hour / LIMITS.perHour;
  const dayPct = inst.counters.day / LIMITS.perDay;

  if (hourPct >= LIMITS.alertAt && !inst.counters.alerted.hour) {
    inst.counters.alerted.hour = true;
    inst.lastAlert = `⚠️ [${inst.id}] Atenção: ${inst.counters.hour}/${LIMITS.perHour} msgs/h (${Math.round(hourPct * 100)}%).`;
  }
  if (dayPct >= LIMITS.alertAt && !inst.counters.alerted.day) {
    inst.counters.alerted.day = true;
    inst.lastAlert = `⚠️ [${inst.id}] Atenção: ${inst.counters.day}/${LIMITS.perDay} msgs/dia (${Math.round(dayPct * 100)}%).`;
  }
  if (inst.counters.hour >= LIMITS.perHour) {
    inst.lastAlert = `🚫 [${inst.id}] Limite HORÁRIO atingido.`;
    return false;
  }
  if (inst.counters.day >= LIMITS.perDay) {
    inst.lastAlert = `🚫 [${inst.id}] Limite DIÁRIO atingido.`;
    return false;
  }
  return true;
}

// ── Helpers de JID / telefone ──────────────────────────────────
function normalizeToDigits(raw) {
  if (raw == null || raw === "") return "";
  const s = String(raw);
  const part = s.split("@")[0].split(":")[0];
  return part.replace(/\D/g, "");
}

function extractPhoneFromMessage(msg) {
  try {
    const key = msg?.key || {};
    const remoteJid = key.remoteJid || "";
    const m = msg?.message || {};

    // Ordem de prioridade: remoteJidAlt resolve @lid
    const candidates = [
      key.remoteJidAlt,
      key.participantPn,
      key.senderPn,
      msg?.participantPn,
      msg?.senderPn,
      key.participant,
      msg?.participant,
      m?.extendedTextMessage?.contextInfo?.participant,
      m?.imageMessage?.contextInfo?.participant,
      m?.videoMessage?.contextInfo?.participant,
      m?.documentMessage?.contextInfo?.participant,
      m?.buttonsResponseMessage?.contextInfo?.participant,
      m?.listResponseMessage?.contextInfo?.participant,
    ];

    for (const c of candidates) {
      const digits = normalizeToDigits(c);
      if (digits.length >= 10 && digits.length <= 15) return digits;
    }

    if (remoteJid.endsWith("@s.whatsapp.net")) {
      const digits = normalizeToDigits(remoteJid);
      if (digits.length >= 10 && digits.length <= 15) return digits;
    }

    return null;
  } catch {
    return null;
  }
}

function extractIncomingText(msg) {
  const m = msg?.message || {};
  let text =
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    null;

  if (!text) {
    const btnResp = m?.buttonsResponseMessage;
    if (btnResp) {
      const id = btnResp.selectedButtonId || "";
      const display = btnResp.selectedDisplayText || "";
      const flowIds = [
        "delivery",
        "takeout",
        "confirm_addr",
        "change_addr",
        "CONFIRMAR",
        "CANCELAR",
        "AVISE_ABERTURA",
        "HELP_HUMAN",
        "HELP_BOT",
        "FULFILLMENT_RETIRADA",
      ];
      text = flowIds.includes(id) ? id : display || id || "";
    }
  }

  if (!text) {
    const listResp = m?.listResponseMessage;
    if (listResp) {
      text = listResp.singleSelectReply?.selectedRowId || listResp.title || listResp.description || "";
    }
  }

  if (text) {
    const t = String(text)
      .toLowerCase()
      .replace(/✅|✏️|❌/g, "")
      .trim();
    if (t === "corrigir") text = "change_addr";
    else if (t === "cancelar") text = "CANCELAR";
    else if (t === "confirmar" || t === "confirma") text = "confirm_addr";
  }

  return text || null;
}

// ── Detecta tenantId a partir do número do remetente ──────────
// Busca o customer no banco pelo telefone e retorna o tenantId dele.
// instanceId: se informado e número for novo, usa tenant do Config baileys:instance:{id}
async function detectTenantByPhone(phone, instanceId = null) {
  try {
    const PhoneNormalizer = require("../normalizers/PhoneNormalizer");
    const normalized = PhoneNormalizer.normalize(phone);
    if (!normalized) return null;

    const customer = await prisma.customer.findFirst({
      where: { phone: normalized },
      select: { tenantId: true },
      orderBy: { lastInteraction: "desc" },
    });

    if (customer?.tenantId) return customer.tenantId;

    // Número novo: tenta tenant da instância (Config baileys:instance:{id})
    if (instanceId) {
      const cfg = await prisma.config.findUnique({
        where: { key: `baileys:instance:${instanceId}` },
      });
      if (cfg?.value) {
        try {
          const { tenantId } = JSON.parse(cfg.value);
          if (tenantId) {
            console.log(`[Baileys] Número novo ${normalized} — tenant da instância ${instanceId}`);
            return tenantId;
          }
        } catch {}
      }
    }

    // Fallback: primeiro tenant ativo
    const fallbackTenant = await prisma.tenant.findFirst({
      where: { active: true },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });

    if (fallbackTenant) {
      console.log(`[Baileys] Número novo ${normalized} — atribuído ao tenant ${fallbackTenant.id} (fallback)`);
    }

    return fallbackTenant?.id || null;
  } catch {
    return null;
  }
}

// Salva o canal de resposta para o customer (cloud ou baileys:instanceId)
async function setReplyChannel(customerId, channel) {
  try {
    await prisma.config.upsert({
      where: { key: `reply_channel:${customerId}` },
      create: { key: `reply_channel:${customerId}`, value: channel },
      update: { value: channel },
    });
  } catch (e) {
    console.error("[Baileys] Erro ao salvar reply_channel:", e.message);
  }
}

// Retorna o canal de resposta do customer (cloud | baileys:instanceId)
async function getReplyChannel(customerId) {
  try {
    const cfg = await prisma.config.findUnique({
      where: { key: `reply_channel:${customerId}` },
    });
    return cfg?.value || "cloud";
  } catch {
    return "cloud";
  }
}

// ── Conexão ────────────────────────────────────────────────────
async function start(instanceId = "default") {
  let inst = INSTANCES.get(instanceId);
  if (!inst) {
    inst = createInstanceData(instanceId);
    INSTANCES.set(instanceId, inst);
  }

  if (inst.starting || inst.status === "connected" || inst.status === "qr") return;
  if (inst.status === "conflict") return;
  inst.starting = true;

  try {
    const { state, saveCreds } = await useDbAuthState(instanceId);
    const version = await getBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: require("pino")({ level: "silent" }),
      browser: ["Pappi Atendente", "Chrome", "1.0"],
      qrTimeout: 60000,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    inst.socket = sock;
    inst.status = "connecting";
    inst.starting = false;

    sock.ev.on("creds.update", saveCreds);

    // Captura mensagens recebidas (notify = nova em tempo real, append = histórico após reconexão)
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;
      const isAppend = type === "append";

      const recoverySent = new Set(); // evita mandar "Voltei!" várias vezes no mesmo batch

      for (const msg of messages) {
        const jid = msg?.key?.remoteJid;

        if (!jid || jid.endsWith("@g.us")) continue; // ignora grupos
        if (jid === "status@broadcast" || jid.endsWith("@broadcast")) continue; // ignora status/stories
        if (msg?.key?.fromMe) continue;

        if (!msg?.message) {
          log.warn(
            {
              instanceId,
              jid,
              key: msg?.key,
              messageStubType: msg?.messageStubType,
              messageStubParameters: msg?.messageStubParameters,
            },
            "Mensagem recebida sem payload em msg.message",
          );
          continue;
        }

        const phone = extractPhoneFromMessage(msg);

        if (!phone) {
          log.warn(
            {
              instanceId,
              jid,
              key: msg?.key,
              pushName: msg?.pushName,
              verifiedBizName: msg?.verifiedBizName,
              messageKeys: Object.keys(msg.message || {}),
              messageStubType: msg?.messageStubType,
              messageStubParameters: msg?.messageStubParameters,
            },
            "Não foi possível resolver o telefone da mensagem",
          );
          continue;
        }

        const text = extractIncomingText(msg);
        if (!text) {
          log.warn({ instanceId, phone, jid }, "Mensagem sem texto reconhecível");
          continue;
        }

        const waId = msg?.key?.id;

        // Evita reprocessar mensagens já gravadas (recovery após reconexão)
        if (waId) {
          const existing = await prisma.message.findFirst({ where: { waMessageId: waId } });
          if (existing) continue;
        }

        log.info(
          { instanceId, jid, phone, text: text.slice(0, 80), type },
          isAppend ? "MSG append (recovery)" : "MSG recebida",
        );

        try {
          // Lido + digitando — apenas para notify; append são msgs antigas
          if (!isAppend) {
            try {
              await sock.readMessages([msg.key]);
              await sock.sendPresenceUpdate("composing", jid);
            } catch {}
          }

          try {
            const tenantId = await detectTenantByPhone(phone, instanceId);
            if (!tenantId) {
              log.warn({ instanceId, phone, jid }, "Tenant não encontrado — msg ignorada");
              continue;
            }

            const { findOrCreate, touchInteraction } = require("../services/customer.service");
            const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
            if (!tenant) {
              log.warn({ instanceId, tenantId }, "Tenant não existe no banco — msg ignorada");
              continue;
            }

            // Cria customer ANTES de salvar msg — números novos não existiam e msg era descartada
            const pushName = msg.pushName || msg.verifiedBizName || null;
            const customer = await findOrCreate(tenantId, phone, pushName);

            if (pushName && !customer.name) {
              await prisma.customer
                .update({
                  where: { id: customer.id },
                  data: { name: pushName },
                })
                .catch(() => {});
            }

            await touchInteraction(customer.id);
            await setReplyChannel(customer.id, `baileys:${instanceId}`);

            const botHandler = require("../routes/bot.handler");
            await botHandler.saveBaileysMessage(customer.phone, text, tenantId, "customer", waId || undefined);
            require("./socket.service").emitConvUpdate(customer.id);

            if (isAppend && !recoverySent.has(customer.id)) {
              recoverySent.add(customer.id);
              const recovery =
                "Voltei! Desculpe a demora, estava reconectando. Analisando suas mensagens...";
              try {
                await sendText(customer.phone, recovery, instanceId, true);
                await botHandler.saveBaileysMessage(customer.phone, recovery, tenantId, "assistant");
              } catch (e) {
                log.warn({ instanceId, phone: customer.phone, err: e }, "Falha ao enviar msg de retomada");
              }
            }

            if (inst.botEnabled !== false) {
              try {
                const convState = require("./conversation-state.service");
                await convState.resetIfEncerrado(customer);
                const botMayRespond = await convState.shouldBotRespond(customer);

                if (!botMayRespond) {
                  const state = await convState.getState(customer);

                  // Auto-libera se estava aguardando humano mas não há atendente ativo
                  if (state === "aguardando_humano" && !customer.claimedBy) {
                    log.info({ instanceId, phone }, "Auto-liberando handoff sem atendente — devolvendo ao bot");
                    await convState.setState(customer.id, "bot_ativo");
                    customer.handoff = false;
                  } else {
                    log.info({ instanceId, phone, state }, "Bot silencioso (handoff/estado)");
                    continue;
                  }
                }

                const wa = {
                  // saveHistory=false: bot handler já salva via chatMemory.push — evita dupla gravação
                  sendText: async (to, msgText) => {
                    const ok = await sendText(to, msgText, instanceId, true, false);
                    if (!ok) log.warn({ instanceId, to }, "Falha ao enviar resposta");
                    return ok;
                  },
                  sendButtons: (to, body, buttons) =>
                    sendText(
                      to,
                      body + "\n\n" + (buttons?.map((b) => b.title).join(" | ") || ""),
                      instanceId,
                      true,
                      false,
                    ),
                  sendImage: () => {},
                  sendDocument: () => {},
                };

                log.debug({ instanceId, phone }, "Chamando bot.handle");
                await botHandler.handle({ tenant, wa, customer, text, phone: customer.phone });
                require("./socket.service").emitConvUpdate(customer.id);
                log.debug({ instanceId, phone }, "Bot.handle concluído");
              } catch (e) {
                log.error({ instanceId, phone, err: e }, "Erro no bot");
                try {
                  const { incrementBotErrorAndCheckHandoff } = require("./customer.service");
                  const { shouldHandoff } = await incrementBotErrorAndCheckHandoff(customer.id);
                  const ENV = require("../config/env");
                  const statusUrl = `${ENV.APP_URL || "https://pappiatendente.com.br"}/status`;

                  let fallback;
                  if (shouldHandoff) {
                    const { setHandoff } = require("./customer.service");
                    await setHandoff(customer.id, true);
                    fallback =
                      "Como a instabilidade persistiu, você será direcionado para um atendente humano. Aguarde um momento! 👨‍💼";
                  } else {
                    fallback =
                      `Estamos com instabilidade no WhatsApp. Aguarde alguns minutos e tente novamente. Acompanhe: ${statusUrl}\n\nSe persistir, você será direcionado para atendimento humano.`;
                  }
                  await sendText(customer.phone, fallback, instanceId, true);
                  await botHandler.saveBaileysMessage(customer.phone, fallback, tenantId, "assistant");
                  if (shouldHandoff) {
                    const socketService = require("./socket.service");
                    socketService.emitQueueUpdate();
                    socketService.emitConvUpdate(customer.id);
                  }
                } catch (f) {
                  log.error({ instanceId, err: f }, "Falha ao enviar mensagem de fallback");
                }
              }
            }
          } finally {
            // Para o "digitando" — evita ficar travado quando não há resposta
            try {
              await sock.sendPresenceUpdate("paused", jid);
            } catch {}
          }
        } catch (err) {
          console.error(`[Baileys:${instanceId}] Erro ao processar msg:`, err.message);
          try {
            await sock.sendPresenceUpdate("paused", jid);
          } catch {}
        }
      }
    });

    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      try {
        if (qr) {
          inst.status = "qr";
          inst.qrBase64 = await QRCode.toDataURL(qr);
          log.info({ instanceId }, "QR Code gerado — escaneie no WhatsApp");
        }

        if (connection === "open") {
          inst.status = "connected";
          inst.qrBase64 = null;
          inst.starting = false;
          inst._reconnectDelay = 8000;
          inst._replaced440Count = 0;
          if (Date.now() - inst._lastDisconnectAt > 300_000) inst._genericDisconnectCount = 0;
          const user = sock.user;
          inst.account = {
            phone: user?.id?.split(":")[0] || user?.id || "?",
            name: user?.name || "?",
          };
          log.info({ instanceId, phone: inst.account.phone, name: inst.account.name }, "Baileys conectado com sucesso");
        }

        if (connection === "close") {
          const code = lastDisconnect?.error?.output?.statusCode;
          const errMsg = lastDisconnect?.error?.message || "";
          const loggedOut = code === DisconnectReason.loggedOut;
          const replaced = code === DisconnectReason.connectionReplaced;
          inst.status = "disconnected";
          inst.socket = null;
          inst.starting = false;
          inst._lastDisconnectAt = Date.now();

          if (!inst._intentionalDisconnect) {
            const reason = loggedOut
              ? "Logout (401)"
              : replaced
                ? "Sessão substituída (440)"
                : code
                  ? `Conexão fechada (code ${code})`
                  : "Conexão fechada";
            log.warn(
              { instanceId, code, errMsg: errMsg.slice(0, 200) },
              `Baileys desconectado: ${reason}`,
            );
            try {
              require("./socket.service").emitBaileysDisconnected(instanceId, reason);
            } catch (e) {
              log.warn({ err: e }, "Falha ao emitir baileys_disconnected");
            }
          }
          inst._intentionalDisconnect = false;

          if (loggedOut) {
            log.info({ instanceId }, "Logout detectado — limpando auth");
            await clearDbAuth(instanceId);
            inst.qrBase64 = null;
            inst._reconnectDelay = 8000;
            inst._genericDisconnectCount = 0;
          } else if (replaced) {
            inst._replaced440Count = (inst._replaced440Count || 0) + 1;
            if (inst._replaced440Count >= 3) {
              inst.status = "conflict";
              log.warn(
                { instanceId, replaced440Count: inst._replaced440Count },
                "Sessão 440 — parando reconexão. Outra sessão ativa. Recuperação manual necessária.",
              );
            } else {
              const delayMs = inst._replaced440Count === 1 ? 45000 : 90000;
              log.info(
                { instanceId, attempt: inst._replaced440Count, delaySec: delayMs / 1000 },
                "Sessão 440 — reconectando após delay",
              );
              setTimeout(() => start(instanceId), delayMs);
            }
          } else {
            inst._replaced440Count = 0;
            inst._genericDisconnectCount = (inst._genericDisconnectCount || 0) + 1;
            const backoffDelays = [8000, 16000, 32000, 60000, 120000];
            const delayMs = Math.min(
              backoffDelays[Math.min(inst._genericDisconnectCount - 1, backoffDelays.length - 1)],
              120000,
            );
            inst._reconnectDelay = delayMs;
            log.info(
              { instanceId, code, attempt: inst._genericDisconnectCount, delaySec: delayMs / 1000 },
              "Conexão fechada — reconectando com backoff",
            );
            setTimeout(() => start(instanceId), delayMs);
          }
        }
      } catch (err) {
        log.error({ err, instanceId, connection }, "Erro em connection.update");
      }
    });
  } catch (err) {
    inst.starting = false;
    console.error(`[Baileys:${instanceId}] Erro ao iniciar:`, err.message);
    setTimeout(() => start(instanceId), 15000);
  }
}

// Proteção: evita initAll duplicado em processo
let _initInProgress = false;
let _initDone = false;

async function initAll() {
  const ENV = require("../config/env");
  if (!ENV.BAILEYS_ENABLED) {
    log.info("Baileys desabilitado (BAILEYS_ENABLED=false)");
    return;
  }
  if (_initInProgress) {
    log.warn("initAll já em andamento — ignorando chamada duplicada");
    return;
  }
  if (_initDone) {
    log.warn("initAll já executado neste processo — ignorando");
    return;
  }
  _initInProgress = true;

  const concurrency = ENV.WEB_CONCURRENCY || 1;
  if (concurrency > 1) {
    log.warn(
      { WEB_CONCURRENCY: concurrency },
      "Baileys: WEB_CONCURRENCY>1 causa 440 (sessão substituída). Defina WEB_CONCURRENCY=1.",
    );
  }

  const authIds = await listInstances();

  const cfgs = await prisma.config.findMany({
    where: { key: { startsWith: "baileys:instance:" } },
    select: { key: true },
  });
  const cfgIds = cfgs.map((c) => c.key.replace("baileys:instance:", ""));

  const ids = [...new Set([...authIds, ...cfgIds, "default"])];

  for (const id of ids) {
    try {
      await start(id);
    } catch (err) {
      log.error({ instanceId: id, err }, "[Baileys:initAll] erro ao iniciar instância");
    }
  }
  _initInProgress = false;
  _initDone = true;
  log.info({ instances: ids }, "Baileys initAll concluído");
}

// ── Envio ──────────────────────────────────────────────────────
// saveHistory=true: salva no chatMemory (usado por notificações/broadcast diretos)
// saveHistory=false: não salva (bot handler já chama chatMemory.push internamente)
async function sendText(to, text, instanceId = "default", skipNotifyCheck = false, saveHistory = true) {
  const inst = INSTANCES.get(instanceId);
  if (!inst || !inst.socket || inst.status !== "connected") return false;

  // notifyTo só se aplica a notificações internas — bot e respostas diretas são liberados
  if (!skipNotifyCheck && inst.notifyTo.length > 0 && !inst.notifyTo.includes(to)) {
    console.warn(`[Baileys:${instanceId}] Envio bloqueado para ${to} — não está na lista.`);
    return false;
  }

  if (!checkLimits(inst)) {
    log.warn({ instanceId, to, lastAlert: inst.lastAlert }, "Envio bloqueado: limite atingido");
    return false;
  }

  try {
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    await inst.socket.sendMessage(jid, { text });
    inst.counters.hour++;
    inst.counters.day++;

    // Salva no histórico apenas para envios diretos
    if (saveHistory) {
      try {
        const botHandler = require("../routes/bot.handler");
        const cleanPhone = to.split("@")[0];
        const tenantId = await detectTenantByPhone(cleanPhone);
        if (tenantId) {
          await botHandler.saveBaileysMessage(cleanPhone, text, tenantId, "assistant");
        }
      } catch (err) {
        console.error(`[Baileys:${instanceId}] Erro ao registrar msg no histórico:`, err.message);
      }
    }

    return true;
  } catch (err) {
    log.error({ instanceId, to, err }, "Erro ao enviar mensagem");
    return false;
  }
}

async function notify(text) {
  for (const inst of INSTANCES.values()) {
    if (inst.status === "connected" && inst.notifyTo.length) {
      await Promise.all(inst.notifyTo.map((n) => sendText(n, text, inst.id)));
    }
  }
}

async function getInstanceTenant(instanceId) {
  try {
    const cfg = await prisma.config.findUnique({
      where: { key: `baileys:instance:${instanceId}` },
    });
    if (cfg?.value) {
      const { tenantId } = JSON.parse(cfg.value);
      return tenantId || null;
    }
  } catch {}
  return null;
}

async function setInstanceTenant(instanceId, tenantId) {
  await prisma.config.upsert({
    where: { key: `baileys:instance:${instanceId}` },
    create: { key: `baileys:instance:${instanceId}`, value: JSON.stringify({ tenantId: tenantId || null }) },
    update: { value: JSON.stringify({ tenantId: tenantId || null }) },
  });
}

async function getStatus(instanceId = "default") {
  const inst = INSTANCES.get(instanceId);
  if (!inst) return { status: "disconnected" };
  resetCounters(inst);
  const instanceTenant = await getInstanceTenant(instanceId);
  return {
    id: inst.id,
    status: inst.status,
    qr: inst.qrBase64,
    lastAlert: inst.lastAlert,
    account: inst.account,
    botEnabled: inst.botEnabled !== false,
    instanceTenant: instanceTenant,
    usage: {
      hour: inst.counters.hour,
      hourMax: LIMITS.perHour,
      day: inst.counters.day,
      dayMax: LIMITS.perDay,
    },
  };
}

function setBotEnabled(instanceId = "default", enabled) {
  const inst = INSTANCES.get(instanceId);
  if (inst) inst.botEnabled = !!enabled;
}

async function getAllStatuses() {
  return Promise.all(Array.from(INSTANCES.keys()).map((id) => getStatus(id)));
}

function setNotifyNumbers(numbers, instanceId = "default") {
  let inst = INSTANCES.get(instanceId);
  if (!inst) {
    inst = createInstanceData(instanceId);
    INSTANCES.set(instanceId, inst);
  }
  inst.notifyTo = Array.isArray(numbers) ? numbers : [];
}

function disconnect(instanceId = "default") {
  const inst = INSTANCES.get(instanceId);
  if (!inst) return;
  inst.starting = false;
  inst._intentionalDisconnect = true;
  inst._replaced440Count = 0;
  inst._genericDisconnectCount = 0;
  if (inst.socket) {
    try {
      inst.socket.end();
    } catch (e) {}
  }
  clearDbAuth(instanceId).catch(() => {});
  inst.status = "disconnected";
  inst.socket = null;
  inst.qrBase64 = null;
  if (instanceId !== "default") INSTANCES.delete(instanceId);
}

async function getProfilePicture(phone) {
  for (const inst of INSTANCES.values()) {
    if (inst.socket && inst.status === "connected") {
      try {
        const jid = `${phone}@s.whatsapp.net`;
        const url = await inst.socket.profilePictureUrl(jid, "image");
        if (url) return url;
      } catch {}
    }
  }
  return null;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function broadcastSend(numbers, message, instanceId = "default", delayMs = 5000) {
  const normalized = numbers.map((n) => String(n || "").replace(/\D/g, "")).filter((n) => n.length >= 10);
  const unique = [...new Set(normalized)];
  const results = { sent: 0, failed: 0, errors: [] };

  for (const phone of unique) {
    try {
      const ok = await sendText(phone, message, instanceId, true);
      if (ok) results.sent++;
      else {
        results.failed++;
        results.errors.push({ phone, error: "Falha ao enviar" });
      }
    } catch (err) {
      results.failed++;
      results.errors.push({ phone, error: err.message || "Erro" });
    }
    if (delayMs > 0) await delay(delayMs);
  }

  return results;
}

module.exports = {
  start,
  initAll,
  sendText,
  notify,
  getStatus,
  getAllStatuses,
  setNotifyNumbers,
  setBotEnabled,
  setInstanceTenant,
  disconnect,
  getProfilePicture,
  getReplyChannel,
  setReplyChannel,
  broadcastSend,
};
