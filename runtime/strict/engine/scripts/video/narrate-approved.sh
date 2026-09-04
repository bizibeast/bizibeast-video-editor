#!/bin/zsh
set -euo pipefail

if [[ $# -ne 6 ]]; then
  print -u2 "Usage: narrate-approved.sh <project-dir> <voice-asset-id> <script.md> <reference.wav> <reference.txt> <output.wav>"
  exit 1
fi

no_symlink_path() {
  local path="$1"
  [[ "$path" = /* ]] || return 1
  while [[ "$path" != "/" ]]; do
    [[ -L "$path" ]] && return 1
    path="${path:h}"
  done
}

no_symlink_path "$1" && no_symlink_path "$3" && no_symlink_path "$4" && no_symlink_path "$5" && no_symlink_path "$6" \
  || { print -u2 "Narration paths cannot contain symlinks"; exit 1; }

script_dir="${0:A:h}"
content_hub_root="${script_dir:h:h}"
project="${1:A}"
asset_id="$2"
script="${3:A}"
reference_audio="${4:A}"
reference_text="${5:A}"
output="${6:A}"

[[ -d "$project" && -f "$script" && -f "$reference_audio" && -f "$reference_text" ]] || { print -u2 "Narration inputs must be regular local files"; exit 1; }
[[ "$output" == "$project/"* ]] || { print -u2 "Narration output must stay under the project directory"; exit 1; }
[[ ! -e "$output" && ! -L "$output" ]] || { print -u2 "Narration output already exists"; exit 1; }

output_dir="${output:h}"
mkdir -p "$output_dir"
scratch="$(mktemp -d "$output_dir/.qwen-narration.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT

"$content_hub_root/scripts/models/qwen-voice.sh" \
  "$project" "$asset_id" "$script" "$reference_audio" "$reference_text" "$scratch"
generated=("$scratch"/*.wav(N))
if [[ ${#generated} -ne 1 ]]; then
  print -u2 "Qwen must produce exactly one joined WAV; found ${#generated}"
  exit 2
fi

normalized="$scratch/normalized.wav"
ffmpeg -hide_banner -loglevel error -n -i "$generated[1]" -vn -ar 48000 -ac 1 -c:a pcm_s24le "$normalized"
ln "$normalized" "$output"
