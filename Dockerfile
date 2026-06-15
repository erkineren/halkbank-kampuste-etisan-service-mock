FROM node:20-alpine AS base
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js openapi.yaml ./
COPY lib ./lib
COPY data ./data

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV STATEFUL=true

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
