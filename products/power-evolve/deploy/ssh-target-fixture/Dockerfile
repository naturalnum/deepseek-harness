# Build only this directory; runtime credentials never enter the build context.
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod 755 /usr/sbin/policy-rc.d \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server passwd \
    && rm -f /etc/ssh/ssh_host_* /usr/sbin/policy-rc.d \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 11001 qa-alice \
    && groupadd --gid 11002 qa-bob \
    && useradd --uid 11001 --gid 11001 --no-create-home --home-dir /home/qa-alice --shell /bin/sh qa-alice \
    && useradd --uid 11002 --gid 11002 --no-create-home --home-dir /home/qa-bob --shell /bin/sh qa-bob

WORKDIR /opt/power-evolve/ssh-target-fixture
COPY configure.mjs entrypoint.sh sshd_config ./
RUN chmod 755 entrypoint.sh && chmod 644 configure.mjs sshd_config

EXPOSE 2222
ENTRYPOINT ["/opt/power-evolve/ssh-target-fixture/entrypoint.sh"]
