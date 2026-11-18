---
kind: upgrade-guide
description: "Move Cloud report asset configuration to its product-owned package before upgrading the product bundle."
---

# Use the product-owned report assets

English | [中文](guide.zh.md)

## Change

The complete report resources previously owned by `skill-office` now live at `packages/cloud/pe-opensandbox/assets/reports`. Their scripts, templates, images, notices and generated package carriers retain their original bytes. Deployments that copy report resources from the source tree must select the new root. Native filesystem discovery, skill versions, package downloads and execution remain the consumers.

The Cloud login layout and styles now ship through the static `pe-cloud-web` package. Cloud brand artwork is private to `pe-cloud-client`; repository consumers no longer import `LightningMark` from native UI primitives.

The exact ARM64 candidate image tuple and asset hashes are in the [content image record](../../../../deploy/upstream/report-content-arm64-image.json). Existing qualified tuples remain available; the new tuple accepts only its recorded workload/server pair. The existing two-line runtime heading-number adaptation remains separately recorded, with the original archives unchanged.

The Root TypeScript world arguments and frozen Python launcher now both include `MALLOC_ARENA_MAX=1`, and the complete guardian byte budget includes it as well. Ship these fixes and their regression vectors together. The original 4 KiB command bound, 4 GiB storage preallocation and 3 GiB parent reserve remain unchanged.

## Migration

1. Build and verify the normal product bundle using the existing deployment process. Prepare the new report tree outside tenant writable storage, preserving every file and its permissions. Keep its original source and license notices.
2. Set `DSH_BUNDLED_REPORT_SKILLS` to that new versioned Host tree when using the [Cloud overlay](../../../../apps/cli/config/examples/cloud-builtin-skills.cordis.yml). Existing explicit `bundledSkillDir` values must select the same release. Keep the guest `bundledExecutionRoot` at `/opt/dsh/skills/reports`; the [current Docker recipe](../../../../packages/cloud/pe-opensandbox/runtime/office/Dockerfile) reads the new source root. Follow the normal Root sealing, drain and deployment lifecycle.
3. Run `python3 deploy/upstream/package-builtin-skills.py --check` and `node deploy/upstream/content-check.mjs` in the checkout. Confirm discovery, complete archive downloads, installation and update, then generate and open a report through the product in the isolated candidate. Verify the relevant exports and existing-session continuation before switching a shared deployment.
4. Keep the previous deployment until candidate acceptance is complete. Do not rewrite persisted Session logs or replace storage ownership records to move these source assets.

The normal product bundle identified in the [content image record](../../../../deploy/upstream/report-content-arm64-image.json) passed acceptance in an isolated ARM64 Cloud candidate: two independent browser accounts, six complete archive downloads, skill installation and update, key editing and removal, plugin state isolation, refresh and sign-out/sign-in, and native Linux tools generating DOCX/PDF for authenticated download. Both PDF pages were rendered and inspected. Tests used a deterministic tool driver and fixture keys, with no external model API call; existing deployments and storage ownership records were not rewritten.
