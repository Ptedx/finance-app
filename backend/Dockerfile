# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# O engine do Prisma é linkado contra o OpenSSL do sistema.
RUN apk add --no-cache openssl

# Dependências primeiro, para o cache do Docker sobreviver a mudanças no código.
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Não roda como root: um comprometimento da API não vira controle do container.
USER node

EXPOSE 3009

ENV NODE_ENV=production
ENV PORT=3009

# As migrations são aplicadas na subida, e não num passo manual de deploy: assim um
# container novo nunca fala com um banco de schema mais antigo que o seu código.
# `migrate deploy` só aplica o que já existe — nunca gera nem apaga nada.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
