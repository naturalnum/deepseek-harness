# @power-evolve/client-account

English | [中文](README.zh.md)

PowerEvolve's browser account launcher and personal settings section use the native DSH Settings shell. The Host forwards only authenticated product RPCs; the client receives an authorized model list and per-user settings, never provider credentials. The section retains one mutation request ID for retries after an uncertain response and reloads the authoritative settings after a revision conflict.

## Model experience

This package does not call a model. It only selects a model already authorized by the trusted platform; the platform validates the choice again when accepting and executing a prompt.
