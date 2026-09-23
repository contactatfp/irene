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

type RefRoleId = "face" | "outfit" | "pose" | "style" | "scene";

interface RefRole {
  id: RefRoleId;
  label: string;
  hint: string;
  // builds the sentence that binds the model's <imageN> tag to this role
  sentence: (tag: string) => string;
}

const REF_ROLES: RefRole[] = [
  {
    id: "face",
    label: "Face",
    hint: "who to keep",
    sentence: (t) =>
      `${t} is the face reference. Preserve this exact person's identity, facial features, and hairstyle.`,
  },
  {
    id: "outfit",
    label: "Outfit",
    hint: "what they wear",
    sentence: (t) =>
      `${t} shows the outfit. Dress the subject in exactly this clothing, matching colors and details.`,
  },
  {
    id: "pose",
    label: "Pose",
    hint: "how they stand",
    sentence: (t) =>
      `${t} is the pose reference. Match the body position, framing, and camera angle.`,
  },
  {
    id: "style",
    label: "Style",
    hint: "look and light",
    sentence: (t) =>
      `${t} is the style reference. Match its art style, lighting, mood, and color grading.`,
  },
  {
    id: "scene",
    label: "Scene",
    hint: "where it happens",
    sentence: (t) =>
      `${t} is the scene reference. Set the image in this environment, matching its layout and details.`,
  },
];

interface RefImage {
  id: string;
  role: RefRoleId;
  dataUrl: string;
}

// filled buckets in canonical order, each taking the next <imageN> tag.
// numbering stays contiguous no matter which buckets are filled.
function assignRefTags(refs: RefImage[]) {
  return REF_ROLES.flatMap((role) => {
    const ref = refs.find((r) => r.role === role.id);
    return ref ? [{ ref, role }] : [];
  }).map((entry, i) => ({ ...entry, tag: `<image${i + 1}>` }));
}

function buildRefBlock(refs: RefImage[]): string {
  return assignRefTags(refs)
    .map(({ role, tag }) => role.sentence(tag))
    .join(" ");
}

const POLL_MS = 3000;
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

  const refTags = assignRefTags(refs);
  const refBlock = buildRefBlock(refs);

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

  // one image per bucket, replacing whatever was there before
  async function handleRefFiles(role: RefRoleId, files: FileList | null) {
    if (!files || files.length === 0) return;
    try {
      const dataUrl = await fileToDataUrl(files[0]);
      setRefs((prev) => [
        ...prev.filter((r) => r.role !== role),
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          role,
          dataUrl,
        },
      ]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that image.");
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

    // role sentences first, then the user's own description. images go
    // in tag order so <image1> lines up with images[0] on the worker.
    const fullPrompt = refBlock ? `${refBlock}\n\n${prompt.trim()}` : prompt.trim();
    const orderedImages = refTags.map(({ ref }) => ref.dataUrl);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: fullPrompt,
          steps,
          ...(orderedImages.length > 0 ? { images: orderedImages } : {}),
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
            <small>drop one per bucket, the prompt block builds itself</small>
          </span>
          <div className="buckets">
            {REF_ROLES.map((role) => {
              const filled = refTags.find((t) => t.role.id === role.id);
              return (
                <div
                  key={role.id}
                  className={`bucket${filled ? " filled" : ""}`}
                >
                  <span className="bucket-label">
                    {role.label}
                    {filled && <em>{filled.tag}</em>}
                  </span>
                  {filled ? (
                    <span className="bucket-thumb">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={filled.ref.dataUrl}
                        alt={`${role.label} reference`}
                      />
                      <button
                        type="button"
                        className="ref-remove"
                        aria-label={`Remove ${role.label} reference`}
                        disabled={submitting}
                        onClick={() =>
                          setRefs((prev) =>
                            prev.filter((r) => r.role !== role.id)
                          )
                        }
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <label className="bucket-add">
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        hidden
                        disabled={submitting}
                        onChange={(e) => {
                          handleRefFiles(role.id, e.target.files);
                          // let the same file be picked again after removing it
                          e.target.value = "";
                        }}
                      />
                      <span>+</span>
                      <small>{role.hint}</small>
                    </label>
                  )}
                </div>
              );
            })}
          </div>
          {refBlock && (
            <div className="ref-preview">
              <small>Built prompt block</small>
              <p>{refBlock}</p>
            </div>
          )}
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
