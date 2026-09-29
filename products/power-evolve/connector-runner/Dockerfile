# Build context is the isolated output of `pnpm --filter @power-evolve/connector-runner deploy --prod`.
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV NODE_ENV=production
WORKDIR /opt/power-evolve/connector-runner
COPY --chown=10001:10001 . .
USER 10001:10001
EXPOSE 8080
CMD ["node", "lib/main.js"]
