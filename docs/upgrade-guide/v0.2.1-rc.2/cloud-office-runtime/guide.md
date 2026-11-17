---
kind: upgrade-guide
description: "Cloud Office profile generation requires an image-bound Host runtime manifest, and the bounded command payload has new source pins."
---

# Publish the Cloud Office runtime manifest

English | [中文](guide.zh.md)

## Change

The Root profile generator refuses an enabled image-bound `load_workspace_dependencies` tool without a selected-image manifest. It stages the original manifest bytes and emits explicit installation targets. Native manifest readers normalize the legacy OCI architecture spelling `amd64` to `x64` without rewriting image files.

The bounded command launcher now carries `MALLOC_ARENA_MAX=1` through its cleared environment. The Python source and bootstrap pins change; the 512 MiB address-space limit, 32-file limit, isolation and wire protocol remain unchanged. Deployments pinned to the previous payload must use the matching new protected configuration. Closed image deployments omit `read_image`; this does not enable Cloud image intake.

## Migration

1. Extract `/opt/dsh/runtime/runtime.json` from the exact immutable workload image selected by Root. Record its SHA-256 and that image digest. Keep the interpreter payload in the image.
2. Supply `officeRuntime: { path, sha256, workloadImageDigest }` to [the Root generator](../../../../deploy/local/second-environment-20261115/generate-feature-root-profile-v3.mjs). Install its staged `office-runtime/runtime.json` at every target in `OFFICE-INSTALLATION.json` through the normal versioned asset installation. Include the file in the application's read-only asset mount.
3. Rebuild matching products and use the current [agent source pin](../../../../packages/cloud/pe-opensandbox/src/agent-data/constants.ts) in the successor protected deployment. Preserve account data, normally drain the previous execution owner, and use the original startup and rollback process. Do not rewrite pins in a running instance or adopt an old allocation as the new payload.
4. In a new test Session, call the real dependency tool twice, run its returned Python, recalculate a workbook after changing an input, verify cached results and Chinese PDF text, and download the actual saved file. Retain the existing process limits. With image intake closed, confirm `read_image` is absent and visual inspection is reported unavailable.
