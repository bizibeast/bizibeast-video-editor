# Local media

Probe every source with FFprobe before editing. Reject files that cannot fully decode. For multiple clips, start with capture timestamps and filenames, then use transcripts and visible continuity to determine story order.

Transcribe on-device with the user's installed engine. Prefer Parakeet for English word timing; Whisper-compatible local tools are acceptable. Store the transcript in `Plans/` and do not send it to a hosted API.

Voice-over flow: approve the script, then obtain explicit authorization from the voice subject before any cloning. Use an installed local Qwen TTS or equivalent model. Save both narration and its post-generation transcript in the project.

Search `Assets/` before generating or downloading anything. Record source and licence for downloaded reusable assets. Image generation may use an inbuilt generator only when the user permits that service; otherwise use a local model. Music, voice and SFX default to on-device tools.

Dialogue remains primary. Duck music under speech, avoid repetitive SFX, and preserve intentional dramatic pauses even when silence removal is aggressive.
