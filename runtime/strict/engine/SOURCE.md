# Engine provenance

This directory is the committed BiziBeast production engine extracted from source commit `043d57f9b9d90e014ce83e5ede605d17fbbe2695`.

The public bundle makes only portability changes: it resolves the shared HyperFrames pack relative to this repository, uses the dependency-free layered composition, locates the pinned repository HyperFrames package, and routes local transcription through the public validated adapter. Machine-specific integration and model-download wrappers are excluded. The original source modules, CLI, native file-lock helper, and tests are otherwise retained.
