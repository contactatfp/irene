#!/usr/bin/env bash
# Grab the three Qwen-Image-2.1 weight files into a ComfyUI models directory.
#
# Usual flow: attach a network volume to a temporary RunPod pod, run this with
# MODEL_ROOT=/runpod-volume/models, then attach the same volume to the
# serverless endpoint. The worker picks models up from /runpod-volume automatically.
#
#   MODEL_ROOT=/runpod-volume/models ./download-models.sh
#
# some of these repos are gated, so export HF_TOKEN first if a download 401s:
#   export HF_TOKEN=hf_xxx
set -euo pipefail

MODEL_ROOT="${MODEL_ROOT:-/runpod-volume/models}"
HF_TOKEN="${HF_TOKEN:-}"

auth_args=()
if [ -n "$HF_TOKEN" ]; then
  auth_args=(--header "Authorization: Bearer $HF_TOKEN")
fi

dl() {
  local url="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ]; then
    echo "exists, skipping: $dest"
    return
  fi
  echo "downloading -> $dest"
  # -C - resumes partial files, handy for the 9gb text encoder
  curl -fL --retry 3 -C - "${auth_args[@]}" -o "$dest" "$url"
}

dl "https://huggingface.co/abenzerps/Qwen-Image-2.1-Uncensored-GGUF/resolve/main/qwen-image-2.1-UC-Q4_K_M.gguf" \
   "$MODEL_ROOT/diffusion_models/qwen-image-2.1-UC-Q4_K_M.gguf"

dl "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors" \
   "$MODEL_ROOT/text_encoders/qwen3vl_8b_int8_convrot.safetensors"

dl "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors" \
   "$MODEL_ROOT/vae/qwen_image_2.1_vae_bf16.safetensors"

echo ""
echo "done. model dir now holds:"
du -h "$MODEL_ROOT/diffusion_models/qwen-image-2.1-UC-Q4_K_M.gguf" \
      "$MODEL_ROOT/text_encoders/qwen3vl_8b_int8_convrot.safetensors" \
      "$MODEL_ROOT/vae/qwen_image_2.1_vae_bf16.safetensors"
