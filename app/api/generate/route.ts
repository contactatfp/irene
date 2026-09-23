import { NextResponse } from "next/server";
import {
  createGeneration,
  listRecentGenerations,
} from "@/lib/db";
import { hasRunPodConfig, submitRunPodJob } from "@/lib/runpod";

export const runtime = "nodejs";

const WIDTH = 1024;
const HEIGHT = 1024;
const DEFAULT_STEPS = 25;
const MAX_PROMPT = 2000;

// recent history for the page. newest first.
export async function GET() {
  try {
    const rows = listRecentGenerations(12);
    return NextResponse.json({
      generations: rows.map((r) => ({
        jobId: r.job_id,
        prompt: r.prompt,
        status: r.status,
        imageUrl: r.image_url,
        error: r.error,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load history." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const { prompt, steps } = (body ?? {}) as { prompt?: unknown; steps?: unknown };

  if (typeof prompt !== "string" || !prompt.trim()) {
    return NextResponse.json({ error: "prompt is required." }, { status: 400 });
  }
  const cleanPrompt = prompt.trim();
  if (cleanPrompt.length > MAX_PROMPT) {
    return NextResponse.json(
      { error: `prompt must be ${MAX_PROMPT} characters or fewer.` },
      { status: 400 }
    );
  }

  // steps is optional, clamp it so a typo can't queue a 500-step job
  let parsedSteps = DEFAULT_STEPS;
  if (steps !== undefined) {
    const n = typeof steps === "string" ? Number(steps) : steps;
    if (typeof n !== "number" || !Number.isFinite(n)) {
      return NextResponse.json({ error: "steps must be a number." }, { status: 400 });
    }
    parsedSteps = Math.min(40, Math.max(1, Math.round(n)));
  }

  if (!hasRunPodConfig()) {
    return NextResponse.json(
      {
        error:
          "Server is missing RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID. Copy .env.example to .env.local and fill them in.",
      },
      { status: 500 }
    );
  }

  try {
    const { id } = await submitRunPodJob({
      prompt: cleanPrompt,
      width: WIDTH,
      height: HEIGHT,
      steps: parsedSteps,
    });

    // record it locally before returning, so polling + history work even if runpod is slow
    createGeneration({
      jobId: id,
      prompt: cleanPrompt,
      width: WIDTH,
      height: HEIGHT,
      steps: parsedSteps,
    });

    return NextResponse.json({ jobId: id });
  } catch (err) {
    // runpod down / bad key / bad endpoint id all land here
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to submit job to RunPod.",
      },
      { status: 502 }
    );
  }
}
