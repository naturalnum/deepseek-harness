# Cloud integration and local review

English | [中文](README.zh.md)

This directory helps maintainers connect the research suite to their cloud multiuser platform. The [plugin guide](../../../packages/experimental/epri-research/README.md) defines native account ownership, authorization and lifecycle requirements. Production configuration, account passwords and tokens are not part of this source package.

## Build

Install the locked pnpm dependencies at the repository root, then run `npm ci` and `npm run build` separately in `integrations/epri-research`. Return to the root and run `pnpm run build:artifacts` followed by `pnpm run build:check`. Use Node 24.14 or newer and the pnpm version declared in the root `packageManager`. Copying only the native plugin without the research backend, `dist/ui` or `upstream` resources is insufficient.

The native plugin loads `dist/server/cloud-plugin.mjs`. It does not start standalone HTTP/MCP services, read standalone research credentials or use a global data directory. The production resolver-anchor package.json must explicitly include the native plugin and `deepscientist-harness-suite` so the platform package resolver can supply browser modules; do not add an implicit dependency to the default Web product.

## Configuration copies

The preparation script is `packages/experimental/epri-research/scripts/prepare.ts`. Its input JSON contains resolved Loader entry arrays named `root` and `account`, a Linux `installationDirectory`, a new `recipeVersion`, and these explicit fields:

```json
{
  "service": {
    "python": "/opt/epri-python/bin/python3",
    "maxJsonBytes": 4194304,
    "maxOutputBytes": 8388608,
    "graceMs": 5000
  },
  "web": { "requestTimeoutMs": 180000, "maxPendingRequests": 8 }
}
```

These example values require review against the deployment's existing request, response, storage and execution capacities. Use actual approved configuration as input; do not copy configuration expressions into JSON as ordinary strings. The script requires one existing Preset, a managed-skill resource provider and consistent recipe versions. It neither expands existing capacities nor creates another account system or Preset.

Run from the source root:

```sh
node --import tsx/esm packages/experimental/epri-research/scripts/prepare.ts input.json review-output
```

The output directory must not exist. Review `root.json`, `account.json`, `dependencies.json` and the new Preset digest. Place the account file at the Root's original `native.configPath`, then start through the platform's `dsh` profile. The platform still owns complete configuration validation, Root recipe approval, account resource allocation and login. Script output alone does not establish deployment acceptance.

## Cloud execution image

Extend the deployment's approved Debian-based OpenSandbox image with this Dockerfile, retaining its original runtime user:

```sh
docker build --build-arg BASE_IMAGE=APPROVED_IMMUTABLE_IMAGE --build-arg RUNTIME_USER=ORIGINAL_USER -t research-sandbox:review -f integrations/epri-research/cloud/Dockerfile .
```

The extension installs Airalogy 0.16.0, Git, Poppler, English and Chinese Tesseract data, and an isolated Python environment. Record the production image's immutable digest and installed package inventory, then select it through platform configuration. The Dockerfile preserves the OpenSandbox entrypoint. An Airalogy-only test image cannot replace the deployment's complete OpenSandbox base image.

## Verification scope

Run research core tests with `npm test`. The plugin's `tests` cover native Loader and Gateway composition, two-account isolation, disposal, recorded tool sessions and configuration preparation; run them by file with the root Vitest runner. Cloud model calls, OCR and Git use the current Session's native providers. Missing providers or revoked account authority must report an error, with no fallback to Host execution.

Production acceptance must also check concurrent login with two real accounts, old-window requests after logout, cross-account object rejection, skill materialization in actual account projects, computation/OCR inside OpenSandbox, and execution cleanup during account disposal. These checks require actual deployment configuration and a test endpoint; local component tests cannot replace them.
