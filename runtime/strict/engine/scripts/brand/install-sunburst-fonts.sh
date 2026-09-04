#!/bin/zsh
set -euo pipefail

brand_root="${0:A:h:h:h}/Brand/Sunburst"
commit="45b0855d499c093e4d1bd08926fec4e1a582e225"

mkdir -p "$brand_root/Fonts" "$brand_root/Licences"

curl -fsSL "https://raw.githubusercontent.com/google/fonts/$commit/ofl/fraunces/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf" -o "$brand_root/Fonts/Fraunces[SOFT,WONK,opsz,wght].ttf"
curl -fsSL "https://raw.githubusercontent.com/google/fonts/$commit/ofl/archivo/Archivo%5Bwdth%2Cwght%5D.ttf" -o "$brand_root/Fonts/Archivo[wdth,wght].ttf"
curl -fsSL "https://raw.githubusercontent.com/google/fonts/$commit/ofl/fraunces/OFL.txt" -o "$brand_root/Licences/Fraunces-OFL.txt"
curl -fsSL "https://raw.githubusercontent.com/google/fonts/$commit/ofl/archivo/OFL.txt" -o "$brand_root/Licences/Archivo-OFL.txt"

check_hash() {
  local expected="$1"
  local file="$2"
  local actual
  actual="$(shasum -a 256 "$file" | cut -d ' ' -f 1)"
  [[ "$actual" == "$expected" ]] || {
    print -u2 "SHA-256 mismatch $file"
    exit 1
  }
}

check_hash "177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb" "$brand_root/Fonts/Fraunces[SOFT,WONK,opsz,wght].ttf"
check_hash "0e094a7d3c7c4c25cf1310c4b30014f1dae9332220b1c2c88f4fa996f0b05053" "$brand_root/Fonts/Archivo[wdth,wght].ttf"
check_hash "bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b" "$brand_root/Licences/Fraunces-OFL.txt"
check_hash "108b4e57c9c796d3d38d0428ca7ee39de47ad93187302718d9b2d8864b9b716b" "$brand_root/Licences/Archivo-OFL.txt"
