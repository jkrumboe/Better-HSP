# HSP-Bot Docker Setup

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Build and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down
```

### Using Docker directly

```bash
# Build the image
docker build -t hsp-bot .

# Run the container
docker run -d \
  --name hsp-bot \
  -p 3000:3000 \
  -p 5173:5173 \
  -v ${PWD}/data:/app/data \
  hsp-bot
```

## Access the Application

- **Frontend (Vite)**: http://localhost:5173
- **Backend API**: http://localhost:3000

## Container Management

```bash
# Rebuild after code changes
docker-compose up -d --build

# View running containers
docker ps

# Access container shell
docker exec -it hsp-bot sh

# View application logs
docker logs hsp-bot -f

# Restart container
docker-compose restart
```

## Ports

- `3000`: Express backend server
- `5173`: Vite development server with hot reload

## Volumes

The following directory is mounted as a volume to persist data:
- `data/`: Contains `auth-data.json` and `token-store.json`

## Environment Variables

You can customize environment variables in `docker-compose.yml`:

```yaml
environment:
  - NODE_ENV=production
  - PORT=3000
```

## Production Deployment

For production, consider:
1. Building the Vite app (`npm run build`)
2. Serving static files through the Express server
3. Using a reverse proxy (nginx) in front of the container
4. Removing the Vite dev server from the Dockerfile

## Troubleshooting

**Container won't start:**
```bash
docker-compose logs hsp-bot
```

**Port already in use:**
Change ports in `docker-compose.yml`:
```yaml
ports:
  - "8080:3000"  # Backend
  - "8081:5173"  # Frontend
```

**Cannot connect to backend:**
Make sure both containers are on the same network and the proxy settings in `vite.config.js` are correct.
