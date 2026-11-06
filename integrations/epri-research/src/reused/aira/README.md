# Airalogy archive core

Copied from `upstream/airalogy/packages/npm/aira-core/src/index.ts` (package version 0.4.0). Licensed under Apache-2.0; the original license is retained as `LICENSE`. Upstream source is unchanged.

Local adaptation: export the existing `createStoredZip` helper so the server can produce records bundles using the upstream ZIP implementation. Record manifests are assembled in `src/server/archive.mjs`, then checked using this core's `openAiraArchive(...).validate()`. The browser uses the same reader for uploaded .aira files.

This implements the Airalogy archive/record format and AIMD structural handling. It does not install the Python Airalogy Engine, execute model.py/assigner.py, or synchronize an Airalogy cloud account.
