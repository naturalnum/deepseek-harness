---
description: "Configure the trusted PowerEvolve Platform Profile for accounts, durable cloud operations, storage and credentialed dispatch."
kind: package-bundle
---
# @power-evolve/platform

English | [中文](README.zh.md)

## Summary

A dedicated Platform Profile lets cloud users authenticate, manage their owned resources and authorize controlled actions. This layer connects the web server to the trusted PowerEvolve application. Operators supply private database, credential, storage and execution settings through the deployment launcher. Platform owns durable operations and dispatch authorization; separate Host and worker processes run Agents and user commands.

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

The [deployment launcher](../deploy/README.md#profile-lifecycle) prepares a separate named Platform Profile with this bundle. The private deployment document supplies credential-file paths, storage, database access and row overrides. Use an owned database, namespace and ports; the launcher's ownership rules apply before rendering and starting.

The [application](../application/README.md) owns the authentication, resource transactions and readiness checks. The Platform needs Python for its [protected POSIX file service](../application/src/platform/safe-posix.py). Current cloud schema initialization and configured account preparation precede its ready file; readiness alone does not certify every external service.

The patch selects `builtin.pdf` for each user's personal library. `enabledBuiltinSkills` selects the current built-in catalog, while `preinstalledSkills` selects automatic installations. Existing package assets and installed history remain intact. `skillLibraryRoot` names private POSIX storage; enabled Cloud execution requires it to equal `sandboxLocalRoot`, and `workspaceRoot` must name that root's `workspaces` directory. `maxSkillsPerUser` bounds the personal library. Preinstalling Skills does not start an execution environment.

`nativeIntentKeyFile` names a Platform-private file containing a canonical base64url-encoded 32-byte key. Preserve that key with the private configuration backup; Host receives only the worker credential. The four `nativeIntentMax*` settings bound retained request bytes, pending records, total records and stored bytes per Session. The [upgrade guide](../../../docs/upgrade-guide/v0.2.1-alpha.1/power-evolve-retained-intents/guide.md) owns operator migration steps.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Trusted configuration and dispatch ownership</summary>

[package.json](package.json) declares a `dsh.bundle.patch` layer. [cordis.patch.yml](cordis.patch.yml) inserts the logger, web server and trusted application into a standalone Profile. A later Profile patch replaces a row's complete configuration; each inserted package owns its behavior and lifecycle.

Database and provider credentials remain at Platform. Host adapters receive bounded APIs and current operation grants. Connector, Sandbox and Office services retain their own execution identities; the trusted application owns admission and reconciliation. The bundle itself stores no durable operation state.

`PE_NATIVE_INPUT_OWNER_ROUTING_FILE` selects the application's private native-input owner mapping. Its configuration and refusal rules belong to the [application reference](../application/README.md#understand-the-implementation). The mapping must name each participating Host's configured worker UUID and permitted HTTP origin; browser requests cannot select destinations.

The production manifest explicitly provides Contracts, Connector Runner and pinned Zod for the application peer graph. Installation admission requires all protocol consumers, including transitive helpers, to share the selected Node ESM modules. Linked Profiles must record each consumer root; independent workers require their own complete production closure. Provider changes require a new process. Browser validation instances are separate.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cloud application](../application/README.md) — authorization and durable operations.
- [Host layer](../host/README.md) — native Agent execution.
- [Cloud command image](../sandbox/README.md) — mounted execution and cleanup limits.
- [Deployment lifecycle](../deploy/README.md#profile-lifecycle) — private configuration and exact process ownership.
- [Confirmed migration scope](../CLOUD-MIGRATION-PLAN.md) — included capabilities and acceptance.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [application](../application/README.md#model-experience), which authorizes model requests, selected Skills and controlled tool results. The bundle adds no model prompt or native Session event of its own.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Operators must satisfy the trusted application's requirements:

- Private credentials and database access belong only to Platform; they are not Host configuration.
- Cloud, connector and Office execution require explicit private service configuration and current real-service acceptance.
- Profile overrides replace complete settings blocks; required fields must remain present.
- Schema readiness does not establish physical execution isolation, backup recovery or same-version combined acceptance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer context</summary>

Use the fixed official release and [product instructions](../AGENTS.md). Current schema, startup and recovery evidence belongs in migration and deployment records; historical trial results do not certify this Profile.

</details>
