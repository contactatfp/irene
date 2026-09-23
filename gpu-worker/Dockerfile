# Qwen-Image-2.1 GGUF worker for RunPod Serverless.
# Build context is this directory (gpu-worker/).
FROM runpod/worker-comfyui:5.8.4-base

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
COPY handler.py /handler.py
COPY workflow_api.json /workflow_api.json

CMD ["/start.sh"]
