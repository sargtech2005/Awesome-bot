# Dockerfile — OmegaTech Claude Bot
# Optimized for Fly.io (Node 20 LTS)

FROM node:20-alpine AS base

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++ dumb-init

WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
RUN npx prisma generate

# ── Production image ──────────────────────────────────────────
FROM base AS runner

ENV NODE_ENV=production
ENV TEMP_DIR=/app/temp

# Create non-root user
RUN addgroup -g 1001 -S nodejs && adduser -S botuser -u 1001

WORKDIR /app

# Copy node_modules and generated prisma client
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma

# Copy source
COPY src ./src

# Create writable directories
RUN mkdir -p /app/temp /app/logs && chown -R botuser:nodejs /app

USER botuser

EXPOSE 8080

# dumb-init handles SIGTERM properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
