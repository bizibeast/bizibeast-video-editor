#!/bin/zsh
set -euo pipefail
exec /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*) (allow network-bind) (allow network-inbound (local ip "localhost:*")) (allow network-outbound (remote ip "localhost:*"))' "$@"
