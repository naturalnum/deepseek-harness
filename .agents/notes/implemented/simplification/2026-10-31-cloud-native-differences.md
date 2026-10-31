# Agent Note: Keep Cloud policy in the existing Cloud packages

Status: implemented

English | [中文](2026-10-31-cloud-native-differences.zh.md)

## Problem

Cloud-specific document authentication and ordinary plugin-field permissions had expanded native services. Removing every native difference would also discard shared lifecycle fixes and account isolation checks inside asynchronous operations.

## Decision

The existing access package's `/frontend` entry replaces the explicit frontend row in Cloud profiles. It reuses native `serveStatic` and the same single fallback registration; native frontend-static retains Connection authentication. The Cloud API owns ordinary-field replacement policy internally while native Settings retains secret redaction. The Cloud plugin editor supplies the existing ConfigField callback instead of changing that control's required props. Package count, services, processes, account data, quotas and business-route admission do not change. Deployment migration is documented in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.2/cloud-public-frontend/guide.md).

## Alternatives considered

**Revert every native change.** This removes actual close, cancellation, persistence and account-isolation guarantees. A wrapper outside an asynchronous commit point cannot replace those checks.

**Copy native implementations into Cloud packages.** Duplicating Gateway, storage, Office or UI engines increases ownership and upgrade work without reducing architectural complexity.

**Move pre-authentication browser startup into the dynamic client bundle.** That changes module identity and startup order. The shared schema entry cannot acquire DOM, React and CSS dependencies merely to reduce the native file count.

## Consequences

Cloud business policy has an explicit owner and native default behavior remains available. Generic fixes and necessary integration points remain as small native patches until equivalent public native facilities exist. Source tests establish HTTP serving and editing behavior; deployment resolution, root sealing and actual login remain separate release checks. The public distribution and all index injections must contain no private account data or secrets.
