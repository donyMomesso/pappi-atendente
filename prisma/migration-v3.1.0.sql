-- =============================================================
-- Migration v3.1.0 — Pappi Atendente
-- Aplicar no Supabase SQL Editor ou via psql
-- =============================================================

-- Adiciona campos de mídia e rastreamento ao model Message
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_url    TEXT,
  ADD COLUMN IF NOT EXISTS media_type   TEXT DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS wa_message_id TEXT,
  ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'sent';

-- Índice para busca por wa_message_id (check azul)
CREATE INDEX IF NOT EXISTS idx_messages_wa_message_id
  ON public.messages (wa_message_id)
  WHERE wa_message_id IS NOT NULL;

-- Confirmação
SELECT 'Migration v3.1.0 aplicada com sucesso!' AS resultado;
