// src/services/gemini.service.js
// Integração com Google Gemini para NLP do bot de atendimento

const { GoogleGenerativeAI } = require("@google/generative-ai");
const ENV = require("../config/env");

let _model = null;

function getModel() {
  if (_model) return _model;
  if (!ENV.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY não configurado");
  const client = new GoogleGenerativeAI(ENV.GEMINI_API_KEY);
  _model = client.getGenerativeModel({
    model: ENV.GEMINI_MODEL || "gemini-2.0-flash",
    generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
  });
  return _model;
}

/**
 * Classifica a intenção do cliente em um dos valores:
 * PEDIDO | STATUS | CARDAPIO | HANDOFF | OUTRO
 *
 * Retorna null se Gemini falhar (use como fallback).
 */
async function classifyIntent(text) {
  try {
    const model = getModel();
    const result = await model.generateContent(
      `Você é um assistente de delivery de comida.
Classifique a intenção do cliente em UMA das opções:
- PEDIDO: quer fazer um pedido, comprar comida, "quero pedir", "vou pedir"
- STATUS: quer saber status de pedido, onde está, previsão
- CARDAPIO: quer ver cardápio, menu, preços, o que tem
- HANDOFF: quer falar com humano, atendente, tem reclamação, problema com pedido
- OUTRO: saudação, pergunta geral sobre a loja, horário, endereço, etc.

Mensagem: "${text.slice(0, 200)}"
Responda APENAS com uma palavra: PEDIDO, STATUS, CARDAPIO, HANDOFF ou OUTRO`
    );
    const r = result.response.text().trim().toUpperCase().split(/\s/)[0];
    return ["PEDIDO", "STATUS", "CARDAPIO", "HANDOFF", "OUTRO"].includes(r) ? r : "OUTRO";
  } catch (err) {
    console.warn("[Gemini] classifyIntent falhou:", err.message);
    return null;
  }
}

/**
 * Extrai endereço estruturado de texto livre.
 * Retorna objeto { street, number, complement, neighborhood, city, state }
 * ou null se falhar.
 */
async function extractAddress(text, defaultCity = "Campinas") {
  try {
    const model = getModel();
    const result = await model.generateContent(
      `Extraia o endereço do texto e retorne JSON com exatamente estes campos:
{"street":"","number":"","complement":"","neighborhood":"","city":"","state":""}

Regras:
- city padrão (se não informado): "${defaultCity}"
- state padrão (se não informado): "SP"
- Retorne APENAS o JSON, sem markdown, sem texto adicional

Texto: "${text.slice(0, 300)}"`
    );
    const raw = result.response.text().trim().replace(/```[\w]*\n?|```/g, "").trim();
    const addr = JSON.parse(raw);
    // Valida campos mínimos
    if (!addr.street || !addr.number) return null;
    if (!addr.city) addr.city = defaultCity;
    if (!addr.state) addr.state = "SP";
    return addr;
  } catch (err) {
    console.warn("[Gemini] extractAddress falhou:", err.message);
    return null;
  }
}

/**
 * Responde perguntas gerais sobre a loja de forma simpática.
 * Retorna null se falhar.
 */
async function answerQuestion(text, merchantName = "Pappi") {
  try {
    const model = getModel();
    const result = await model.generateContent(
      `Você é o assistente virtual do restaurante "${merchantName}" no WhatsApp.
Responda de forma simpática e concisa (máximo 2 linhas) à mensagem do cliente.
Se não souber a resposta específica, ofereça ajuda para fazer um pedido ou falar com atendente.

Mensagem: "${text.slice(0, 200)}"`
    );
    return result.response.text().trim();
  } catch (err) {
    console.warn("[Gemini] answerQuestion falhou:", err.message);
    return null;
  }
}

module.exports = { classifyIntent, extractAddress, answerQuestion };
