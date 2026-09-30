# Trusted platform bundle

English | [中文](README.zh.md)

This standalone `dsh` bundle composes the web server and PowerEvolve [trusted platform](../application/README.md#trusted-platform). It owns the database connection, identity and approval checks, durable operations, credentialed model requests, controlled connector dispatch, Agent Sandbox management, and paired device authorization. It does not run Agents or user commands.

Use the [current cloud trial guide](../TRIAL-S4-NATIVE.md) to prepare its private configuration and namespace-scoped Kubernetes access. The platform requires Python 3.9+ for [safe POSIX workspace access](../S2-SAFE-POSIX.md). Schema initialization and test-account seeding finish before readiness is published. Existing accounts, model grants, personal skills, devices, and permission decisions are not overwritten by a restart.

The profile preinstalls the nine bundled skills per user without starting an execution environment. `skillLibraryRoot` is private POSIX storage; when cloud execution is enabled it must equal `sandboxLocalRoot` so verified packages have the same source as the read-only Sandbox mount. `preinstalledSkills` selects catalog IDs and `maxSkillsPerUser` bounds the personal library.
