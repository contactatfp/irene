# Qwen-Image-2.1 GGUF worker for RunPod Serverless.
# RunPod's GitHub builder uses the repo root as the build context and
# this file as --file gpu-worker/Dockerfile, so COPY paths start at the root.
FROM runpod/worker-comfyui:5.8.4-base

# The base image's ComfyUI predates Qwen-Image 2.1. TextEncodeQwenImage21
# was added in v0.37.0, and the workflow fails to queue without it.
RUN git -C /comfyui fetch --depth 1 https://github.com/Comfy-Org/ComfyUI.git refs/tags/v0.37.0:refs/tags/v0.37.0 \
    && git -C /comfyui checkout v0.37.0 \
    && uv pip install -r /comfyui/requirements.txt \
    && uv pip install "transformers>=4.50.3,<5" "huggingface-hub<1.0"

# the leejet fork has native Qwen-Image 2.1 support. the older city96 fork
# fails with "Unknown model architecture!", so clone this one explicitly
# instead of going through the comfy registry.
RUN git clone --depth 1 https://github.com/leejet/ComfyUI-GGUF.git /comfyui/custom_nodes/ComfyUI-GGUF \
    && uv pip install -r /comfyui/custom_nodes/ComfyUI-GGUF/requirements.txt

# boto3 for the R2 upload in handler.py. pinned below 1.40 because newer
# versions break auth against S3-compatible endpoints (R2, GCS).
RUN uv pip install "boto3<1.40"

# Replace the stock handler with ours: fixed workflow, prompt patched in per
# job. client-supplied workflow graphs are intentionally not accepted.
COPY gpu-worker/handler.py /handler.py
COPY gpu-worker/workflow_api.json /workflow_api.json
COPY gpu-worker/extra_model_paths.yaml /comfyui/extra_model_paths.yaml

CMD ["/start.sh"]
