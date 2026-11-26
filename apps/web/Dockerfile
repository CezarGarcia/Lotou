# syntax=docker/dockerfile:1

# ---- build: gera os arquivos estáticos da aplicação ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY angular.json tsconfig.json tsconfig.app.json ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- runtime: nginx servindo os estáticos e fazendo proxy da API ----
FROM nginx:1.31-alpine

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist/web/browser /usr/share/nginx/html

ENV API_GATEWAY_URL=http://api-gateway:8080 \
    OTEL_COLLECTOR_URL=http://otel-collector:4318
EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD wget -qO- http://127.0.0.1/ > /dev/null || exit 1
