# Extend the deployment's approved OpenSandbox base without replacing its entrypoint.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
ARG RUNTIME_USER=1000:1000
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv git poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv --system-site-packages /opt/epri-python \
    && /opt/epri-python/bin/python3 -m pip install --no-cache-dir airalogy==0.16.0
USER ${RUNTIME_USER}
