#!/bin/sh
# Invoked only by ssh-keygen; its stdout goes to that child, never the preparation log.
set -eu
exec cat -- "${SSH_FIXTURE_PASSPHRASE_FILE:?}"
