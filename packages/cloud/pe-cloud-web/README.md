---
description: "Static Cloud login layout, authentication page state and integration with the native Web boot."
kind: "package-library"
---

# @deepseek-ai/dsh-pe-cloud-web

English | [中文](README.zh.md)

## Summary

This library supplies the Cloud login entry for the shared Web shell. It owns layout, styles and authentication page state, uses the existing Cloud copy and prepared page owner, and delegates module loading and application startup to native AppWebEntry.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`apps/web` creates `CloudWebEntry` only when the Host supplies a Cloud manifest. This library is bundled as a static dependency rather than installed as a Cordis plugin. Initialization, run and disposal are defined by the [entry source](src/index.ts).

<a id="understand-the-implementation"></a>
## Understand the implementation

The page controller retains the original owners of the browser document, authentication requests and page preparation. Account isolation and server authorization stay with Cloud ingress. Native static linking passes CSS to Vite.

<a id="further-exploration"></a>
## Further Exploration

[Cloud subsystem](../../../docs/subsystems/cloud.md) and [page preparation](../pe-cloud-client/README.md).

<a id="model-experience"></a>
## Model Experience

None, as this static login library registers no model-facing capability.

#### KV Cache effect

None; this library neither assembles nor sends model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The entry requires a Host-supplied Cloud manifest and does not supply an authentication service.

<a id="dev-note"></a>
### Dev Note

The current comparison baseline and the native upgrade target are recorded separately in the existing migration ledger.
