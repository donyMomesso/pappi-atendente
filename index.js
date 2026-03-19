require("dotenv").config();
const http = require("http");
const app  = require("./src/app");
const socketService = require("./src/services/socket.service");

const PORT = process.env.PORT || 10000;

const server = http.createServer(app);
socketService.init(server);

server.listen(PORT, () => {
  console.log(`🔥 PappiAtendente v3 rodando na porta ${PORT}`);
});
