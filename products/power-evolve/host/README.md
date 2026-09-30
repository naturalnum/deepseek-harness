# Shared host bundle

English | [中文](README.zh.md)

This standalone `dsh` bundle composes the native text Agent services with the PowerEvolve [host plugins](../application/README.md#host). It does not inherit the native local execution profile. Deployment defaults live in `cordis.patch.yml`; a profile patch replaces an entry's complete configuration.

Use the [current cloud trial guide](../TRIAL-S4-NATIVE.md) to prepare the private profile and launch it. The platform must be available for admission, task claims, history, model calls, connector authorization, personal Skills, and cloud execution admission.

The bundle loads native `dsh-skill` and `dsh-tool-skill` with an Agent-scoped platform provider. It exposes no filesystem skill scanner; user package code is never loaded into the Host.
