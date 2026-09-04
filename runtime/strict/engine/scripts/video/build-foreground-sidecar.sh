#!/bin/zsh
set -euo pipefail
setopt null_glob

die() { print -u2 -- "$*"; exit 1; }

safe_path() {
  local path="$1" part current=""
  [[ "$path" = /* ]] || path="$PWD/$path"
  for part in ${(s:/:)path}; do
    [[ -z "$part" ]] && continue
    [[ "$part" = "." || "$part" = ".." ]] && die "path must not contain dot components"
    current="$current/$part"
    [[ -L "$current" ]] && die "symlink paths are not allowed"
  done
  REPLY="${path:a}"
}

[[ $# -eq 4 ]] || die "Usage: build-foreground-sidecar.sh <source> <matte-dir> <fps> <output.mov>"
safe_path "$1"; source_video="$REPLY"
safe_path "$2"; matte_dir="$REPLY"
fps="$3"
safe_path "$4"; output="$REPLY"

[[ -f "$source_video" && ! -L "$source_video" ]] || die "source must be a regular non-symlink file"
[[ -d "$matte_dir" && ! -L "$matte_dir" ]] || die "matte directory must be a non-symlink directory"
[[ "$fps" =~ '^[1-9][0-9]*(/[1-9][0-9]*)?$' ]] || die "fps must be a positive integer or fraction"
[[ "${output:e:l}" = "mov" ]] || die "output must be a .mov file"
[[ ! -e "$output" && ! -L "$output" ]] || die "output already exists"
source_width="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nokey=1:noprint_wrappers=1 "$source_video")"
source_height="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nokey=1:noprint_wrappers=1 "$source_video")"
source_fps="$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nokey=1:noprint_wrappers=1 "$source_video")"
source_frames="$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=nokey=1:noprint_wrappers=1 "$source_video")"
source_duration="$(ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "$source_video")"
[[ "$source_fps" = "$fps" || "$source_fps" = "$fps/1" ]] || die "fps must match the source frame cadence"
[[ "$source_frames" =~ '^[1-9][0-9]*$' ]] || die "source must have a readable video frame count"

matte_files=("$matte_dir"/<->.png)
(( ${#matte_files} )) || die "matte directory has no PNG frames"
(( ${#matte_files} == source_frames )) || die "matte frame count must exactly match source frame count"
integer expected=0
for matte in $matte_files; do
  [[ -f "$matte" && ! -L "$matte" ]] || die "matte frames must be regular non-symlink files"
  printf -v expected_name "%06d.png" "$expected"
  [[ "${matte:t}" = "$expected_name" ]] || die "matte frames must be contiguous six-digit PNGs starting at 000000.png"
  matte_width="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nokey=1:noprint_wrappers=1 "$matte")"
  matte_height="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nokey=1:noprint_wrappers=1 "$matte")"
  [[ "$matte_width" = "$source_width" && "$matte_height" = "$source_height" ]] || die "matte dimensions must match source"
  (( expected += 1 ))
done

output_dir="${output:h}"
mkdir -p -- "$output_dir"
safe_path "$output_dir"; output_dir="$REPLY"
[[ -d "$output_dir" && ! -L "$output_dir" ]] || die "output directory must be a non-symlink directory"

stage_dir="$(mktemp -d "$output_dir/.foreground.XXXXXX")"
cleanup() { rm -rf -- "$stage_dir"; }
trap cleanup EXIT HUP INT TERM

source_before="$(shasum -a 256 "$source_video" | awk '{print $1}')"
matte_manifest_before="$(for matte in $matte_files; do shasum -a 256 "$matte" | awk '{printf "%s", $1}'; done)"
cp -p -- "$source_video" "$stage_dir/source.${source_video:e}"
mkdir "$stage_dir/mattes"
for matte in $matte_files; do
  cp -p -- "$matte" "$stage_dir/mattes/${matte:t}"
done
source_after="$(shasum -a 256 "$source_video" | awk '{print $1}')"
source_snapshot_hash="$(shasum -a 256 "$stage_dir/source.${source_video:e}" | awk '{print $1}')"
[[ "$source_before" = "$source_after" && "$source_before" = "$source_snapshot_hash" ]] || die "source changed while snapshotting"

matte_manifest_after="$(for matte in $matte_files; do shasum -a 256 "$matte" | awk '{printf "%s", $1}'; done)"
matte_snapshot_manifest="$(for matte in "$stage_dir"/mattes/<->.png; do shasum -a 256 "$matte" | awk '{printf "%s", $1}'; done)"
[[ "$matte_manifest_before" = "$matte_manifest_after" && "$matte_manifest_before" = "$matte_snapshot_manifest" ]] || die "mattes changed while snapshotting"
matte_parent_sha256="$(print -rn -- "$matte_manifest_before" | shasum -a 256 | awk '{print $1}')"

source_snapshot="$stage_dir/source.${source_video:e}"
sidecar_stage="$stage_dir/foreground.mov"
ffmpeg -hide_banner -loglevel error -xerror \
  -i "$source_snapshot" -framerate "$fps" -i "$stage_dir/mattes/%06d.png" \
  -filter_complex "[1:v]format=gray[mask];[0:v][mask]alphamerge,format=yuva444p10le[fg]" \
  -map "[fg]" -an -r "$fps" -frames:v "$source_frames" -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le \
  -metadata content_hub_foreground="matte-derived-no-depth" -metadata content_hub_source_sha256="$source_before" \
  -metadata content_hub_matte_sha256="$matte_parent_sha256" -movflags use_metadata_tags -f mov -y "$sidecar_stage"

sidecar_codec="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=nokey=1:noprint_wrappers=1 "$sidecar_stage")"
sidecar_pix_fmt="$(ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt -of default=nokey=1:noprint_wrappers=1 "$sidecar_stage")"
sidecar_width="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nokey=1:noprint_wrappers=1 "$sidecar_stage")"
sidecar_height="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nokey=1:noprint_wrappers=1 "$sidecar_stage")"
sidecar_fps="$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nokey=1:noprint_wrappers=1 "$sidecar_stage")"
sidecar_frames="$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=nokey=1:noprint_wrappers=1 "$sidecar_stage")"
sidecar_duration="$(ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "$sidecar_stage")"
[[ "$sidecar_codec" = prores && "$sidecar_pix_fmt" =~ '^yuva444p(10|12)le$' ]] || die "foreground sidecar is not alpha ProRes 4444"
[[ "$sidecar_width" = "$source_width" && "$sidecar_height" = "$source_height" ]] || die "foreground dimensions do not match source"
[[ "$sidecar_fps" = "$fps" || "$sidecar_fps" = "$fps/1" ]] || die "foreground fps does not match request"
[[ "$sidecar_frames" = "$source_frames" ]] || die "foreground frame count does not match source"
awk -v source="$source_duration" -v sidecar="$sidecar_duration" -v rate="$source_fps" 'BEGIN {split(rate, r, "/"); tolerance = r[2] / r[1] / 2; difference = source - sidecar; if (difference < 0) difference = -difference; exit !(source > 0 && sidecar > 0 && difference <= tolerance)}' \
  || die "foreground duration does not match source"
ffmpeg -v error -xerror -err_detect explode -i "$sidecar_stage" -map 0:v:0 -f null -
alpha_max="$(ffmpeg -v error -xerror -i "$sidecar_stage" -vf alphaextract -f rawvideo - | od -An -tu1 | awk '{for (i = 1; i <= NF; i += 1) if ($i > maximum) maximum = $i} END {print maximum + 0}')"
[[ "$alpha_max" =~ '^[1-9][0-9]*$' ]] || die "foreground alpha is empty or all black"

[[ ! -e "$output" && ! -L "$output" ]] || die "output appeared during render"
ln "$sidecar_stage" "$output" || die "output publication collision"
[[ -f "$output" && ! -L "$output" ]] || die "output publication failed"
