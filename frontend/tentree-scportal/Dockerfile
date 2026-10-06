# ========= BUILD STAGE =========
FROM node:22.15.1-alpine3.20 AS builder

WORKDIR /app

# Install deps first so this layer caches across source edits
COPY package*.json ./
RUN npm ci

COPY . .

# Server-side only (the browser never calls the backend directly; every fetch goes
# through the Next server), but Next inlines NEXT_PUBLIC_* at build time.
ARG NEXT_PUBLIC_API_URL=http://backend:5000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build


# ========= RUN STAGE =========
FROM node:22.15.1-alpine3.20 AS runner

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# `output: 'standalone'` (next.config.ts) emits a self-contained server with the
# compiled config (redirects included) and only the node_modules it traces.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 3000

CMD ["node", "server.js"]
