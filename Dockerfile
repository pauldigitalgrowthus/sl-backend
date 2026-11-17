# ==============================================================================
# Multi-Stage Dockerfile with Google Distroless for sl-backend
# Supports: UAT and Production environments
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Dependency Installation & Build Preparation
# ------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies if native addons require compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package descriptors
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts && npm rebuild

# ------------------------------------------------------------------------------
# Stage 2: Distroless Production/UAT Runtime Image
# Minimal attack surface: No shell, no package manager, non-root user
# ------------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runner

WORKDIR /app

# Environment variables
ARG APP_ENV=production
ENV NODE_ENV=${APP_ENV}
ENV PORT=5000

# Copy node_modules from builder
COPY --from=builder --chown=nonroot:nonroot /app/node_modules ./node_modules

# Copy application source code (excluded items filtered via .dockerignore)
COPY --chown=nonroot:nonroot . .

# Expose backend application port
EXPOSE 5000

# Run container as secure non-root user (UID 65532)
USER nonroot

# Google Distroless nodejs image has node as entrypoint
CMD ["server.js"]
