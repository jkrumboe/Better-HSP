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

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY --from=builder /app .

# Expose ports
EXPOSE 3000 5173

# Create a startup script
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'node fetch-locations.js' >> /app/start.sh && \
    echo 'node server.js &' >> /app/start.sh && \
    echo 'exec npx vite --host' >> /app/start.sh && \
    chmod +x /app/start.sh

CMD ["/app/start.sh"]
