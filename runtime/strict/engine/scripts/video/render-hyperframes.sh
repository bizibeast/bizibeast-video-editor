#!/bin/zsh
set -euo pipefail
setopt null_glob

die() {
  print -u2 -- "$*"
  exit 1
}

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

version_of() {
  "$1" --version 2>/dev/null | tail -1 | tr -d '[:space:]'
}

resolve_hyperframes() {
  local candidate package npm_cache repo_root version
  local -a matches
  candidate="$pack/node_modules/hyperframes/bin/hyperframes.mjs"
  if [[ -e "$candidate" ]]; then
    safe_path "$candidate"; candidate="$REPLY"
    [[ -f "$pack/node_modules/hyperframes/package.json" && ! -L "$pack/node_modules/hyperframes/package.json" ]] || die "pack-local HyperFrames package metadata is unsafe"
    version="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version||""))' "$pack/node_modules/hyperframes/package.json")"
    [[ -f "$candidate" && -x "$candidate" && ! -L "$candidate" ]] || die "pack-local HyperFrames executable is unsafe"
    [[ "$version" = "0.8.25" ]] || die "pack-local HyperFrames package must be exactly 0.8.25"
    [[ "$(version_of "$candidate")" = "0.8.25" ]] || die "pack-local HyperFrames must be exactly 0.8.25"
    HF=("$candidate")
    return
  fi
  repo_root="${0:A:h:h:h:h:h:h}"
  candidate="$repo_root/node_modules/hyperframes/bin/hyperframes.mjs"
  package="$repo_root/node_modules/hyperframes/package.json"
  if [[ -f "$candidate" && -x "$candidate" && ! -L "$candidate" && -f "$package" && ! -L "$package" ]]; then
    version="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version||""))' "$package")"
    [[ "$version" = "0.8.25" && "$(version_of "$candidate")" = "0.8.25" ]] || die "repository HyperFrames package must be exactly 0.8.25"
    safe_path "$candidate"; HF=("$REPLY")
    return
  fi
  npm_cache="$(npm config get cache --offline 2>/dev/null)" || npm_cache=""
  if [[ -n "$npm_cache" && "$npm_cache" = /* ]]; then
    for package in "$npm_cache"/_npx/*/node_modules/hyperframes/package.json; do
      [[ -f "$package" && ! -L "$package" ]] || continue
      version="$(node -e 'const p=require(process.argv[1]); process.stdout.write(String(p.version||""))' "$package")"
      [[ "$version" = "0.8.25" ]] || continue
      candidate="${package:h}/bin/hyperframes.mjs"
      safe_path "$candidate"; candidate="$REPLY"
      [[ -f "$candidate" && -x "$candidate" && ! -L "$candidate" ]] || die "installed HyperFrames 0.8.25 executable is unsafe"
      matches+=("${candidate:a}")
    done
  fi
  (( ${#matches} <= 1 )) || die "multiple installed HyperFrames 0.8.25 executables found"
  if (( ${#matches} == 1 )); then
    HF=("$matches[1]")
    return
  fi
  die "HyperFrames 0.8.25 is not installed in a trusted local package root"
}

[[ $# -eq 4 ]] || die "Usage: render-hyperframes.sh <composition> <variables.json> <output.mov> <fps>"

safe_path "$1"; composition="$REPLY"
pack="${composition%%/compositions/*}"
safe_path "$2"; variables="$REPLY"
safe_path "$3"; output="$REPLY"
fps="$4"
codec="${CONTENT_HUB_HF_CODEC:-prores-4444}"
width="${CONTENT_HUB_HF_WIDTH:-}"
height="${CONTENT_HUB_HF_HEIGHT:-}"
duration_ms="${CONTENT_HUB_HF_DURATION_MS:-}"
closure_sha256="${CONTENT_HUB_HF_CLOSURE_SHA256:-}"

[[ "$pack" != "$composition" && -f "$pack/.content-hub-pack-snapshot.json" && ! -L "$pack/.content-hub-pack-snapshot.json" ]] || die "composition must belong to an immutable pack snapshot"
[[ "$closure_sha256" =~ '^[a-f0-9]{64}$' ]] || die "frozen HyperFrames closure hash is required"
[[ "$composition" = "$pack/"* && -f "$composition" && "${composition:e}" = html ]] || die "composition must be a regular HTML file inside the frozen pack snapshot"
composition_relative="${composition#$pack/}"
[[ -f "$variables" && "${variables:e}" = json ]] || die "variables must be a regular JSON file"
[[ "${output:e}" = mov ]] || die "output must be a .mov file"
[[ "$fps" =~ '^[1-9][0-9]*(/[1-9][0-9]*)?$' ]] || die "fps must be a positive integer or rational"
[[ "$codec" = "prores-4444" || "$codec" = "prores-422-hq" ]] || die "codec must be prores-4444 or prores-422-hq"
[[ "$width" =~ '^[1-9][0-9]*$' && "$height" =~ '^[1-9][0-9]*$' && "$duration_ms" =~ '^[1-9][0-9]*$' ]] || die "width, height, and duration contract are required"
duration_seconds="$(awk -v value="$duration_ms" 'BEGIN { printf "%.6f", value / 1000 }')"

project_from_variables="${variables%%/Editors/HyperFrames/*}"
project_from_output="${output%%/Renders/Shots/*}"
[[ "$project_from_variables" != "$variables" && "$project_from_output" != "$output" && "$project_from_variables" = "$project_from_output" ]] || die "variables and output must belong to one project"
[[ ! -e "$output" && ! -L "$output" ]] || die "output already exists"
mkdir -p -- "${output:h}"
safe_path "${output:h}"; output_dir="$REPLY"
[[ "$output_dir" = "$project_from_output/Renders/Shots"* ]] || die "output directory must stay under project Renders/Shots"

stage_dir="$(mktemp -d "$output_dir/.hyperframes.XXXXXX")"
cleanup() { rm -rf -- "$stage_dir"; }
trap cleanup EXIT HUP INT TERM
render_variables="$stage_dir/variables.json"
raw="$stage_dir/raw.mov"
encoded="$stage_dir/output.mov"

node -e '
  const fs=require("node:fs");
  const crypto=require("node:crypto");
  const envelope=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const html=fs.readFileSync(process.argv[8], "utf8");
  const expected={codec:process.argv[3],alpha:process.argv[3]==="prores-4444",width:Number(process.argv[4]),height:Number(process.argv[5]),fps:/^\d+$/.test(process.argv[6])?Number(process.argv[6]):process.argv[6],durationMs:Number(process.argv[7])};
  const canonical=(value)=>value===null||typeof value!=="object"?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(",")}]`:`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  const marker=JSON.parse(fs.readFileSync(process.argv[9],"utf8"));
  if (marker.schemaVersion!==1 || !Array.isArray(marker.closure) || crypto.createHash("sha256").update(canonical(marker.closure)).digest("hex")!==process.argv[10]) throw new Error("pack snapshot closure hash mismatch");
  for (const dependency of marker.closure) {
    if (!/^(?:compositions|assets)\/[A-Za-z0-9][A-Za-z0-9._/\[\],-]*$|^hyperframes\.json$/u.test(dependency.path) || dependency.path.includes("..")) throw new Error("pack snapshot dependency path invalid");
    const bytes=fs.readFileSync(`${process.argv[11]}/${dependency.path}`);
    if (bytes.length!==dependency.bytes || crypto.createHash("sha256").update(bytes).digest("hex")!==dependency.sha256) throw new Error("pack snapshot dependency bytes mismatch");
  }
  const declarationsMatch=html.match(/data-composition-variables=(["'\''])([\s\S]*?)\1/u);
  if (!declarationsMatch) throw new Error("composition variable schema missing");
  const declarations=JSON.parse(declarationsMatch[2]);
  const schema=new Map(declarations.map((item)=>[item.id,item]));
  const variables=envelope.variables;
  const exactKeys=(value,keys)=>value&&typeof value==="object"&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
  if (!exactKeys(envelope,["schemaVersion","jobId","render","layers","variables"]) || envelope.schemaVersion!==1 || typeof envelope.jobId!=="string"
    || JSON.stringify(envelope.render)!==JSON.stringify(expected) || !exactKeys(variables,[...schema.keys()])) throw new Error("variables envelope does not match invocation or declared schema");
  for (const [id,declaration] of schema) {
    const value=variables[id], valid=declaration.type==="string" ? typeof value==="string" : declaration.type==="number" ? Number.isFinite(value)
      : declaration.type==="boolean" ? typeof value==="boolean" : declaration.type==="enum" ? declaration.options.some((option)=>option.value===value) : false;
    if (!valid) throw new Error(`variable ${id} violates declared ${declaration.type} schema`);
  }
  const layerKeys=["id","role","owner","inMs","outMs","entryFrames","staggerFrames","settleFrames","holdFrames","exitFrames","easing","fromScale","toScale","overshoot","content","geometry"];
  const layerBundles=[JSON.parse(variables.backLayer),JSON.parse(variables.foregroundLayer),JSON.parse(variables.captionLayer)];
  for (const [bundleIndex,bundle] of layerBundles.entries()) {
    if (!exactKeys(bundle,["layers"]) || !Array.isArray(bundle.layers)) throw new Error("layer bundle schema invalid");
    for (const layer of bundle.layers) {
      const geometry=layer.geometry, content=layer.content;
      const expectedRole=["back","foreground","caption"][bundleIndex];
      if (!exactKeys(layer,layerKeys) || layer.role!==expectedRole || !Number.isFinite(layer.inMs) || !Number.isFinite(layer.outMs)
        || layer.inMs<0 || layer.outMs<=layer.inMs || !exactKeys(geometry,["x","y","width","height"]) || !Object.values(geometry).every(Number.isFinite)
        || geometry.width<=0 || geometry.height<=0 || !exactKeys(content,["text","asset"]) || typeof content.text!=="string"
        || ![layer.entryFrames,layer.staggerFrames,layer.settleFrames,layer.exitFrames].every(Number.isInteger)
        || (layer.holdFrames!==null&&!Number.isInteger(layer.holdFrames)) || !Number.isFinite(layer.fromScale) || !Number.isFinite(layer.toScale)
        || !Number.isFinite(layer.overshoot) || typeof layer.easing!=="string") throw new Error("approved render layer schema invalid");
      if (content.asset!==null) {
        if (!exactKeys(content.asset,["id","kind","path","sha256","mime","dataUrl"]) || !/^image\/(?:png|jpeg|webp|gif)$/u.test(content.asset.mime)
          || !content.asset.dataUrl.startsWith(`data:${content.asset.mime};base64,`)) throw new Error("approved render asset schema invalid");
        const bytes=Buffer.from(content.asset.dataUrl.slice(content.asset.dataUrl.indexOf(",")+1),"base64");
        if (crypto.createHash("sha256").update(bytes).digest("hex")!==content.asset.sha256) throw new Error("approved render asset bytes do not match frozen hash");
      }
    }
  }
  const captions=JSON.parse(variables.captions);
  if (!Array.isArray(captions.segments) || captions.segments.some((segment)=>!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.end<=segment.start||typeof segment.text!=="string")) throw new Error("canonical caption schema invalid");
  const transparent="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
  if ((variables.showBack && (layerBundles[0].layers[0]?.content.asset?.dataUrl??transparent)!==variables.backAssetUrl)
    || (variables.showForeground && (layerBundles[1].layers[0]?.content.asset?.dataUrl??transparent)!==variables.foregroundAssetUrl)) throw new Error("render asset URL does not match approved frozen layer bytes");
  const renderedLayers=(variables.showCaptions ? layerBundles[2].layers : layerBundles.slice(0,2).flatMap((bundle)=>bundle.layers)).toSorted((a,b)=>a.id.localeCompare(b.id));
  if (JSON.stringify(renderedLayers)!==JSON.stringify([...envelope.layers].toSorted((a,b)=>a.id.localeCompare(b.id)))) throw new Error("assigned layers do not match rendered variables");
  fs.writeFileSync(process.argv[2], JSON.stringify(envelope.variables));
' "$variables" "$render_variables" "$codec" "$width" "$height" "$fps" "$duration_ms" "$composition" "$pack/.content-hub-pack-snapshot.json" "$closure_sha256" "$pack"

node -e '
  const fs=require("node:fs"), path=process.argv[1], duration=process.argv[2];
  const html=fs.readFileSync(path,"utf8");
  const updated=html.replace(/(data-composition-id="bizibeast-layered-shot-v1"[^>]*data-duration=")[^"]+/, `$1${duration}`);
  if (updated===html && !html.includes(`data-duration="${duration}"`)) throw new Error("composition root duration marker missing");
  fs.writeFileSync(path,updated);
' "$pack/index.html" "$duration_seconds"

if grep -RIEq --include='*.html' --include='*.css' '(https?:)?//[^[:space:]"'\''()]+' "$pack/index.html" "$pack/compositions" "$pack/assets"; then
  die "external network references are forbidden in the HyperFrames pack"
fi

resolve_hyperframes
export HYPERFRAMES_NO_TELEMETRY=1
export npm_config_offline=true
export npm_config_update_notifier=false
export NO_UPDATE_NOTIFIER=1

cd "$pack"
${HF[@]} check --strict --snapshots
${HF[@]} render -c index.html -o "$raw" --variables-file "$render_variables" --strict-all --quality high --format mov --fps "$fps"
[[ -s "$raw" ]] || die "HyperFrames render is empty"

if [[ "$codec" = "prores-4444" ]]; then
  ffmpeg -v error -xerror -i "$raw" -map 0:v:0 -an -t "$duration_seconds" -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -movflags +write_colr -f mov "$encoded"
  expected_profile="4444"
  expected_pix_fmt="yuva444p10le"
else
  ffmpeg -v error -xerror -i "$raw" -map 0:v:0 -an -t "$duration_seconds" -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -movflags +write_colr -f mov "$encoded"
  expected_profile="HQ"
  expected_pix_fmt="yuv422p10le"
fi

probe="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,width,height,r_frame_rate:format=duration -of json "$encoded")"
node -e '
  const probe=JSON.parse(process.argv[1]), stream=probe.streams?.[0], duration=Number(probe.format?.duration);
  const fps=process.argv[7].split("/").map(Number), rate=fps[0]/(fps[1]||1), expected=Number(process.argv[8])/1000;
  const actualFps=String(stream?.r_frame_rate||"").split("/").map(Number), actualRate=actualFps[0]/(actualFps[1]||1);
  const pixelFormat=process.argv[3]==="yuva444p10le" ? /^yuva444p(?:10|12)le$/.test(stream?.pix_fmt||"") : stream?.pix_fmt===process.argv[3];
  if (!stream || stream.codec_name!=="prores" || stream.profile!==process.argv[2] || !pixelFormat || stream.width!==Number(process.argv[4]) || stream.height!==Number(process.argv[5]) || actualRate!==rate || !Number.isFinite(duration) || Math.abs(duration-expected)>1/rate+0.001) process.exit(1);
' "$probe" "$expected_profile" "$expected_pix_fmt" "$width" "$height" "$fps" "$fps" "$duration_ms" || {
  print -u2 -r -- "$probe"
  die "rendered sidecar does not match codec, dimensions, fps, or duration contract"
}
ffmpeg -v error -xerror -err_detect explode -i "$encoded" -map 0:v:0 -f null -
if [[ "$codec" = "prores-4444" ]]; then
  alpha_stats="$(ffmpeg -v error -xerror -i "$encoded" -vf 'alphaextract,signalstats,metadata=print:file=-' -f null -)"
  print -r -- "$alpha_stats" | awk -F= '/YMIN=/{if (!seen || $2 < minimum) minimum=$2; seen=1} /YMAX=/{if (!seenmax || $2 > maximum) maximum=$2; seenmax=1} END{exit !(seen && seenmax && maximum > 0 && (maximum - minimum) / maximum >= .02)}' || die "alpha render lacks usable transparent and visible pixels"
fi

ln -- "$encoded" "$output" || die "output appeared during render"
[[ -s "$output" ]] || die "published output is empty"
print -r -- "$probe"
