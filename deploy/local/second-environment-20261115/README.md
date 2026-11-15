# Second environment deployment inputs

English | [中文](README.zh.md)

These Root-owned producers retain the original scientific workload, execd and server digests and the measured account domains.

## SDK assembly

`assemble-native-sdk.mjs` accepts the original `--input`, `--sha256` and new `--output-dir` arguments. It creates fresh private SDK inputs and keys. Existing deployments keep their original keys and select versioned configuration through their normal drained lifecycle. Execd executes the pinned trusted Root prep and loader with the Root command profile; ordinary commands use AgentData's UID mapping, zero capabilities, seccomp and bwrap isolation.

The output includes the exact installed Linux x64 ripgrep executable, its read-only workload bind and public program metadata in `BACKEND-MOUNTS.private.json`. Root copies and verifies these generated files in the original SDK work domain before starting that server.

## Search inputs

`node prepare-native-search-inputs.mjs --input /absolute/original-parameters.json --sha256 ORIGINAL_SHA256 --output-dir /absolute/new-directory` prepares a new account skeleton and Root parameter file. It preserves existing consumers, appends glob/grep, bounds native search stdout and stderr to 4096 bytes, and selects the existing single-instance mode. The original generator validates all account compositions and Loader schemas before activation.

## Applying a candidate

Root confirms the original application exit and actual terminal allocation releases, preserves mutable account files and credentials, and installs only the exact managed static patches whose previous hashes still match. The SDK producer runs only for a fresh deployment; a configuration update preserves the existing API key, token, controller records, backend generation and images. A completed real UI workflow verifies commands, native search, file transfer, relogin, Python execution and account isolation after activation.
