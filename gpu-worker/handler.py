"""RunPod serverless handler: Qwen-Image-2.1 GGUF text-to-image via local ComfyUI.

Expects {"input": {"prompt": str, "width": 1024, "height": 1024, "steps": 25}}.
Patches those into the fixed workflow, queues it on the ComfyUI instance that
start.sh boots alongside this handler, uploads the PNG to R2, and returns
{"image_url": ...}. Arbitrary client workflows are not accepted on purpose.
"""

import base64
import copy
import json
import os
import random
import time
import uuid
from urllib.parse import urlparse

import requests
import runpod

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW_PATH = os.path.join(HERE, "workflow_api.json")

COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1")
COMFY_PORT = int(os.environ.get("COMFY_PORT", "8188"))
COMFY_BASE = f"http://{COMFY_HOST}:{COMFY_PORT}"

# how long to wait for comfy to boot / for one generation to finish
COMFY_BOOT_TIMEOUT_S = int(os.environ.get("COMFY_BOOT_TIMEOUT_S", "600"))
GENERATION_TIMEOUT_S = int(os.environ.get("GENERATION_TIMEOUT_S", "1500"))

with open(WORKFLOW_PATH, "r", encoding="utf-8") as f:
    WORKFLOW_TEMPLATE = json.load(f)


def log(msg):
    print(f"irene-worker - {msg}", flush=True)


def wait_for_comfy():
    # start.sh boots comfy in the background, so it might not be up yet when
    # the first job lands. poll until it answers or we run out of patience.
    deadline = time.time() + COMFY_BOOT_TIMEOUT_S
    while time.time() < deadline:
        try:
            r = requests.get(f"{COMFY_BASE}/system_stats", timeout=5)
            if r.ok:
                log("ComfyUI is up")
                return
        except requests.RequestException:
            pass
        time.sleep(2)
    raise RuntimeError(
        f"ComfyUI at {COMFY_BASE} never came up "
        f"within {COMFY_BOOT_TIMEOUT_S}s."
    )


def list_volume_models():
    # so a "not in []" error shows whether the volume mounted and where the files landed
    root = "/runpod-volume/models"
    if not os.path.isdir(root):
        return [f"{root} is not mounted"]
    found = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            if name.startswith("."):
                continue
            found.append(os.path.relpath(os.path.join(dirpath, name), root))
    found.sort()
    if not found:
        return [f"{root} is mounted but empty"]
    shown = found[:40]
    if len(found) > len(shown):
        shown.append(f"... {len(found) - len(shown)} more")
    return shown


def explain_comfy_rejection(body):
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return body[:8000]
    err = payload.get("error") or {}
    lines = []
    if err.get("message"):
        lines.append(str(err["message"]))
    if err.get("details"):
        lines.append(str(err["details"]))
    for node_id, info in (payload.get("node_errors") or {}).items():
        title = (info or {}).get("class_type") or node_id
        for item in (info or {}).get("errors") or []:
            detail = item.get("details") or item.get("message") or item
            lines.append(f"node {node_id} ({title}): {detail}")
    lines.append("models on the volume:")
    lines.extend(f"  {path}" for path in list_volume_models())
    return "\n".join(lines)[:8000]


def queue_workflow(workflow, client_id):
    r = requests.post(
        f"{COMFY_BASE}/prompt",
        json={"prompt": workflow, "client_id": client_id},
        timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(explain_comfy_rejection(r.text))
    prompt_id = r.json().get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"No prompt_id in ComfyUI response: {r.text[:2000]}")
    return prompt_id


def wait_for_result(prompt_id):
    # simple polling on /history. websockets would be fancier but this is
    # dead reliable and plenty fast at one image per job.
    deadline = time.time() + GENERATION_TIMEOUT_S
    while time.time() < deadline:
        r = requests.get(f"{COMFY_BASE}/history/{prompt_id}", timeout=30)
        if r.ok:
            entry = r.json().get(prompt_id)
            if entry:
                status = (entry.get("status") or {}).get("status_str")
                if status == "error":
                    msgs = (entry.get("status") or {}).get("messages") or entry
                    raise RuntimeError(f"ComfyUI execution failed: {msgs}")
                outputs = entry.get("outputs") or {}
                for node_output in outputs.values():
                    images = (node_output or {}).get("images") or []
                    if images:
                        return images[0]
        time.sleep(2)
    raise TimeoutError(
        f"Generation {prompt_id} did not finish "
        f"within {GENERATION_TIMEOUT_S}s."
    )


