# Second environment deployment inputs

English | [中文](README.zh.md)

These Root-owned producers retain the original scientific workload, execd and server digests and the measured account domains.

## SDK assembly

`assemble-native-sdk.mjs` accepts the original `--input`, `--sha256` and new `--output-dir` arguments. It creates fresh private SDK inputs and keys. Existing deployments keep their original keys and select versioned configuration through their normal drained lifecycle. Execd executes the pinned trusted Root prep and loader with the Root command profile; ordinary commands use AgentData's UID mapping, zero capabilities, seccomp and bwrap isolation.

The output includes the exact installed Linux x64 ripgrep executable, its read-only workload bind and public program metadata in `BACKEND-MOUNTS.private.json`. Root copies and verifies these generated files in the original SDK work domain before starting that server.

## Search inputs

`node prepare-native-search-inputs.mjs --input /absolute/original-parameters.json --sha256 ORIGINAL_SHA256 --output-dir /absolute/new-directory` prepares a new account skeleton and Root parameter file. It preserves existing consumers, appends glob/grep, bounds native search stdout and stderr to 4096 bytes, and selects the existing single-instance mode. The original generator validates all account compositions and Loader schemas before activation.

## Applying a candidate

`generate-feature-root-profile-v3.mjs` consumes the original pinned Root parameters and public sources, validates the matching installed Loader schemas/account composition and writes only a fresh Linux Root-owned output directory. Optional `servicePreview` selects `inert-text-v1` or `service-application-v1`. Both require explicit Cookie domain, inert origin, complete inert budgets and exact API approval. Full mode additionally requires complete application/client/listener limits and the exact launch approval; it enables the original Sidebar Browser and a separate original Native WebServer in an isolated Cordis group. Management and content transports have explicit finite limits. The generated profile/package dependencies and `GENERATION.json` cover the entire group; the original launcher and final profile-SHA/FD4 seal remain authoritative. This generator never edits a running profile or starts an application.

Run `node --test deploy/local/second-environment-20261115/service-preview-profile.test.mjs` with `DSH_DEPLOY_TEST_INSTALL_ANCHOR` pointing to this matching built checkout's `packages/cloud/pe-cloud-client/package.json`, whose dependency scope resolves the actual configuration modules. Its finite cases cover assembly, absent/inert mode, exact approval, group discovery and actual Root/client/listener configuration parsers. They create no listener, SDK, database login or deployed profile. A real candidate still requires the original generator's `--check-only true`, normal protected generation/sealing and Browser/service acceptance.

Both producers accept `--check-only true` to validate inputs without creating the output directory. SDK validation uses the exact Linux x64 search bytes and the real Root deployment parser; its temporary fresh credential values stay in memory. Search validation uses the real account composer and reports the planned output digests. Actual output writes still require Linux Root. These checks do not validate a running SDK, physical mounts or service startup.

The producer artifact tests require a matching built checkout and caller-owned public fixtures. Set `DSH_DEPLOY_TEST_INSTALL_ANCHOR` to that checkout's `package.json` and `DSH_DEPLOY_TEST_PUBLIC_INPUTS` to the explicit public input directory, then run `node --test deploy/local/second-environment-20261115/producer-inputs.test.mjs`. The fixture reader accepts only its named public SDK sources, parameter template and pinned Linux search binary; it never reads an existing deployment or user credential. Missing fixtures fail the tests. The platform-specific search path lookup is isolated for byte validation on macOS; no Linux program is executed.

Root confirms the original application exit and actual terminal allocation releases, preserves mutable account files and credentials, and installs only the exact managed static patches whose previous hashes still match. The SDK producer runs only for a fresh deployment; a configuration update preserves the existing API key, token, controller records, backend generation and images. A completed real UI workflow verifies commands, native search, file transfer, relogin, Python execution and account isolation after activation.

Every generated Root validates the original management listener schema and complete authentication policy before writing, including when service preview is absent.

## Office dependency manifests

A composition containing the image-bound `load_workspace_dependencies` tool requires `officeRuntime: { path, sha256, workloadImageDigest }` in its Root inputs. Extract `runtime.json` from the exact selected immutable workload image. The generator checks the matching published Native parser, selected image and platform, stages the original bytes under `office-runtime/`, and emits `OFFICE-INSTALLATION.json` with every configured Host target. Use the generated complete `feature-assets/` directory as the read-only feature mount source before starting the candidate; it includes the account base, module link, manifest and image receipt; a configured tool without a carrier refuses generation. No interpreter payload is installed on the application Host. Run `node --test deploy/local/office-runtime.test.mjs` after the matching artifact build.
