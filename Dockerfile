# syntax=docker/dockerfile:1.7
# Una sola imagen para la API, el worker y la CLI: comparten el código y solo
# cambia el comando con que arrancan (ver deploy/compose.yml).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
# Primero solo los manifiestos: si no cambian las dependencias, la capa de
# install queda en caché aunque cambie el código.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY apps apps
COPY packages packages
RUN pnpm build

# Solo las dependencias de producción, instaladas desde cero: un `install
# --prod` encima del de desarrollo deja tsc, vitest y swc en el store.
FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app /app
# Se ejecuta lo compilado, migraciones incluidas; el fuente no entra.
COPY --from=build --chown=node:node /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /app/packages/db/dist packages/db/dist
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/apps/worker/dist apps/worker/dist
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/src/main.js"]
