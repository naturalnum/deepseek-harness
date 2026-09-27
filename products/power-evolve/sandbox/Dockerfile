FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY runner.mjs /opt/power-evolve/runner.mjs
WORKDIR /workspace
EXPOSE 8080
CMD ["node", "/opt/power-evolve/runner.mjs"]