def fetch_image_bytes(image_ref):
    params = {
        "filename": image_ref["filename"],
        "subfolder": image_ref.get("subfolder", ""),
        "type": image_ref.get("type", "output"),
    }
    r = requests.get(f"{COMFY_BASE}/view", params=params, timeout=120)
    r.raise_for_status()
    return r.content


def parse_bucket_endpoint(url):
    """Split BUCKET_ENDPOINT_URL into (endpoint_url, bucket).

    Accepts path style (https://host/bucket) or virtual-hosted style
    (https://bucket.host or https://bucket.s3.region.amazonaws.com).
    """
    u = urlparse(url)
    if not u.scheme or not u.hostname:
        raise ValueError(f"BUCKET_ENDPOINT_URL looks wrong: {url!r}")
    path_parts = [p for p in u.path.strip("/").split("/") if p]
    if path_parts:
        return f"{u.scheme}://{u.hostname}", path_parts[0]
    labels = u.hostname.split(".")
    if len(labels) < 2:
        raise ValueError(f"Cannot find a bucket name in {url!r}")
    return f"{u.scheme}://{'.'.join(labels[1:])}", labels[0]


def upload_to_r2(png_bytes, job_id, filename):
    # boto3 screws up R2 auth on >= 1.40, hence the pin in the Dockerfile.
    import boto3

    endpoint = os.environ["BUCKET_ENDPOINT_URL"]
    endpoint_url, bucket = parse_bucket_endpoint(endpoint)
    key = f"{job_id}/{filename}"
    client = boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=os.environ["BUCKET_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["BUCKET_SECRET_ACCESS_KEY"],
    )
    client.put_object(
        Bucket=bucket, Key=key, Body=png_bytes, ContentType="image/png"
    )
    public_base = os.environ.get("R2_PUBLIC_BASE_URL", "").rstrip("/")
    if not public_base:
        raise RuntimeError(
            "Upload worked but R2_PUBLIC_BASE_URL is not set, "
            "so there is no public URL to return."
        )
    url = f"{public_base}/{key}"
    log(f"uploaded to {url}")
    return url


def clamp_int(value, default, minimum, maximum):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, n))


def round_to_block(n, block=32):
    # latent dims have to be multiples of 32 for this model.
    return max(block, (n // block) * block)


def handler(job):
    job_id = job.get("id") or uuid.uuid4().hex[:12]
    job_input = job.get("input") or {}

    prompt = str(job_input.get("prompt", "")).strip()
    if not prompt:
        return {"error": "input.prompt is required."}

    width = round_to_block(clamp_int(job_input.get("width", 1024), 1024, 256, 2048))
    height = round_to_block(clamp_int(job_input.get("height", 1024), 1024, 256, 2048))
    steps = clamp_int(job_input.get("steps", 25), 25, 1, 50)
    seed = job_input.get("seed")
    try:
        seed = int(seed) if seed is not None else random.randint(0, 2**31 - 1)
    except (TypeError, ValueError):
        seed = random.randint(0, 2**31 - 1)

    log(f"job {job_id}: {width}x{height}, {steps} steps, seed {seed}")

    workflow = copy.deepcopy(WORKFLOW_TEMPLATE)
    workflow["4"]["inputs"]["prompt"] = prompt
    workflow["5"]["inputs"]["width"] = width
    workflow["5"]["inputs"]["height"] = height
    workflow["6"]["inputs"]["steps"] = steps
    workflow["6"]["inputs"]["seed"] = seed

    try:
        wait_for_comfy()
        client_id = uuid.uuid4().hex
        prompt_id = queue_workflow(workflow, client_id)
        log(f"job {job_id}: queued as {prompt_id}")
        image_ref = wait_for_result(prompt_id)
        png = fetch_image_bytes(image_ref)

        # R2 configured -> upload and return a URL. otherwise fall back to
        # inline base64 so the worker still works without storage set up.
        if os.environ.get("BUCKET_ENDPOINT_URL"):
            image_url = upload_to_r2(png, job_id, image_ref["filename"])
        else:
            log("BUCKET_ENDPOINT_URL not set, returning base64 instead")
            image_url = "data:image/png;base64," + base64.b64encode(png).decode()

        return {"image_url": image_url, "seed": seed}
    except Exception as e:  # noqa: BLE001 - runpod serializes the message
        log(f"job {job_id} failed: {e}")
        return {"error": str(e)}


runpod.serverless.start({"handler": handler})
