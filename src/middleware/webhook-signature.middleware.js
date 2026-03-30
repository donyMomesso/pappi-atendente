const crypto = require('crypto');
const ENV = require('../config/env');

function getSignatureHeader(req) {
  return req.headers['x-hub-signature-256'] || req.headers['X-Hub-Signature-256'];
}

function timingSafeEqualHex(expected, received) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(received));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireValidMetaSignature(req, res, next) {
  // Mantém compatibilidade em ambientes sem segredo configurado,
  // mas deixa um log explícito para endurecer em produção.
  if (!ENV.META_APP_SECRET) return next();

  const signature = getSignatureHeader(req);
  if (!signature || typeof signature !== 'string' || !signature.startsWith('sha256=')) {
    return res.status(401).json({ error: 'invalid_signature', message: 'Assinatura Meta ausente.' });
  }

  const rawBody = req.rawBody;
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ error: 'raw_body_missing', message: 'Corpo bruto indisponível para validar o webhook.' });
  }

  const expected = `sha256=${crypto.createHmac('sha256', ENV.META_APP_SECRET).update(rawBody).digest('hex')}`;
  if (!timingSafeEqualHex(expected, signature)) {
    return res.status(401).json({ error: 'invalid_signature', message: 'Assinatura Meta inválida.' });
  }

  return next();
}

module.exports = { requireValidMetaSignature };
