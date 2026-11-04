# Office image handoff

English | [中文](README.zh.md)

This offline preparation tool verifies the retained 251-file v5 Office image context, preserves the complete original skill resources, and emits a deterministic context archive plus an explicit capacity decision. It never invokes Docker or changes an account, image, quota, source resource, or running service. Existing staged CLI results remain historical evidence; the prepared archive is not an executed Office environment.

Run `python3 prepare_context.py --context <v5-directory> --manifest <v5-manifest.json> --output <new-owned-directory> --builder-free-bytes <actual-bytes> --production-free-bytes <actual-bytes>`. Inputs must be fresh measurements of the actual selected builder and production image stores. The builder needs the retained 4 GiB planning minimum; insufficient capacity returns exit 2 after writing the handoff. A successful preparation returns exit 0 but never admits production import: its unique layer bytes and import peak are known only after the build.

The explicit base is the reviewed SSH dependency image, retaining Remote functionality when Office is added. A runtime owner must verify that base still exists and measure the final image. The v5 apt recipe has unpinned package versions and only its top-level Python requirements are pinned; neither a frozen context nor its hash establishes a reproducible dependency lock. The builder must preserve the actual complete system and Python package manifests with the final image digest.

The context includes read-only Native skill resources from the earlier integration. This tool changes no Native files and does not certify compatibility with an unmodified upstream Native baseline. The strict integration reviewer must separately establish that baseline, resource placement and existing public provider interfaces before selecting the final image.

Only the sole runtime owner may perform a build, import or production selection. Qualification must retain the original guest security fields, all tenant limits and current/rollback data, use no Host dependency mounts, and verify the actual issued account environment despite Native `--clearenv`. The existing standalone CLI probe does not prove the original SDK/account/approval lifecycle. All 13 skill/model tasks, complete package hashes, cancellation and document visual checks must pass before enabling invocation.

Run the focused controls with `python3 -m unittest discover -s . -p 'test_*.py'` from this directory. Full product acceptance remains with the original deployment and account owners.
