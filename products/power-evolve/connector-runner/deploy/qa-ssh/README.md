# Disposable k3d SSH acceptance check

English | [中文](README.zh.md)

`run.mjs` creates a random `pe-connector-qa-*` namespace on the explicitly selected local k3d cluster. It uses the existing access helper to issue a namespace-scoped Platform kubeconfig, imports the selected Connector Runner image, and starts an SSH target and independent forbidden listener. The SSH target runs the pinned `ssh2` package from that image and accepts one randomly generated password for user `qa`; its only command is `qa:ping`, which returns `qa:ssh-ok`. The host key, password, and kubeconfig are created in a private 0700 directory outside the repository. The script removes that directory and the namespace on completion or failure.

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
