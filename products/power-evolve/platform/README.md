# Trusted platform bundle

English | [中文](README.zh.md)

This standalone `dsh` bundle composes the web server and PowerEvolve [trusted platform](../application/README.md#trusted-platform). It owns the database connection, identity and approval checks, durable operations, credentialed model requests, and controlled connector dispatch. It does not run Agents.

Use the [current trial guide](../TRIAL-SLICE3.md) to prepare its private configuration. Schema initialization and test-account seeding finish before readiness is published. Existing accounts and permission decisions are not overwritten by a restart.
