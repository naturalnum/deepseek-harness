#!/bin/sh
set -eu
umask 077
node /opt/power-evolve/ssh-target-fixture/configure.mjs
exec env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C \
  /usr/sbin/sshd -D -e -f /opt/power-evolve/ssh-target-fixture/sshd_config
