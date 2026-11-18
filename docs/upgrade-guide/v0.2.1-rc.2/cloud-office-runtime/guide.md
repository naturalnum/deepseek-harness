---
kind: upgrade-guide
description: "Cloud Office profile generation requires an image-bound Host runtime manifest, and the bounded command payload has new source pins."
---

# Publish the Cloud Office runtime manifest

English | [中文](guide.zh.md)

## Change

The Root profile generator refuses an enabled image-bound `load_workspace_dependencies` tool without a selected-image manifest. It stages the original manifest bytes and emits explicit installation targets. Native manifest readers normalize the legacy OCI architecture spelling `amd64` to `x64` without rewriting image files.

The bounded command launcher now carries `MALLOC_ARENA_MAX=1` through its cleared environment. The command profile raises the per-file limit from 64 MiB to 128 MiB. The 512 MiB address-space limit and 32 open-file limit remain in force. Deployments pinned to the previous Python payload must use the matching new protected configuration. Closed image deployments omit `read_image`; this does not enable Cloud image intake.

## Migration

1. Extract `/opt/dsh/runtime/runtime.json` from the exact immutable workload image selected by Root. Record its SHA-256 and that image digest. Keep the interpreter payload in the image.
2. Supply `officeRuntime: { path, sha256, workloadImageDigest }` to [the Root generator](../../../../deploy/local/second-environment-20261115/generate-feature-root-profile-v3.mjs). Use its complete `feature-assets/` directory as the application's read-only feature mount source through the normal versioned asset installation. `OFFICE-INSTALLATION.json` records the mount target and every manifest location.
3. Rebuild matching products and set `lifecycle.payloadSha256` in the successor protected deployment to the current [agent source pin](../../../../packages/cloud/pe-opensandbox/src/agent-data/constants.ts). Hash the exact protected deployment file and use that digest in the generated execution Root's `rootDeployment.sha256`. Preserve account data, normally drain the previous execution owner, and activate the new products and configuration together through the original startup and rollback process.
4. In a new test Session, call the real dependency tool twice, run its returned Python, recalculate a workbook after changing an input, verify cached results and Chinese PDF text, and download the actual saved file. In a project with sufficient free space, verify an actual 100 MiB write and an `EFBIG` refusal past 128 MiB. With image intake closed, confirm `read_image` is absent and visual inspection is reported unavailable.
