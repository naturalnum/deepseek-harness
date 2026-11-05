# DeepScientist / Airalogy research suite

English | [中文](README.zh.md)

Cloud integration version: 0.2.1-cloud.20261105.1. This local review source contains no account data or credentials.

See [cloud/README.md](cloud/README.md) for cloud builds, deployment configuration copies and verification. The native adapter lives in `packages/experimental/epri-research` and reuses the platform's original accounts, single approved Preset, Sessions, files and execution services. Each account has separate research storage; model tools and human actions receive separate authorization checks. Standalone compatibility entries remain available but are not started by cloud deployment.

## Local build and tests

Node.js >= 24.14.0 is required. Run in this directory:

```sh
npm ci --no-audit --no-fund
npm run build
npm test
```

Run native platform builds and composition tests from the repository root. Acceptance of real multiuser login and OpenSandbox deployment requires the deployment's actual Root/account configuration and test endpoint; local component tests cannot replace that acceptance. `integration.json` distinguishes source, component and deployment validation.

## File map

- `plugins/workbench`: research entry, workbench and delivery-file collection.
- `plugins/airalogy`: research tools and the native human-question review flow.
- `plugins/deepscientist`: engineering research skills and resource loading.
- `src/server`, `src/ui`: research services and workbench source.
- `src/reused`, `upstream`: reused code and skill materials with their source notices.
- `cloud`: cloud integration guide, image extension and Linux execution acceptance.
- `tests`: regression tests with temporary synthetic data.
- `dist`: generated backend, Web assets and browser modules.

## License

This package is AGPL-3.0-only and retains LICENSE, NOTICE, licenses and individual skill license texts. The native adapter's license does not replace the licenses of this backend or its reused materials.
