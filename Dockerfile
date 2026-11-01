FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime

ARG YTDLP_VERSION=2026.08.19

RUN apk add --no-cache ffmpeg python3 py3-pip \
    && pip install --no-cache-dir --break-system-packages "yt-dlp[default]==${YTDLP_VERSION}" \
    && apk del py3-pip

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p /tmp/playlist2mp3 /config /music && chown -R node:node /tmp/playlist2mp3 /app

USER node

ENTRYPOINT ["node", "dist/index.js"]
