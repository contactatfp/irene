"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type JobStatus = "queued" | "running" | "complete" | "failed";

interface HistoryItem {
  jobId: string;
  prompt: string;
  status: JobStatus;
  imageUrl: string | null;
  error: string | null;
  refCount: number;
  createdAt: string;
}

interface RefImage {
  id: string;
  dataUrl: string;
}

const POLL_MS = 3000;
const MAX_REFS = 3;
const REF_MAX_DIM = 1024;

// shrink uploads to 1024px so the runpod payload stays small. the worker's
// encoder resizes to ~1024 anyway, and png keeps alpha for RGBA refs.
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, REF_MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return file.type === "image/png"
    ? canvas.toDataURL("image/png")
    : canvas.toDataURL("image/jpeg", 0.85);
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [steps, setSteps] = useState(25);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [refs, setRefs] = useState<RefImage[]>([]);
  const [expanded, setExpanded] = useState<HistoryItem | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

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

  // esc closes the expanded view
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  async function handleRefFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const room = MAX_REFS - refs.length;
    if (room <= 0) {
      setError(`Up to ${MAX_REFS} reference images per job.`);
      return;
    }
    const picked = Array.from(files).slice(0, room);
    try {
      const converted = await Promise.all(picked.map(fileToDataUrl));
      setRefs((prev) => [
        ...prev,
        ...converted.map((dataUrl) => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          dataUrl,
        })),
      ].slice(0, MAX_REFS));
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not read those images."
      );
    } finally {
      // let the same file be picked again after removing it
      if (fileInput.current) fileInput.current.value = "";
    }
  }

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
        body: JSON.stringify({
          prompt: prompt.trim(),
          steps,
          ...(refs.length > 0
            ? { images: refs.map((r) => r.dataUrl) }
            : {}),
        }),
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
        <div className="refs">
          <span className="refs-label">
            Reference images{" "}
            <small>
              optional, up to {MAX_REFS} · name them in your prompt with
              &lt;image1&gt;, &lt;image2&gt;…
            </small>
          </span>
          <div className="ref-thumbs">
            {refs.map((r, i) => (
              <span key={r.id} className="ref-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={r.dataUrl} alt={`Reference ${i + 1}`} />
                <button
                  type="button"
                  className="ref-remove"
                  aria-label={`Remove reference ${i + 1}`}
                  disabled={submitting}
                  onClick={() =>
                    setRefs((prev) => prev.filter((x) => x.id !== r.id))
                  }
                >
                  ×
                </button>
              </span>
            ))}
            {refs.length < MAX_REFS && (
              <label className="ref-add">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  hidden
                  disabled={submitting}
                  onChange={(e) => handleRefFiles(e.target.files)}
                />
                + Add
              </label>
            )}
          </div>
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
        <pre className="error" role="alert">
          {error}
        </pre>
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
                  <button
                    type="button"
                    className="thumb-btn"
                    onClick={() => setExpanded(h)}
                    aria-label="Expand image"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={h.imageUrl} alt="" width={72} height={72} />
                  </button>
                ) : (
                  <span className="thumb empty">{h.status}</span>
                )}
                <div className="history-body">
                  <p>{h.prompt}</p>
                  <small>
                    {h.status} · {new Date(h.createdAt).toLocaleString()}
                    {h.refCount > 0 &&
                      ` · ${h.refCount} ref${h.refCount === 1 ? "" : "s"}`}
                  </small>
                  {h.error && <pre className="error history-error">{h.error}</pre>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {expanded?.imageUrl && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded generation"
          onClick={() => setExpanded(null)}
        >
          <div
            className="lightbox-inner"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={expanded.imageUrl} alt={expanded.prompt} />
            <p>{expanded.prompt}</p>
            <small>
              {expanded.status} ·{" "}
              {new Date(expanded.createdAt).toLocaleString()}
              {expanded.refCount > 0 &&
                ` · ${expanded.refCount} ref${expanded.refCount === 1 ? "" : "s"}`}
            </small>
            <div className="lightbox-actions">
              <a
                href={expanded.imageUrl}
                download={`irene-${expanded.jobId}.png`}
              >
                Download
              </a>
              <button type="button" onClick={() => setExpanded(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
