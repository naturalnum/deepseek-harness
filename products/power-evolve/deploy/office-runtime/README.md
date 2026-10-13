# Office parser runtime

English | [中文](README.zh.md)

## Summary

Run Office parsers through a dedicated runsc handler with networking disabled before process startup. Platform owns the private parser configuration and Kubernetes credentials. The parser mounts only its fixed input and output subdirectories, uses UID/GID 1000 and receives no service-account token.

## Table of Contents

- [Node handler](#node-handler)
- [Cluster dependencies](#cluster-dependencies)
- [Private configuration](#private-configuration)
- [Verification](#verification)

<a id="node-handler"></a>
## Node handler

Install a compatible runsc binary and `containerd-shim-runsc-v1` on every eligible parser node. Merge [offline-handler-extra.toml](offline-handler-extra.toml) into that node's persistent containerd template, and install [pe-office-offline.toml](pe-office-offline.toml) at `/etc/containerd/pe-office-offline.toml`. The handler name, ConfigPath and runsc options must match on every node. Reload containerd through the cluster's node-management procedure after reviewing that node's other workloads; retain its existing handlers.

The supplied handler uses `systrap`, `network = "none"`, disabled raw networking and the gVisor marker file. Node replacements and upgrades must retain the same template and runsc settings. A RuntimeClass alone does not configure the node's shim or disable networking.

<a id="cluster-dependencies"></a>
## Cluster dependencies

Create the [RuntimeClass](runtimeclass.yaml) in the owned cluster only after all eligible nodes have the matching handler. Review the namespace placeholder in [networkpolicy.yaml](networkpolicy.yaml), then apply it in the dedicated parser namespace with a policy-enforcing CNI. The policy selects `power-evolve-office-preview` Pods and denies ingress and egress; runtime networking remains disabled before the policy controller observes a new Pod.

Provision an operator-owned PVC that exposes only the parser cache tree on every eligible node and to Platform. Its local mirror and `volumeSubPath` must identify the same bytes. Use storage that supports the required multi-node access; the example does not create a hostPath PV. The cache cannot overlap workspace, attachment, Home or Skill roots. Parser input is read-only with UID/GID 1000 and mode 0400; its independent output directory must be writable by UID/GID 1000.

<a id="private-configuration"></a>
## Private configuration

Copy [office-preview.example.json](office-preview.example.json) outside Git, replace both digest placeholders and the owned namespace, claim, cache paths and deployment budgets, then restrict it to the Platform owner. `runtimeClassName` must name the verified `pe-office-offline` handler. Image digests and the font-policy digest must match the approved parser image and font inventory; the supplied placeholders are not executable configuration.

Set the Platform row's `officePreviewConfigFile` to that private JSON path and `officePreviewKubeconfigFile` to its separate private kubeconfig path, or `in-cluster` for the existing in-cluster provider. Both references are required together. A private deployment JSON can override these fields under `rows.platform["power-evolve-platform"]`; Host receives neither file. New conversion intents retain `runtimeClassName` and `safetyVersion: 2`; retained older intents cannot start a parser through an unverified runtime.

<a id="verification"></a>
## Verification

On every eligible node, run an owned control probe and a probe using this RuntimeClass against the same controlled HTTP endpoint. The control's first request must succeed, while the restricted probe's first request must fail with `ENETUNREACH` and expose only loopback networking. In that same restricted process verify UID/GID 1000, an `EROFS` input write and a successful output write. Record the actual node, Pod UID, runtime identity and bytes, then clean only those exact owned probes.

Policy presence, a late blocked request and a completed Pod are insufficient startup-isolation evidence. The [image evidence](../QA-IMAGE-EVIDENCE.md) distinguishes the recorded two-node handler probes from pending image, actual Office conversion and complete deployment acceptance.
