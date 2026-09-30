FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# Bookworm packages come from a dated, Debian-signed snapshot. HTTP is needed
# for the first apt update because the slim base has no CA certificate store.
# The Release files and packages are still verified by Debian archive keys.
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
  && apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates curl fontconfig fonts-liberation \
    fonts-noto-cjk fonts-texgyre fonts-wqy-zenhei git \
    libreoffice-writer pandoc poppler-utils \
    python3 python3-venv \
    texlive-fonts-recommended texlive-lang-chinese texlive-latex-extra texlive-xetex \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

COPY requirements-skills.lock /opt/power-evolve/requirements-skills.lock
RUN python3 -m venv /opt/power-evolve/venv \
  && /opt/power-evolve/venv/bin/python3 -m pip install --no-cache-dir --require-hashes \
    -r /opt/power-evolve/requirements-skills.lock \
  && printf '#!/bin/sh\nexec /opt/power-evolve/venv/bin/python3 "$@"\n' > /usr/local/bin/python3 \
  && chmod 0555 /usr/local/bin/python3 \
  && ln -s python3 /usr/local/bin/python \
  && printf '#!/bin/sh\nexec /opt/power-evolve/venv/bin/python3 -m pip "$@"\n' > /usr/local/bin/pip3 \
  && chmod 0555 /usr/local/bin/pip3 \
  && ln -s pip3 /usr/local/bin/pip

ARG TARGETARCH
ARG OFFICECLI_VERSION=1.0.151
ARG OFFICECLI_SHA256_AMD64=8e2512234ae1111e51ad3a9fadbdeca266adfa7f683773469aa45b83fe06dc7f
ARG OFFICECLI_SHA256_ARM64=fccb7d7841c9ec93593a62181544c893ee184455421cf15bd76110bf0ad29c41
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) officecli_arch=x64; officecli_sha256="${OFFICECLI_SHA256_AMD64}" ;; \
      arm64) officecli_arch=arm64; officecli_sha256="${OFFICECLI_SHA256_ARM64}" ;; \
      *) echo 'unsupported OfficeCLI architecture' >&2; exit 1 ;; \
    esac \
  && curl --fail --location --silent --show-error \
    "https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}/officecli-linux-${officecli_arch}" \
    --output /usr/local/bin/officecli \
  && printf '%s  %s\n' "${officecli_sha256}" /usr/local/bin/officecli | sha256sum --check --strict \
  && chmod 0555 /usr/local/bin/officecli \
  && OFFICECLI_SKIP_UPDATE=1 officecli --version | grep --fixed-strings --line-regexp "${OFFICECLI_VERSION}"

# Kubernetes mounts workspace, home and /tmp before running commands as UID 1000.
# Keep the HTTP runner as root so its existing controlled uid/gid drop still works.
RUN groupmod --new-name agent node \
  && usermod --login agent --home /home/agent node \
  && install -d -o 1000 -g 1000 -m 0755 /workspace \
  && install -d -o 1000 -g 1000 -m 0750 /home/agent \
  && install -d -o 0 -g 0 -m 0755 /run/power-evolve \
  && python3 -c 'import bs4, docx, json_repair, lxml, pdfplumber, PIL, pypdf, reportlab, requests' \
  && command -v libreoffice \
  && command -v pandoc \
  && command -v pdftoppm \
  && command -v xelatex \
  && kpsewhich pzdr.tfm \
  && fc-match 'Noto Sans CJK SC' | grep --fixed-strings 'NotoSansCJK'

ENV HOME=/home/agent \
  OFFICECLI_SKIP_UPDATE=1 \
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1

COPY runner.mjs /opt/power-evolve/runner.mjs
WORKDIR /workspace
EXPOSE 8080
CMD ["node", "/opt/power-evolve/runner.mjs"]
