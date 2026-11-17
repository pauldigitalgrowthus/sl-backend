# ==============================================================================
# Multi-Stage Dockerfile for sl-backend
# Supports: UAT and Production environments
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Dependency Installation
# ------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS deps

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./

RUN npm ci --omit=dev

# ------------------------------------------------------------------------------
# Stage 2: Runtime Image
# ------------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runner

WORKDIR /app

ARG APP_ENV=production
ENV NODE_ENV=${APP_ENV}
ENV PORT=5000

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source code
COPY . .

# Expose backend application port
EXPOSE 5000

# Use secure unprivileged node user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 5000) + '/', (r) => { process.exit(r.statusCode < 500 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "server.js"]
