# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Production stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY --from=builder /app .

# Single-origin: der Express-Server liefert Frontend, API und WebSocket aus.
EXPOSE 3000

# Startup: Standorte aktualisieren (nicht fatal), dann Server starten
RUN printf '%s\n' '#!/bin/sh' 'node fetch-locations.js || echo "fetch-locations übersprungen"' 'exec node server.js' > /app/start.sh \
    && chmod +x /app/start.sh

CMD ["/app/start.sh"]
