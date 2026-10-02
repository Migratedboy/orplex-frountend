# Orplex BACKEND — API-only Next.js app (physical split).
#
# This app owns EVERY route handler, next-auth, Prisma and all processing.
# The frontend (repo root) is a separate UI-only app: zero API routes, it
# renders only and calls this backend cross-origin via NEXT_PUBLIC_API_BASE_URL.
#
# Build:  cd backend && docker build -t orplex-backend .
# Run:    docker run --env-file .env -p 8080:8080 orplex-backend
# Health: GET /api/health

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# prisma generate runs via postinstall; schema is already in place.
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/package-lock.json ./package-lock.json
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time marker for the UI-facing surface: this image serves ONLY /api/*.
# Human page hits get the JSON api-only identity from src/proxy.ts.
ENV BACKEND_ONLY=1
RUN npx prisma generate && npx next build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
RUN addgroup -S orplex && adduser -S orplex -G orplex
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/next.config.js ./next.config.js
USER orplex
EXPOSE 8080
# Fresh deploys get the schema (additive migrations only — never a reset).
CMD ["sh", "-c", "npx prisma migrate deploy && npx next start -p ${PORT}"]
