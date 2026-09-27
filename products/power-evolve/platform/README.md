# Trusted platform bundle

English | [中文](README.zh.md)

This standalone `dsh` bundle composes the web server and PowerEvolve [trusted platform](../application/README.md#trusted-platform). It owns the database connection, identity and approval checks, durable operations, credentialed model requests, controlled connector dispatch, and Agent Sandbox management. It does not run Agents or user commands.

Use the [current trial guide](../TRIAL-SLICE4.md) to prepare its private configuration and namespace-scoped Kubernetes access. Schema initialization and test-account seeding finish before readiness is published. Existing accounts and permission decisions are not overwritten by a restart.
