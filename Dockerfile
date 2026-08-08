# syntax=docker/dockerfile:1

# ==================================================
# BUILD STAGE
# ==================================================
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ==================================================
# RUNTIME STAGE
# ==================================================
FROM node:22-alpine AS runtime

# Only production dependencies in the final image.
ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY src/db/migrations ./src/db/migrations

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/liveness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default to the API process; docker-compose.yml overrides `command`
# for the worker service to run dist/worker.js instead.
CMD ["node", "dist/server.js"]
