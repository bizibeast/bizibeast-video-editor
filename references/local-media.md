# Local media

Probe every source with FFprobe before editing. Reject files that cannot fully decode. For multiple clips, start with capture timestamps and filenames, then use transcripts and visible continuity to determine story order.

Transcribe on-device with the user's installed engine. Prefer Parakeet for English word timing; Whisper-compatible local tools are acceptable. Store the transcript in `Plans/` and do not send it to a hosted API.

Use `scripts/ingest.mjs` for copy-and-hash ingest and `scripts/find-assets.mjs` for project/shared-library lookup. Configure transcription as a JSON argv array so no shell is involved, for example `BIZIBEAST_TRANSCRIBE_COMMAND='["local-transcriber","--input","{input}","--output","{output}"]'`, then run `scripts/transcribe.mjs`. Optional subject analysis uses the same contract in `BIZIBEAST_SUBJECT_COMMAND`; when unavailable, it fails closed and the design must use face-safe foreground placement.

Voice-over flow: approve the script, then obtain explicit authorization from the voice subject before any cloning. Use an installed local Qwen TTS or equivalent model. Save both narration and its post-generation transcript in the project.

Search `Assets/` before generating or downloading anything. Record source and licence for downloaded reusable assets. Image generation may use an inbuilt generator only when the user permits that service; otherwise use a local model. Music, voice and SFX default to on-device tools.

Dialogue remains primary. Duck music under speech, avoid repetitive SFX, and preserve intentional dramatic pauses even when silence removal is aggressive.
