# Disposable k3d SSH acceptance check

English | [中文](README.zh.md)

`run.mjs` creates a random `pe-connector-qa-*` namespace on the explicitly selected local k3d cluster. It uses the existing access helper to issue a namespace-scoped Platform kubeconfig, imports the selected Connector Runner image, and starts an SSH target and independent forbidden listener. The SSH target runs the pinned `ssh2` package from that image and accepts one randomly generated password for user `qa`; its only command is `qa:ping`, which returns `qa:ssh-ok`. It tolerates early canary disconnects without terminating. The host key, password, and kubeconfig are created in a private 0700 directory outside the repository. By default, the script removes that directory and the namespace on completion or failure.

From the repository root, install dependencies and import a Connector Runner image built from the current source:

```sh
pnpm install --frozen-lockfile --ignore-scripts
export PE_K3D_CLUSTER=pe-e32-session-probe
export PE_KUBE_CONTEXT=k3d-pe-e32-session-probe
export PE_CONNECTOR_IMAGE=pe-connector-runner:s6-qa
node products/power-evolve/connector-runner/deploy/build-and-import.mjs
node --import tsx/esm products/power-evolve/connector-runner/deploy/qa-ssh/run.mjs
```

Use a cluster with `gvisor` RuntimeClass and NetworkPolicy enforcement. The script refuses a pre-existing namespace, uses the selected cluster context for administrator operations, and uses the generated scoped kubeconfig for Runner orchestration and the listener control probe. It checks that this kubeconfig cannot manage Deployments or read Namespaces. The test sends the password only after a credential-free canary has inspected the exact SSH host key and the forbidden listener is healthy. It first verifies that a wrong pinned fingerprint fails before dispatch. An administrator then runs a credential-free TCP probe inside the actual policy-selected Runner Pod: the SSH target must connect, the forbidden listener must deny or refuse, and the independent control probe must still find that listener healthy. The successful dispatch runs through `SshRunnerOrchestrator`, followed by read-only reconciliation of the fixed command's result. Runner readiness requires three denied connections to the live forbidden listener.

The script prints no password, private key, control token, kubeconfig, or request digest. It reports a generic command failure instead of dumping `kubectl` input or output. If namespace deletion fails, it prints the exact random namespace name for manual inspection and cleanup; do not use the script with an active Connector namespace.

For a separate browser trial, set `PE_SSH_TRIAL_PRIVATE_DIR` to a new absolute directory under `~/.config/power-evolve/` before running `run.mjs`. After the same Runner checks pass, the script retains the SSH target, forbidden listener, scoped kubeconfig, and `ssh.json` in that directory. Set `PE_PRIVATE_DIR` to this directory and `PE_SSH_ENABLED=1` when preparing the trial; the browser reads the fixture password from its private `password` file. A failed retained run prints the namespace for inspection and leaves it in place without writing `ssh.json`. Stop the trial before deleting that exact namespace and private directory.

Once the isolated native trial is running, set `PE_PRIVATE_DIR`, `PE_HOST_PORT`, `PE_PLATFORM_PORT`, and `PE_KUBE_CONTEXT`, then run `node products/power-evolve/scripts/qa-ssh-browser.mjs` from the repository root. It uses separate Alice and Bob browser contexts, verifies direct password upload and owner isolation, waits for each new authentication call by ID, checks refresh recovery, tests a wrong fingerprint and denied destination, and checks PG state and Runner cleanup. It reuses named connections on a repeat run but creates new check calls.
