# Pappi Atendente — Produção privada
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npx prisma generate

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "index.js"]
