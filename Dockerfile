# Stage 1: Build React Frontend
FROM node:20-bookworm-slim AS client-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Production Server
FROM node:20-bookworm-slim

WORKDIR /app
COPY backend/package*.json ./backend/
RUN npm ci --prefix backend --omit=dev

COPY backend/ ./backend/
COPY --from=client-builder /app/frontend/dist ./frontend/dist

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=3001
ENV CLIENT_DIST_PATH=/app/frontend/dist

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=8s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
