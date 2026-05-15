# syntax=docker/dockerfile:1.7

FROM node:24-trixie-slim AS deps

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates make g++ python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=npm,target=/root/.npm npm ci --omit=dev

FROM node:24-trixie-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src

RUN mkdir -p /app/data \
    && chown -R node:node /app

USER node

EXPOSE 64738/tcp
EXPOSE 64738/udp

CMD ["node", "src/app.js"]
