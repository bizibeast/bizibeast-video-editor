#!/bin/zsh
set -euo pipefail

if [[ $# -ne 1 ]]; then
  print -u2 "Usage: create-fixture.sh <output.mp4>"
  exit 1
fi
output="${1:A}"
mkdir -p "${output:h}"

exec ffmpeg -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=640x360:rate=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 3 \
  -filter_complex "[0:v]drawbox=x='mod(t*120,560)':y=145:w=80:h=70:color=yellow@0.85:t=fill,format=yuv420p[v];[1:a]volume=0.2[a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -shortest -movflags +faststart -y "$output"
