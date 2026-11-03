# Build only on an isolated builder. The deployment selects and verifies BASE_IMAGE separately.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
ENV DEBIAN_FRONTEND=noninteractive OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MALLOC_ARENA_MAX=1 SAL_USE_VCLPLUGIN=svp FONTCONFIG_FILE=/opt/dsh/fonts/fonts.conf
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils pandoc \
    texlive-xetex texlive-lang-chinese texlive-latex-extra texlive-fonts-recommended tex-gyre \
    fonts-noto-cjk fonts-liberation fonts-texgyre fontconfig ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN test -x /opt/dsh-native/node && mkdir -p /opt/dsh/runtime/dependencies/node/bin /opt/dsh/runtime/dependencies/node/node_modules \
    && ln -s /opt/dsh-native/node /opt/dsh/runtime/dependencies/node/bin/node \
    && python3 -m venv /opt/dsh/runtime/dependencies/python \
    && /opt/dsh/runtime/dependencies/python/bin/pip install --no-cache-dir \
      numpy==2.3.4 pandas==2.3.3 python-docx==1.2.0 python-pptx==1.0.2 \
      openpyxl==3.1.5 XlsxWriter==3.2.9 Pillow==12.0.0 lxml==6.0.2 \
      beautifulsoup4==4.14.2 json-repair==0.53.0 requests==2.32.5 pdfplumber==0.11.8 fonttools==4.60.1
COPY packages/cloud/pe-opensandbox/runtime/office/prepare-fonts.py /tmp/prepare-fonts.py
RUN /opt/dsh/runtime/dependencies/python/bin/python3 /tmp/prepare-fonts.py && rm /tmp/prepare-fonts.py
COPY packages/skill/skill-office/assets /opt/dsh/skills/office
COPY packages/skill/skill-office/assets/reports /opt/dsh/skills/reports
COPY packages/cloud/pe-opensandbox/runtime/office/runtime-manifest.py /tmp/runtime-manifest.py
RUN /opt/dsh/runtime/dependencies/python/bin/python3 /tmp/runtime-manifest.py \
    && rm /tmp/runtime-manifest.py && chmod -R a-w /opt/dsh/skills /opt/dsh/runtime /opt/dsh/fonts
