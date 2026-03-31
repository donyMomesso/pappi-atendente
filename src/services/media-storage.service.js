const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
let _createClient = null;

const ROOT_DIR = path.join(__dirname, '../../public/uploads/inbound');
const SUPABASE_BUCKET = String(process.env.SUPABASE_STORAGE_BUCKET || 'pappi-media').trim();
const SUPABASE_PUBLIC_BASE = process.env.SUPABASE_URL
  ? `${String(process.env.SUPABASE_URL).replace(/\/$/, '')}/storage/v1/object/public/${SUPABASE_BUCKET}`
  : '';
let _supabase = null;

function safeSegment(v, fallback = 'misc') {
  const s = String(v || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  return s || fallback;
}

function inferExt(mimeType = '', filename = '') {
  const byName = path.extname(String(filename || '')).toLowerCase();
  if (byName) return byName;
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('jpeg')) return '.jpg';
  if (mime.includes('jpg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('aac')) return '.aac';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('plain')) return '.txt';
  return '.bin';
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function getSupabaseAdmin() {
  if (_supabase) return _supabase;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  if (!_createClient) {
    try {
      ({ createClient: _createClient } = require('@supabase/supabase-js'));
    } catch (err) {
      console.warn('[media-storage] @supabase/supabase-js não instalado, usando disco local');
      return null;
    }
  }
  _supabase = _createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

async function uploadToSupabase({ buffer, tenantId = 'default', channel = 'generic', mediaType = 'file', mimeType = '', filename = '', id = '' }) {
  const client = getSupabaseAdmin();
  if (!client) return null;
  const day = new Date().toISOString().slice(0, 10);
  const ext = inferExt(mimeType, filename);
  const base = safeSegment(filename ? path.basename(filename, path.extname(filename)) : `${mediaType}_${id || crypto.randomUUID()}`);
  const finalName = `${Date.now()}_${base}_${crypto.randomUUID().slice(0, 8)}${ext}`;
  const objectPath = `${safeSegment(tenantId)}/${safeSegment(channel)}/${day}/${finalName}`;

  const { error } = await client.storage.from(SUPABASE_BUCKET).upload(objectPath, buffer, {
    contentType: mimeType || undefined,
    upsert: false,
  });
  if (error) throw error;

  return `${SUPABASE_PUBLIC_BASE}/${objectPath}`;
}

async function saveBuffer({ buffer, tenantId = 'default', channel = 'generic', mediaType = 'file', mimeType = '', filename = '', id = '' }) {
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) return null;

  try {
    const supabaseUrl = await uploadToSupabase({ buffer, tenantId, channel, mediaType, mimeType, filename, id });
    if (supabaseUrl) return supabaseUrl;
  } catch (err) {
    console.warn('[media-storage] supabase upload falhou, usando disco local:', err?.message || err);
  }

  const day = new Date().toISOString().slice(0, 10);
  const subdir = path.join(ROOT_DIR, safeSegment(tenantId), safeSegment(channel), day);
  await ensureDir(subdir);
  const ext = inferExt(mimeType, filename);
  const base = safeSegment(filename ? path.basename(filename, path.extname(filename)) : `${mediaType}_${id || crypto.randomUUID()}`);
  const finalName = `${Date.now()}_${base}_${crypto.randomUUID().slice(0, 8)}${ext}`;
  const fullPath = path.join(subdir, finalName);
  await fsp.writeFile(fullPath, buffer);
  return `/uploads/inbound/${safeSegment(tenantId)}/${safeSegment(channel)}/${day}/${finalName}`;
}

async function fetchBuffer(url, headers = {}) {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`media_fetch_${resp.status}`);
  const arr = await resp.arrayBuffer();
  return Buffer.from(arr);
}

async function saveCloudMedia({ mediaUrl, token, tenantId, mediaType, mimeType = '', filename = '', mediaId = '' }) {
  if (!mediaUrl || !token) return null;
  const buffer = await fetchBuffer(mediaUrl, { Authorization: `Bearer ${token}` });
  return saveBuffer({
    buffer,
    tenantId,
    channel: 'cloud',
    mediaType,
    mimeType,
    filename,
    id: mediaId,
  });
}

module.exports = {
  saveBuffer,
  saveCloudMedia,
  inferExt,
  ROOT_DIR,
  SUPABASE_BUCKET,
};
