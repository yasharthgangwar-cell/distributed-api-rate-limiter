# syntax=docker/dockerfile:1

FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Expose port
EXPOSE 3000

# Health check (Docker will mark container unhealthy if this fails)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/admin/health || exit 1

# Run as non-root user for security
USER node

CMD ["node", "src/server.js"]
