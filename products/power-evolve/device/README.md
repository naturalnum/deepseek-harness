# Local device bundle

English | [中文](README.zh.md)

This standalone `dsh` bundle starts a local-only authorization page and a paired device worker. The current OS user grants project directories; absolute paths and the device token remain in its private local state. Commands run in disposable Docker containers with one granted directory mounted. The worker records a command before starting it and reconciles the exact container after interruption. Cloud file transfers require an explicit action on the device page.

Use the [slice 5 trial guide](../TRIAL-SLICE5.md) to pair a device and test cloud and desktop execution. The web server must bind loopback. This bundle does not include the cloud host's Agent loop or platform database credentials.
