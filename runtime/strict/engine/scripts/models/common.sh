#!/bin/zsh

content_hub_root="${0:A:h:h:h:h:h:h}"
models_root="${BIZIBEAST_MODELS_ROOT:-$content_hub_root/Models}"
export HF_HOME="$models_root/huggingface"
export HF_HUB_CACHE="$HF_HOME/hub"
export HF_HUB_DISABLE_TELEMETRY=1
export HF_HUB_DISABLE_IMPLICIT_TOKEN=1
export HF_XET_HIGH_PERFORMANCE=1
export DO_NOT_TRACK=1
export UV_CACHE_DIR="$models_root/uv-cache"
export UV_PYTHON_INSTALL_DIR="$models_root/python"

audio_python="${BIZIBEAST_AUDIO_PYTHON:-$models_root/venvs/audio/bin/python}"
parakeet_bin="${BIZIBEAST_PARAKEET_BIN:-$models_root/venvs/parakeet/bin/parakeet-mlx}"
mflux_bin="${BIZIBEAST_MFLUX_BIN:-$models_root/venvs/mflux/bin/mflux-generate}"
offline_profile="$content_hub_root/config/no-network.sb"
