# syntax=docker/dockerfile:1

# ---- build: instala tudo, compila e descarta as dependências de dev ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: só o compilado e as dependências de produção ----
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/health/ready > /dev/null || exit 1

# O --import carrega o OpenTelemetry antes da aplicação.
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
