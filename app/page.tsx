"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type JobStatus = "queued" | "running" | "complete" | "failed";

interface HistoryItem {
  jobId: string;
  prompt: string;
  status: JobStatus;
  imageUrl: string | null;
  createdAt: string;
}

const POLL_MS = 3000;

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [steps, setSteps] = useState(25);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/generate");
      if (!res.ok) return;
      const data = (await res.json()) as { generations: HistoryItem[] };
      setHistory(data.generations ?? []);
    } catch {
      // history is a nice-to-have, don't blow up the page if it fails
    }
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const pollStatus = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/generate/${id}`);
        const data = (await res.json()) as {
          status?: JobStatus;
          imageUrl?: string | null;
          error?: string;
        };
        if (!res.ok) {
          // 502 means runpod hiccup, keep polling. anything else is fatal.
          if (res.status === 502) return;
          throw new Error(data.error ?? "Failed to check job status.");
        }
        if (data.status) setStatus(data.status);
        if (data.status === "complete") {
          stopPolling();
          setSubmitting(false);
          setImageUrl(data.imageUrl ?? null);
          refreshHistory();
        } else if (data.status === "failed") {
          stopPolling();
          setSubmitting(false);
          setError(data.error ?? "Generation failed.");
          refreshHistory();
        }
      } catch (err) {
        stopPolling();
        setSubmitting(false);
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    },
    [refreshHistory, stopPolling]
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !prompt.trim()) return;

    stopPolling();
    setSubmitting(true);
    setError(null);
    setImageUrl(null);
    setStatus(null);
    setJobId(null);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), steps }),
      });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) {
        throw new Error(data.error ?? "Failed to start generation.");
      }
      setJobId(data.jobId);
      setStatus("queued");
      // immediate check, then keep polling until it lands
      await pollStatus(data.jobId);
      timer.current = setInterval(() => pollStatus(data.jobId!), POLL_MS);
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  const busy = submitting || status === "queued" || status === "running";

  return (
    <main className="wrap">
      <h1>AI Image Generator</h1>
      <p className="sub">
        Qwen-Image-2.1 running on a RunPod GPU. First request after idle can
        take a few minutes while a worker wakes up.
      </p>

      <form onSubmit={handleSubmit} className="card">
        <label htmlFor="prompt">Describe your image</label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A cyberpunk city at sunset..."
          rows={4}
          maxLength={2000}
          disabled={submitting}
        />
        <div className="row">
          <span>Resolution: 1024 × 1024</span>
          <label className="steps">
            Steps
            <input
              type="number"
              min={1}
              max={40}
              value={steps}
              disabled={submitting}
              onChange={(e) => setSteps(Number(e.target.value))}
            />
          </label>
        </div>
        <button type="submit" disabled={busy || !prompt.trim()}>
          {busy ? "Generating..." : "Generate"}
        </button>
      </form>

      {status && (
        <p className="status" role="status">
          {status === "queued" && "Queued — waiting for a GPU worker..."}
          {status === "running" && "Running — the GPU is painting pixels..."}
          {status === "complete" && "Done."}
          {status === "failed" && "Failed."}
          {jobId && <span className="jobid"> job {jobId.slice(0, 8)}…</span>}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {imageUrl && (
        <figure className="card result">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt={prompt} />
          <figcaption>
            <a href={imageUrl} download={`irene-${jobId ?? "image"}.png`}>
              Download
            </a>
          </figcaption>
        </figure>
      )}

      {history.length > 0 && (
        <section className="history">
          <h2>Recent</h2>
          <ul>
            {history.map((h) => (
              <li key={h.jobId}>
                {h.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={h.imageUrl} alt="" width={72} height={72} />
                ) : (
                  <span className="thumb empty">{h.status}</span>
                )}
                <div>
                  <p>{h.prompt}</p>
                  <small>
                    {h.status} · {new Date(h.createdAt).toLocaleString()}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
