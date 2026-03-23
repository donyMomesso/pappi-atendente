// PM2 — processos separados para produção
// Uso: pm2 start ecosystem.config.js

module.exports = {
  apps: [
    {
      name: "pappi-web",
      script: "src/bootstrap/http.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        RUN_JOBS: "false",
        RUN_BAILEYS: "false",
      },
    },
    {
      name: "pappi-jobs",
      script: "src/bootstrap/jobs.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        RUN_JOBS: "true",
        RUN_BAILEYS: "false",
      },
    },
    {
      name: "pappi-baileys",
      script: "src/bootstrap/baileys.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        RUN_JOBS: "false",
        RUN_BAILEYS: "true",
        WEB_CONCURRENCY: "1",
      },
    },
  ],
};
