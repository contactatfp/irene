// thin wrapper around the runpod serverless v2 api. just /run + /status, nothing fancy.

export interface RunPodJobInput {
  prompt: string;
  width: number;
  height: number;
  steps: number;
  // optional reference images as data URLs, forwarded to the worker as-is
  images?: string[];
}

export type RunPodStatus =
  | "IN_QUEUE"
  | "IN_PROGRESS"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export interface RunPodStatusResponse {
  id: string;
  status: RunPodStatus;
  output?: unknown;
  error?: string;
  delayTime?: number;
  executionTime?: number;
}

function config() {
  const apiKey = process.env.RUNPOD_API_KEY;
  const endpointId = process.env.RUNPOD_ENDPOINT_ID;
  if (!apiKey || !endpointId) {
    throw new Error(
      "Server is missing RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID. copy .env.example to .env.local and fill them in."
    );
  }
  return {
    apiKey,
    baseUrl: `https://api.runpod.ai/v2/${endpointId}`,
  };
}

export function hasRunPodConfig(): boolean {
  return Boolean(process.env.RUNPOD_API_KEY && process.env.RUNPOD_ENDPOINT_ID);
}

async function runpodFetch(path: string, init: RequestInit) {
  const { apiKey, baseUrl } = config();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // runpod usually returns json, but keep the raw text if it doesn't
    body = { raw: text };
  }
  if (!res.ok) {
    const msg =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `RunPod request failed with HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// fire off an async job, get back a job id to poll
export async function submitRunPodJob(
  input: RunPodJobInput
): Promise<{ id: string }> {
  const body = (await runpodFetch("/run", {
    method: "POST",
    body: JSON.stringify({ input }),
  })) as { id: string };
  if (!body?.id) throw new Error("RunPod /run response did not include a job id.");
  return { id: body.id };
}

export async function getRunPodJobStatus(
  jobId: string
): Promise<RunPodStatusResponse> {
  const body = (await runpodFetch(`/status/${jobId}`, {
    method: "GET",
  })) as RunPodStatusResponse;
  return body;
}

// our worker returns { image_url } but handle the official worker shape too
// (output.images[0] as s3_url or base64) so either handler works.
export function extractImageUrl(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const out = output as Record<string, unknown>;

  if (typeof out.image_url === "string" && out.image_url) return out.image_url;
  if (typeof out.imageUrl === "string" && out.imageUrl) return out.imageUrl;

  const images = out.images;
  if (Array.isArray(images) && images.length > 0) {
    const first = images[0] as Record<string, unknown>;
    if (typeof first?.data === "string" && first.data) {
      if (first.type === "base64") return `data:image/png;base64,${first.data}`;
      return first.data;
    }
    if (typeof first?.url === "string" && first.url) return first.url;
  }
  return null;
}
