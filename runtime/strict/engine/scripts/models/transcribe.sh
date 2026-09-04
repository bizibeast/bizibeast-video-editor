#!/bin/zsh
set -euo pipefail

if [[ $# -ne 2 ]]; then
  print -u2 "Usage: transcribe.sh <input-media> <output-directory>"
  exit 1
fi

repo_root="${0:A:h:h:h:h:h:h}"
input="${1:A}"
output="${2:A}"
mkdir -p "$output"
exec node "$repo_root/scripts/transcribe.mjs" "$input" "$output/transcript.json"
