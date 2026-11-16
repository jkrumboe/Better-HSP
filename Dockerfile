FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
# 3003 kollidiert mit keinem anderen Container auf dem Server
ENV PORT=3003

# Abhängigkeiten zuerst (Layer-Cache: wird nur bei Änderung der package*.json neu gebaut)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Anwendungscode (data/, .env, .git usw. werden per .dockerignore ausgeschlossen)
COPY --chown=node:node . .

# Persistente Daten (Accounts, verschlüsselte Tokens, Secrets, Jobs) liegen im Volume.
# Ordner gehört "node", damit ein neues Volume mit den richtigen Rechten angelegt wird.
RUN mkdir -p /app/data && chown node:node /app /app/data
VOLUME ["/app/data"]

# Nicht als root laufen
USER node

# Single-origin: der Express-Server liefert Frontend, API und WebSocket aus.
EXPOSE 3003 3004

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3003}/" || exit 1

# Startup: Standorte aktualisieren (nicht fatal), dann Server starten
CMD ["sh", "-c", "node fetch-locations.js || echo 'fetch-locations übersprungen'; exec node server.js"]
