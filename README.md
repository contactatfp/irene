# Irene — AI image generator

Local-first Next.js app that generates images with Qwen-Image-2.1 (GGUF) on a
RunPod Serverless GPU. The browser talks only to Next.js; Next.js holds the
RunPod key, tracks jobs in SQLite, and polls RunPod until each PNG lands in
Cloudflare R2.

## Web app

```bash
npm install
cp .env.example .env.local   # fill in RUNPOD_API_KEY + RUNPOD_ENDPOINT_ID
npm run dev                  # http://localhost:3000
```

- `POST /api/generate` takes `{ prompt, steps? }`, returns `{ jobId }`.
- `GET /api/generate/[jobId]` returns `queued | running | complete | failed`.
- History lives in `data/generations.db` (gitignored, `SQLITE_PATH` overrides it).

## GPU worker (`gpu-worker/`)

1. Put the weights on a RunPod network volume from a temp pod:
   `MODEL_ROOT=/runpod-volume/models ./gpu-worker/download-models.sh`
   (~15 GB: Q4_K_M GGUF + INT8 text encoder + VAE).
2. Create a Serverless endpoint from `gpu-worker/` (Dockerfile): 24 GB GPU,
   Flex, min workers 0, max workers 1, FlashBoot on, idle timeout 5s, and an
   execution timeout generous enough for a cold start plus the generation.
   Attach the same network volume.
3. Worker env vars: `BUCKET_ENDPOINT_URL`, `BUCKET_ACCESS_KEY_ID`,
   `BUCKET_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL`. Without them the worker
   returns the PNG as inline base64 instead of uploading.

## Notes

- Qwen-Image-2.1 weights are under the Qwen Research License
  (non-commercial unless you get a separate license), and the GGUF build has
  no safety checker. Fine for local/dev; add safeguards + licensing before
  going public or charging.
