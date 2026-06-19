FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Copy source
COPY backend/ ./backend/
COPY frontend/ ./frontend/

# Create persistent data + uploads directories
RUN mkdir -p /app/data /app/uploads

WORKDIR /app/backend

ENV PORT=3001
ENV DB_PATH=/app/data/taskflow.json
ENV UPLOADS_DIR=/app/uploads
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "server.js"]
