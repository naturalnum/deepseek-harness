FROM postgres:16-bookworm@sha256:0ea6700a3b4f0ae6ce746519073558aed4d88a79d8d07622a9a644946c7319c4 AS postgres-tools
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS system
RUN printf '%s\n' \
    'Types: deb' \
    'URIs: http://snapshot.debian.org/archive/debian/20260901T000000Z' \
    'Suites: bookworm bookworm-updates' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    'Check-Valid-Until: no' \
    '' \
    'Types: deb' \
    'URIs: http://snapshot.debian.org/archive/debian-security/20260901T000000Z' \
    'Suites: bookworm-security' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    'Check-Valid-Until: no' \
    > /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 libpq5 \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

FROM system AS build
ENV CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_nodedir=/usr/local
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential git \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
  && npm install --global pnpm@11.7.0
WORKDIR /build
COPY source/ /build/
RUN pnpm install --frozen-lockfile --store-dir /build/.linux-pnpm-store --network-concurrency=4 --fetch-retries=5 --fetch-timeout=120000
COPY native-coverage/ /build/.pe-native-coverage/
RUN if [ -f /build/.pe-native-coverage/build/inputs.json ]; then \
    env PE_CLOUD_COVERAGE_INPUT=/build/.pe-native-coverage/build/inputs.json \
    NODE_V8_COVERAGE=/build/.pe-native-coverage/build/raw \
    NODE_OPTIONS=--import=file:///build/products/power-evolve/scripts/cloud-capture.mjs \
    node products/power-evolve/deploy/cloud-image-build.mjs; \
  else node products/power-evolve/deploy/cloud-image-build.mjs; fi
RUN if [ -f /build/.pe-native-coverage/pack/inputs.json ]; then \
    env PE_CLOUD_COVERAGE_INPUT=/build/.pe-native-coverage/pack/inputs.json \
    NODE_V8_COVERAGE=/build/.pe-native-coverage/pack/raw \
    NODE_OPTIONS=--import=file:///build/products/power-evolve/scripts/cloud-capture.mjs \
    node products/power-evolve/deploy/cloud-image-pack.mjs; \
  else node products/power-evolve/deploy/cloud-image-pack.mjs; fi

FROM scratch AS native-coverage-evidence
COPY --from=build /build/.pe-native-coverage/ /

FROM system AS runtime
COPY --from=postgres-tools /usr/lib/postgresql/16/bin/psql /usr/lib/postgresql/16/bin/pg_dump /usr/lib/postgresql/16/bin/pg_restore /usr/local/bin/
COPY --from=build /runtime/ /opt/power-evolve/
RUN install -d -o 1000 -g 1000 -m 0700 /var/lib/power-evolve /run/power-evolve
WORKDIR /opt/power-evolve
USER 1000:1000
ENTRYPOINT ["node", "products/power-evolve/deploy/start.mjs"]
