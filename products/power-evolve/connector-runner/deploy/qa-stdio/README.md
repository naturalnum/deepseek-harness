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
