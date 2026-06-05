# ---- build frontend ----
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build   # outputs to /app/backend/public

# ---- build backend ----
FROM node:20-slim AS backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
COPY --from=frontend /app/backend/public ./public
RUN npm run build

# ---- runtime ----
FROM node:20-slim
WORKDIR /app/backend
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY --from=backend /app/backend/dist ./dist
COPY --from=backend /app/backend/public ./public
EXPOSE 3000
CMD ["node", "dist/index.js"]
