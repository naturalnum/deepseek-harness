# Cloud deployment tools

English | [中文](README.zh.md)

## Summary

Render and launch the Host and Platform through their named DSH Profiles. Back up stopped current-cloud data and restore it into an independent empty database and new directories. Restored data remains stopped until the operator creates a deployment with the new database and storage paths and verifies its business readiness.

## Table of Contents

- [Profile lifecycle](#profile-lifecycle)
- [Linux image](#linux-image)
- [Office parser runtime](office-runtime/README.md)
- [Backup and restore](#backup-and-restore)
- [Verification](#verification)

<a id="profile-lifecycle"></a>
## Profile lifecycle

`start.mjs` accepts `host|platform`, a private deployment JSON path and optional `--render`. The deployment fields are `mode`, `privateDir`, `dshHome`, `hostOrigin`, `platformOrigin`, `platformInternalUrl` and `rows`; rows override existing bundle row IDs. `mode` is `https` or loopback-only `local-http`. Paths must be canonical absolute paths, and Host and Platform use distinct origins.

The owner marker binds a Profile to the repository, role and deployment document digest. Changing that document requires a new independent `dshHome`. An old marker, unrelated Profile, ready file without exact stop evidence, active prior PID or reused PID is refused. `--render` acquires the same exclusive reservation as launch.

The launcher holds a private persistent reservation through the exact DSH child's observed exit. SIGTERM and SIGINT are forwarded to that child after checking its birth identity; nonzero exits and unexpected signals remain failures. A crash or incomplete lifecycle leaves the reservation in place. Reconcile that private record and all original writers before any operator repair; the tool never reclaims an uncertain lock or kills by port.

<a id="linux-image"></a>
## Linux image

`cloud-image-context.mjs <checkout> <new-context>` creates an absent context outside the checkout. It requires the fixed official `dsh-v0.2.1-alpha.1` tag and a HEAD containing that baseline, and records both revisions and every copied file's SHA. It excludes host dependencies, generated outputs, private inputs and Desktop application source. Source changes during copying fail the build input freeze. The private context stays 0700; copied source directories are 0755 and files retain their declared source modes even with an owner-only caller umask. The exported source manifest is 0644. Native entry `lib/` outputs are excluded and compiled inside the Linux build.

Build that context with `docker build --no-cache --tag <owned-image> <new-context>`. The Dockerfile pins Node and PG tools by digest, signed Debian snapshots and the frozen pnpm lockfile. Linux compilation produces the native flock addon, CLI, cloud application and Web assets. The application is exported through its actual package file list; absent bootstrap SQL and manifests for versions 1–8 fail the export. Runtime files live under `/opt/power-evolve`, and the entrypoint launches `start.mjs` through the named CLI Profile.

Other runtime packages use npm's package file selection, including `files` globs, nested ignore rules and default selection when `files` is absent. Selection runs offline with package lifecycle scripts disabled and isolated npm configuration. Resource paths and symlinks may not leave their source package; declared icons and bundle patches must be selected regular files. Existing `node_modules` links are copied verbatim without following their targets. Output directories must be empty. This rule retains declared presets, locales and templates without a directory whitelist; it does not build missing runtime artifacts.

Run separate Host and Platform containers with `host|platform <private-deployment-json>` arguments, writable independent `dshHome` mounts and separate read-only credential mounts. The default UID/GID is 1000. Host receives only its worker token; Platform receives its own database and provider credentials. A shared PID namespace requires different service UIDs to prevent access through another process's root. Mount all six storage roots and both stopped Profile directories into the same Linux PID namespace for backup, using a process able to preserve their actual UID/GID values.

The [Office runtime guide](office-runtime/README.md) owns the separate runsc handler, startup network isolation, RuntimeClass, NetworkPolicy, PVC and private parser configuration. Apply its node requirements before enabling Office conversion in Platform.

<a id="backup-and-restore"></a>
## Backup and restore

`backup.mjs` accepts `create|restore` and one absolute private configuration JSON path. Configuration fields are `format: 1`, `bundle`, `postgres`, `roots`, `profiles` and `nativeIntentKeyFile`. `postgres` requires `urlFile`, exact `database` and `role`; optional `tools` selects an absolute `binDir` or an explicitly owned `container` with `host` and `port`. Node and libpq must reach the same server incarnation, database and role, and psql, pg_dump and pg_restore must match the server major version. Credentials stay in private files and child environments; failures save private diagnostics beside the URL file.

`roots` requires six explicit directories: `privateConfig`, `workspaces`, `homes`, `skillPackages`, `attachments` and `officeCache`. This slice requires physically separate roots and two separate Profile directories. Private configuration and attachment entries must be owner-only; writable data preserves its actual owners and modes. Source Profile directories must contain this launcher's stopped Host and Platform evidence. Backups include every selected entry, including empty directories, old skill versions, original attachments, orphan bytes, unpublished objects and crash staging. Hardlink relationships and symlink text are preserved without following symlinks. Private configuration and attachment roots forbid symlinks.

`nativeIntentKeyFile` must name the actual Platform journal key inside the selected `privateConfig` root. The key must be a regular 0600 file containing canonical unpadded base64url for 32 bytes, with an optional final newline. The backup records its relative path, size and SHA alongside the full private inventory. Restore requires the same relative path and original file bytes; changing the key prevents decryption of retained requests. Keep this key when rebinding the restored Platform.

Creation reserves both stopped Profiles, rejects other database connections and active or uncertain execution records, and uses an exported PG snapshot for the full table census and custom dump. It accepts only the current `cloud-native` Schema 8 column manifest. Both temporary presentation tables, `pe_native_presentations` and `pe_native_presentation_entries`, must be empty; retained rows cause refusal without deletion. The dump retains all 82 tables, canonical events, definitions and sequences, including immutable native input facts, execution frames and version-two turn receipts and retained native intent records. A prepared retained intent blocks backup; committed and abandoned records remain in the dump. Native foreground execution requests, terminal results, exact stop identities and first stopping causes remain in the dump; active cancellation and stopping mounts block backup. The definition census includes noninternal trigger definitions and their enabled modes. Schema 6 trial data requires its original versioned backup tool before an upgrade; older bundles remain unchanged. A native writer with `expires_at > clock_timestamp()` blocks backup; released (`expires_at IS NULL`) and expired writer rows retain their complete identity, token digest, epoch and expiry. Backup never deletes writer rows or resets epochs. It never converts Schema 47 or edits an old backup. Existing bundles are refused, and failed unpublished stages remain private for inspection.

Restore validates the Schema 8 manifest digest, all file inventories, permissions and the archived journal key before mutation, then refuses source overlap, matching source database names, occupied databases and existing target paths. The empty-database check runs under the ordinary deployment role and includes functions, schemas, foreign objects, large objects, subscriptions and local settings. The custom dump restores in one transaction; every table row, schema definition, sequence and selected file is compared afterward. Both temporary presentation tables must still be empty and no native writer may be live before any file-root restoration; restore retains all writer tombstones and never replays a presentation. A failed restore leaves the partial target stopped for inspection.

Profile copies and private configuration are archival snapshots: they retain the source owner, paths and database URL. Restore does not launch applications or automatically rebind credentials or storage. Its evidence states `readinessChecked: false` and `profilesRequireRebinding: true`. Render new named Profiles with reviewed target configuration, then separately verify new tasks and the complete same-version system.

<a id="verification"></a>
## Verification

The focused Node tests use real processes, current built DSH Profiles, private temporary directories, ordinary PG roles and isolated databases. The PG test requires `PE_TEST_DATABASE_URL_FILE` and owns its separate libpq tools container; it does not operate the existing database container. Run `node --test products/power-evolve/deploy/employee4-start.test.mjs` and `node --import tsx/esm --test products/power-evolve/deploy/employee4-backup.test.mjs` with that environment variable supplied. These checks cover the deployment and data restore slice. The [handoff](EMPLOYEE4-HANDOFF.md) retains dated slice results, including coverage failures; the [integration status](../TRIAL-CLOUD-MIGRATION-STATUS.md) reports the current candidate's same-version qualification and M5 status.

`node --import tsx/esm --test products/power-evolve/deploy/employee4-schema3-backup.test.mjs` separately checks the Schema 8 data consumer with its own PG container and ordinary source and target roles. It verifies Schema 2–7 refusal, retained temporary rows, live-writer refusal, released and expired writer tombstones with exact epochs, full 82-table dump and restore, and refusal of temporary or live-writer rows before file restoration. All seven native input, frame and version-two receipt tables contain persisted fixtures; restored input facts retain their immutability checks. It bootstraps through the current `initializeDatabase`; `PE_NATIVE_*_DDL` overrides are refused. Its Profile directories contain archival fixture bytes; this test does not verify formal Profile launch or restored business tasks. `PE_SCHEMA8_BACKUP_EVIDENCE_DIR` optionally receives private results.

The image acceptance test requires `PE_TEST_CLOUD_IMAGE` naming a uniquely tagged image with its matching `org.power-evolve.employee4` ownership label, and `PE_IMAGE_BUILD_MANIFEST` naming a private JSON containing its context path. Set `coldBuild: true` in that JSON with a fresh UUID `id` and an absent external `context` to let its source test perform the no-cache build. Run `node --test products/power-evolve/deploy/employee4-image.test.mjs`; optional `PE_IMAGE_EVIDENCE_DIR` receives private diagnostics, and `PE_IMAGE_TEST_SUBNET` selects an explicit owned subnet when the Docker default pool is unavailable. The pack receipt takes its schema version from the exported Platform database module in the extracted application package and requires every schema SQL and manifest through that version. A supplied frozen `PE_CLOUD_COVERAGE_INPUT` records separate build, pack and service contexts with their actual Linux paths and source bytes. It creates its own PG roles, containers and volumes, verifies actual Linux flock and Profile exits, and restores all rows and files under ordinary deployment roles. Missing image inputs fail; unsuccessful restore stages remain private for inspection.
