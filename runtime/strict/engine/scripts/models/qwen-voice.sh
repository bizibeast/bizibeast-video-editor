#!/bin/zsh
set -euo pipefail
source "${0:A:h}/common.sh"

if [[ $# -ne 6 ]]; then
  print -u2 "Usage: qwen-voice.sh <project-directory> <authorized-asset-id> <text-file> <reference-audio> <reference-transcript-file> <output-directory>"
  exit 1
fi
project="${1:A}"
asset_id="$2"
text="$(<"${3:A}")"
reference_audio="${4:A}"
reference_text="$(<"${5:A}")"
output="${6:A}"
model="$models_root/snapshots/voice-clone"
mkdir -p "$output"

node "$content_hub_root/runtime/strict/engine/scripts/models/verify-voice.mjs" "$project" "$asset_id" "$reference_audio"

export HF_HUB_OFFLINE=1
exec /usr/bin/sandbox-exec -f "$offline_profile" "$audio_python" -m mlx_audio.tts.generate \
  --model "$model" --text "$text" --ref_audio "$reference_audio" --ref_text "$reference_text" \
  --output_path "$output" --file_prefix voice --audio_format wav --join_audio
