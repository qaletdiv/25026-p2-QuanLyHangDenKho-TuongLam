FROM node:22.15.1-alpine3.20

WORKDIR /app
ENV NODE_ENV=production

# bcrypt is native: toolchain only for the install, removed in the same layer.
COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && npm cache clean --force \
 && apk del .build-deps

COPY . .

# Writable runtime dirs (mounted as volumes in docker-compose.yml).
RUN mkdir -p storage/uploads storage/outbox storage/reference/nri-billing \
 && chown -R node:node storage

USER node
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:5000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
