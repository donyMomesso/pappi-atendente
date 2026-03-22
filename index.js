require("dotenv").config();

// Valida variáveis obrigatórias ANTES de qualquer import que precise delas
const { validateEnv } = require("./src/lib/validate-env");
validateEnv();

const http = require("http");
const app = require("./src/app");
const socketService = require("./src/services/socket.service");

const PORT = process.env.PORT || 10000;

const server = http.createServer(app);
socketService.init(server);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Porta ${PORT} em uso. Feche o outro processo ou altere PORT no .env`);
    console.error(`   Windows: netstat -ano | findstr :${PORT}\n`);
  } else {
    console.error("Erro no servidor:", err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`🔥 PappiAtendente v3 rodando na porta ${PORT}`);
});
