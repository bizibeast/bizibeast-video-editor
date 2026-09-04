import {runProcess} from "./process.mjs";

export async function probeMedia(path) {
  const result = await runProcess("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  if (result.code !== 0) throw new Error(`ffprobe failed: ${result.stderr.trim()}`);
  const raw = JSON.parse(result.stdout);
  const streams = raw.streams ?? [];
  return {
    raw,
    durationSeconds: Number(raw.format?.duration ?? 0),
    formatName: raw.format?.format_name ?? null,
    sizeBytes: Number(raw.format?.size ?? 0),
    video: streams.filter(({codec_type: type}) => type === "video"),
    audio: streams.filter(({codec_type: type}) => type === "audio"),
  };
}
