// src/lib/validate-env.js
// Valida variáveis de ambiente obrigatórias ao iniciar o servidor.
// Se alguma estiver faltando, o processo encerra com exit code 1
// antes de tentar conectar ao banco ou às APIs.

const REQUIRED = [
  { key: "DATABASE_URL", desc: "URL de conexão com o banco Supabase/Postgres" },
  { key: "ATTENDANT_API_KEY", desc: "Chave de autenticação do painel de atendimento" },
  { key: "ADMIN_API_KEY", desc: "Chave de autenticação das rotas de admin" },
  { key: "WEBHOOK_VERIFY_TOKEN", desc: "Token de verificação do webhook Meta" },
];

const RECOMMENDED = [
  { key: "GEMINI_API_KEY", desc: "API Key do Gemini (IA) — bot fica limitado sem ela" },
  { key: "GEMINI_MODEL", desc: "Modelo Gemini a usar (ex: gemini-2.0-flash)" },
  { key: "GOOGLE_MAPS_API_KEY", desc: "Google Maps — necessário para cálculo de taxa de entrega" },
];

function validateEnv() {
  const missing = REQUIRED.filter((v) => !process.env[v.key]);

  if (missing.length > 0) {
    console.error("\n❌ VARIÁVEIS DE AMBIENTE OBRIGATÓRIAS FALTANDO:\n");
    for (const v of missing) {
      console.error(`   ${v.key}\n   → ${v.desc}\n`);
    }
    console.error("Configure essas variáveis no Render ou no arquivo .env e reinicie.\n");
    process.exit(1);
  }

  const absent = RECOMMENDED.filter((v) => !process.env[v.key]);
  if (absent.length > 0) {
    console.warn("\n⚠️  Variáveis recomendadas não configuradas (funcionalidades limitadas):");
    for (const v of absent) {
      console.warn(`   ${v.key} — ${v.desc}`);
    }
    console.warn("");
  }

  console.log("✅ Variáveis de ambiente OK");
}

module.exports = { validateEnv };
