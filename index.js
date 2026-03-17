require("dotenv").config();
const app = require("./src/app");

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🔥 PappiAtendente v3 rodando na porta ${PORT}`);
});
