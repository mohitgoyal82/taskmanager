FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Copy source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create data directory for SQLite
RUN mkdir -p /app/data

WORKDIR /app/backend

ENV PORT=3001
ENV DB_PATH=/app/data/taskflow.db
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "server.js"]
