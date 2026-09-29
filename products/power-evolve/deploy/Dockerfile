# Build only from a clean, committed source archive; see README.md.
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build
WORKDIR /opt/power-evolve
ENV CI=true
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build && pnpm run build:power-evolve

FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
WORKDIR /opt/power-evolve
ENV NODE_ENV=production
COPY --from=build /opt/power-evolve /opt/power-evolve
CMD ["node", "products/power-evolve/deploy/start.mjs"]
