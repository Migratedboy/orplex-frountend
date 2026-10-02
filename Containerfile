# Containerfile — Podman/OCI container for Orplex Code
# Build: podman build -t orplex-tech .
# Run:   podman run -p 5000:5000 --env-file .env orplex-tech

# === Build stage ===
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source and build
COPY . .
RUN npm run build

# === Production stage ===
FROM node:20-alpine AS production

# Security: run as non-root
RUN addgroup -g 1001 -S orplex && \
    adduser -S orplex -u 1001 -G orplex

WORKDIR /app

# Copy built artifacts and production dependencies
COPY --from=builder --chown=orplex:orplex /app/.next/standalone ./
COPY --from=builder --chown=orplex:orplex /app/.next/static ./.next/static
COPY --from=builder --chown=orplex:orplex /app/public ./public
COPY --from=builder --chown=orplex:orplex /app/prisma ./prisma

# Copy start script
COPY --from=builder --chown=orplex:orplex /app/package.json ./

USER orplex

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/api/health || exit 1

CMD ["node", "server.js"]
