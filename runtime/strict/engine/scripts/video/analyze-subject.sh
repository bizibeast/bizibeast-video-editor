#!/bin/zsh
set -euo pipefail

if [[ $# -ne 5 ]]; then
  print -u2 "Usage: analyze-subject.sh <source-video> <source-sha256> <output.json> <matte-dir|-> <sample-fps>"
  exit 1
fi

repo_root="${0:A:h:h:h}"
source_file="$repo_root/scripts/vision/SubjectAnalyzer.swift"
source_video="${1:A}"
output="${3:A}"
matte_dir="$4"
[[ "$matte_dir" == "-" ]] || matte_dir="${matte_dir:A}"
mkdir -p "${output:h}"

temp_root="${TMPDIR:-/tmp}"
temp_root="${temp_root%/}"
build_dir="$(mktemp -d "$temp_root/content-hub-subject.XXXXXX")"
chmod 700 "$build_dir"
trap '/bin/rm -rf -- "$build_dir"' EXIT HUP INT TERM
binary="$build_dir/SubjectAnalyzer"
mkdir "$build_dir/clang-cache" "$build_dir/swift-cache"
CLANG_MODULE_CACHE_PATH="$build_dir/clang-cache" SWIFT_MODULECACHE_PATH="$build_dir/swift-cache" \
  /usr/bin/xcrun swiftc -O -framework AVFoundation -framework Vision -framework CoreImage -framework AppKit "$source_file" -o "$binary"
chmod 700 "$binary"

"$binary" "$source_video" "$2" "$output" "$matte_dir" "$5"
