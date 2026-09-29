# Build only from a clean, committed source archive; see README.md.
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build
WORKDIR /opt/power-evolve
ENV CI=true
RUN corepack enable
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN apt-get update && apt-get install -y --no-install-recommends build-essential git python3 \
    && rm -rf /var/lib/apt/lists/*
ARG SOURCE_COMMIT
ENV DSH_CLIENT_COMMIT_HASH=${SOURCE_COMMIT}
RUN pnpm run build && pnpm run build:power-evolve

FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
WORKDIR /opt/power-evolve
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /opt/power-evolve /opt/power-evolve
CMD ["node", "products/power-evolve/deploy/start.mjs"]
