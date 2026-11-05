---
description: "Run the EPRI research workbench in an existing cloud account."
kind: "package-reference"
---
# @deepseek-ai/dsh-experimental-epri-research

English | [中文](README.zh.md)

## Summary

Attach the research workbench to the cloud platform's existing accounts, Sessions and execution providers. Research data belongs to the original account, and human decisions retain native authentication and review. The integration is optional and does not change the default Web composition.

## Table of Contents

- [Use this package](#use-this-package)
- [Account ownership](#account-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

This optional package connects the independently built [research suite](../../../integrations/epri-research/cloud/README.md) to the cloud platform. Install the main entry and `/workbench` in the account Loader, `/tools` and `/skills` in its existing approved Preset, and `/web` only in the shared Web root. The `/client` entry mounts generated Remote descriptors. Launch through the platform's existing `dsh` profile.

The main entry requires `peCloudApi` and the original Session Controller. Its explicit configuration selects the backend `file:` URL, the absolute sandbox Python executable, maximum JSON/output bytes, and subprocess cleanup milliseconds. `/web` requires the absolute built `dist/ui` directory, a browser request timeout, and a pending-request limit. The contribution entries have empty configuration.

Use [the preparation script](scripts/prepare.ts) on resolved deployment JSON to create review copies of the Root/account configurations. It preserves the original Preset identifier, pins the updated declaration with the platform's digest function, and adds only `epriResearch/execute` with the `account-session` guard. Existing capacities remain unchanged; insufficient capacities or a closed managed-skill provider reject preparation. The script does not start, seal or publish a deployment.

## Account ownership

Each account owns a SQLite store under its original profile home at `storage/epri-research`. Every operation resolves the Session through the existing Controller and project guards. Model calls retain the native Agent and agent role. Browser calls require the original authenticated owner Peer; human review from a model tool additionally requires the native question continuation and an unchanged reviewed revision. Neither JSON arguments nor an iframe can select an actor or account.

Computation, Git and document extraction use the Session's existing subprocess/filesystem providers. Missing providers fail closed. Bundled skill resources are materialized through the cloud files owner's managed-skill projection; catalog metadata contains no Host resource paths. Account revocation blocks late writes, and disposal cancels and joins retained work before closing the database.

The shared Web entry serves fixed public assets. Its iframe communicates only with the mounted same-origin parent frame and current Session. Business data travels through the account Remote; `/research/api` is not a data endpoint. Frame disposal cancels its pending requests.

## Model Experience

### Approved research Preset

#### What the model sees

The approved Preset gains the research suite's existing `research_*` tools and engineering skill catalog. The [backend contributions](../../../integrations/epri-research/plugins/airalogy/index.mjs) own their descriptions and results. Tool results remain native Session events. Skills load on demand; no research instruction body is appended automatically.

#### Token effect

Tool schemas, tool results and selected skills add their normal prompt tokens. This package introduces no model call or independent conversation log.

#### KV Cache effect

The tool/skill selection changes the corresponding cached prompt prefix. Result events append to the native Session; account authentication alone adds no model tokens.

## Known Limitations and Deferred Work

- This integration requires the deployment's real cloud authentication, managed-skill resource provider, physically capped private storage, and approved OpenSandbox execution image. A local Loader or Docker test does not establish their production availability. The image must contain Airalogy, Python, Git, Poppler and Tesseract; the [image extension](../../../integrations/epri-research/cloud/Dockerfile) preserves the approved base entrypoint and requires its original runtime user to be selected at build time.

- The research backend retains its own license and dependency lock. It is built separately from this workspace package. Existing standalone research installations are not migrated into cloud accounts automatically.

### Dev Note

Build the research backend before running the package composition tests; the Web package-supply check also requires current platform artifacts.
