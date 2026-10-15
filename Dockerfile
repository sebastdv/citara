# Una sola imagen para la API, el worker y la CLI: comparten el código y solo
# cambia el comando con que arrancan (ver deploy/compose.yml).
#
# La base va fijada por digest: el mismo commit construye la misma imagen. Para
# actualizar Node, cambia el digest a propósito (el de node:22-bookworm-slim).

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS base
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

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
COPY --from=prod-deps /app /app
# Se ejecuta lo compilado, migraciones incluidas; el fuente no entra.
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
# /app es de root y de solo lectura para el proceso: node no puede reescribir su propio código.
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/src/main.js"]
