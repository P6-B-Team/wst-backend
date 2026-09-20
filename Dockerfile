FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# migrations are plain .sql and are not emitted by tsc, so they are copied explicitly
COPY src/db/migrations ./dist/db/migrations
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1:4000/health/ready || exit 1
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/db/seed.js && node dist/db/seed-scenarios.js && node dist/server.js"]
