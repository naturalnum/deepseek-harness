# Root supplies a local base reference whose inspected image Id equals the pinned parentImageId.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=0:0 completion_view.py /usr/local/lib/python3.12/site-packages/opensandbox_server/services/docker/completion_view.py
