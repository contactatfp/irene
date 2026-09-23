import { NextResponse } from "next/server";
import { getGeneration, updateGeneration } from "@/lib/db";
import {
  extractImageUrl,
  getRunPodJobStatus,
  hasRunPodConfig,
  type RunPodStatus,
} from "@/lib/runpod";

export const runtime = "nodejs";

function mapStatus(status: RunPodStatus) {
  switch (status) {
    case "IN_QUEUE":
      return "queued" as const;
    case "IN_PROGRESS":
    case "RUNNING":
      return "running" as const;
    case "COMPLETED":
      return "complete" as const;
    case "FAILED":
    case "CANCELLED":
    case "TIMED_OUT":
      return "failed" as const;
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const row = getGeneration(jobId);
  if (!row) {
    return NextResponse.json({ error: "Unknown job id." }, { status: 404 });
  }

  // terminal states are cached in sqlite, no need to hit runpod again
  if (row.status === "complete" || row.status === "failed") {
    return NextResponse.json({
      jobId: row.job_id,
      status: row.status,
      imageUrl: row.image_url,
      error: row.error,
      prompt: row.prompt,
      generationTimeMs: row.generation_time_ms,
    });
  }

  if (!hasRunPodConfig()) {
    return NextResponse.json(
      { error: "Server is missing RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID." },
      { status: 500 }
    );
  }

  try {
    const job = await getRunPodJobStatus(jobId);
    const status = mapStatus(job.status);

    if (status === "complete") {
      const imageUrl = extractImageUrl(job.output);
      if (!imageUrl) {
        const updated = updateGeneration(jobId, {
          status: "failed",
          error: "RunPod job completed but returned no image.",
        });
        return NextResponse.json({
          jobId,
          status: "failed",
          error: updated?.error,
          prompt: row.prompt,
        });
      }
      const updated = updateGeneration(jobId, { status, image_url: imageUrl });
      return NextResponse.json({
        jobId,
        status,
        imageUrl,
        prompt: row.prompt,
        generationTimeMs: updated?.generation_time_ms ?? null,
      });
    }

    if (status === "failed") {
      const message =
        job.error ??
        (job.status === "TIMED_OUT"
          ? "Job timed out waiting for a GPU worker."
          : job.status === "CANCELLED"
            ? "Job was cancelled."
            : "Generation failed on the GPU worker.");
      const updated = updateGeneration(jobId, { status, error: message });
      return NextResponse.json({
        jobId,
        status,
        error: updated?.error,
        prompt: row.prompt,
      });
    }

    // still in flight — persist the latest phase so history looks alive
    if (row.status !== status) updateGeneration(jobId, { status });
    return NextResponse.json({ jobId, status, prompt: row.prompt });
  } catch (err) {
    // don't wipe the local row on a transient runpod hiccup, just report it
    return NextResponse.json(
      {
        jobId,
        status: row.status,
        prompt: row.prompt,
        warning:
          err instanceof Error ? err.message : "Failed to reach RunPod.",
      },
      { status: 502 }
    );
  }
}
