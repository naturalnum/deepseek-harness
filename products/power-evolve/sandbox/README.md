# Sandbox document toolchain

English | [中文](README.zh.md)

The Sandbox image retains the existing HTTP runner. Its trusted process starts as root so `runner.mjs` can launch user commands as UID/GID 1000. The deployed pod mounts `/workspace`, `/home/agent`, and `/tmp` as writable volumes, and mounts the image filesystem read-only. The toolchain and OfficeCLI stay in the image; package Skills are mounted separately by the platform.

## Pinned inputs

- Node 22.23.2 Bookworm slim base: `sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436`.
- Debian Bookworm and Bookworm security apt repositories: signed snapshots at `20260901T000000Z`. The first apt update uses HTTP because the slim base has no CA certificates; apt verifies signed Debian Release metadata and package hashes with the base's archive keyring.
- Python 3.11 in a private venv: every direct and transitive package version and distribution hash is recorded in `requirements-skills.lock`, generated from `requirements-skills.in`. The `/usr/local/bin/python3` wrapper reaches that venv even though the runner sets a restricted command `PATH`.
- OfficeCLI 1.0.151: the amd64 binary must match SHA256 `8e2512234ae1111e51ad3a9fadbdeca266adfa7f683773469aa45b83fe06dc7f`; arm64 must match `fccb7d7841c9ec93593a62181544c893ee184455421cf15bd76110bf0ad29c41`.

The image includes LibreOffice Writer, Calc, Impress, Python UNO, Pandoc, Poppler, XeLaTeX/CTeX, Noto CJK and Debian's WenQuanYi/TeX fonts. The report catalog updater uses UNO through `/usr/bin/python3`; document editing uses the private venv. The image does not install JDK, Maven, Chromium, or Windows fonts. Debian's dated snapshot fixes the apt package set, while the base image digest fixes the initial OS state. The local QA tag is mutable; record `docker image inspect pe-s8-skills-runner:qa --format '{{.Id}}'` for an exact local image ID. A deployable immutable registry digest exists only after the image is pushed.

The runner supplies a fixed child environment and does not forward image `ENV` values. A document command that requires `OFFICECLI_SKIP_UPDATE=1` must set it in that command.

## Build and smoke test

```sh
docker build --pull=false --progress=plain -t pe-s8-skills-runner:qa \
  -f products/power-evolve/sandbox/Dockerfile products/power-evolve/sandbox
docker run --rm --user 1000:1000 --read-only \
  --tmpfs /workspace:rw,uid=1000,gid=1000,mode=755 \
  --tmpfs /home/agent:rw,uid=1000,gid=1000,mode=750 \
  --tmpfs /tmp:rw,mode=1777 \
  -v "$PWD/products/power-evolve/sandbox/qa-skills-toolchain.sh:/qa-skills-toolchain.sh:ro" \
  --entrypoint /bin/bash pe-s8-skills-runner:qa /qa-skills-toolchain.sh
```

The script performs OfficeCLI file operations and validation; imports the pinned Python packages; creates, extracts, and renders Chinese PDF text; compiles a Chinese CTeX document; and creates/reads DOCX, PPTX, and XLSX files. For each Office format it exports a PDF in a separate directory, checks nonempty bytes and expected text, and renders a PNG with Poppler. LibreOffice can return zero without exporting a file, so exit status alone does not establish rendering success. The script also checks Pandoc, writable mounts, and the absence of the excluded executables. This smoke test covers the toolchain; complete built-in Skill workflows and the platform's document command bridge require separate acceptance.
