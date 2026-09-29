# Disposable k3d STDIO MCP acceptance check

English | [中文](README.zh.md)

Run this only against an explicitly selected local k3d cluster with gVisor and enforced NetworkPolicy. The script creates a random dedicated namespace and a private scoped kubeconfig, starts an independently healthy forbidden listener, then creates two separate process MCP Pods. Each Pod must deny connection to that live listener, return only its assigned account, preserve a duplicate call result, and reject a changed account under the same call ID. The script removes its namespace and private files on completion or failure. It does not modify the stable Platform or Host service.

From the repository root, build and import the current Runner image, then run the check:

```sh
export PE_K3D_CLUSTER=pe-e32-session-probe
export PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_CONNECTOR_IMAGE=pe-connector-runner:s6-stdio-qa
node products/power-evolve/connector-runner/deploy/build-and-import.mjs
node --import tsx/esm products/power-evolve/connector-runner/deploy/qa-stdio/run.mjs
```

The script prints no Runner token, kubeconfig, or per-call digest. A failed namespace deletion prints the random namespace name for manual inspection.

## Native browser and real-model acceptance

For a separate two-user browser trial, keep the namespace and scoped kubeconfig from the Runner check. Use a fresh private directory under `~/.config/power-evolve/`; the retained fixture writes `ssh.json` there with a deliberately unroutable SSH allowlist because the current Platform enables STDIO through the shared Connector configuration. The browser check uses only the fixed STDIO whoami tool.

```sh
export PE_STDIO_TRIAL_PRIVATE_DIR="$HOME/.config/power-evolve/shared-host-native-s6-stdio-qa"
node --import tsx/esm products/power-evolve/connector-runner/deploy/qa-stdio/run.mjs
# Put a valid model.env in that private directory as for the other real-model trials.
export PE_PRIVATE_DIR="$PE_STDIO_TRIAL_PRIVATE_DIR"
export PE_TRIAL_NAME=native-s6-stdio-qa
export PE_DATABASE_PORT=18532 PE_HOST_PORT=19350 PE_PLATFORM_PORT=19351 PE_TARGET_PORT=19352
export PE_SSH_ENABLED=1 PE_COMPOSE_EXTERNAL_NETWORK=pe-shared-host-slice5_default
node products/power-evolve/scripts/trial.mjs up
PE_STDIO_RESTART=1 node products/power-evolve/scripts/qa-stdio-browser.mjs
```

Set `PE_KUBE_CONTEXT` to the same explicitly selected cluster context. Choose unused trial ports, name, and namespace; do not reuse a stable or other active trial. The browser script logs in as both provisioned users in separate Chromium contexts, creates a cloud Workspace through the native UI, installs and toggles the fixed Process MCP connection through Plugins, sends a real-model message from each conversation, and checks owner-scoped calls, distinct Runner identities, same-Session continuations, transcript refresh, resource cleanup, and restart recovery. It can be rerun against the same trial; omit `PE_STDIO_RESTART=1` to skip its final restart check. The namespace and trial are intentionally retained for inspection. Stop only this trial with `node products/power-evolve/scripts/trial.mjs stop` under the same environment, then delete its dedicated namespace when finished.
