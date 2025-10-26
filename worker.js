/**
 * Cloudflare Worker — FileShare + D1 + R2
 * - Short links via Base62 (from D1 auto-increment id)
 * - R2 for file blobs
 * - Tailwind UI homepage
 * - Routes:
 *   POST  /api/upload
 *   GET   /           (home)
 *   GET   /f/:short   (download page with ad slots)
 *   GET   /d/:short   (file bytes; Range supported)
 *   GET   /stream/:short (basic audio/video player)
 *   GET   /meta/:short   (JSON metadata)
 *
 * Bindings (wrangler.toml):
 * [[r2_buckets]]
 * binding = "R2_BUCKET"
 * bucket_name = "share"
 * preview_bucket_name = "share"
 *
 * [[d1_databases]]
 * binding = "DB"
 * database_name = "share"
 * database_id = "<your-id>"
 *
 * [vars]
 * SITE_NAME = "FileShare"
 */

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      return new Response("Server error: " + (err?.stack || err), { status: 500 });
    }
  },
};

// --------------------------- Utilities --------------------------------------
function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Base62 for short links
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62encode(n) {
  n = BigInt(n);
  if (n === 0n) return "0";
  let out = "";
  while (n > 0n) {
    const r = Number(n % 62n);
    out = B62[r] + out;
    n = n / 62n;
  }
  return out;
}

function bytesPretty(n) {
  if (!Number.isFinite(n)) return "unknown";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function sanitizeFilename(name) {
  return String(name || "file").replace(/[\n\r\t\\\"']/g, "_");
}

function html(s) {
  return new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
}
function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

// ----------------------------- HTML -----------------------------------------
function renderHome(env) {
  const site = env.SITE_NAME || "FileShare";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${htmlEscape(site)} — Upload & Share Files (No account)</title>
  <meta name="description" content="Free file uploads — share instantly. No account required." />
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
  <div class="max-w-4xl mx-auto p-6">
    <header class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold">${htmlEscape(site)}</h1>
      <nav class="space-x-4 text-sm">
        <a href="/terms" class="underline">Terms</a>
        <a href="/privacy" class="underline">Privacy</a>
      </nav>
    </header>

    <main class="bg-white rounded-xl shadow p-6">
      <h2 class="text-lg font-semibold mb-2">Upload files — no account</h2>
      <p class="text-sm text-slate-600 mb-4">Select or drag & drop. After upload you'll get a shareable link with download & streaming options. Ads may be shown on download pages to keep the service free.</p>

      <form id="uploadForm" class="border-dashed border-2 border-slate-200 rounded p-6 flex flex-col items-center justify-center" enctype="multipart/form-data">
        <input id="fileInput" name="file" type="file" class="mb-4" />
        <div class="flex gap-2 mb-4">
          <label class="flex items-center gap-2">
            <input type="checkbox" id="streamable" checked /> Streamable (audio/video)
          </label>
        </div>
        <button id="uploadBtn" class="bg-blue-600 text-white px-4 py-2 rounded">Upload</button>
        <div id="status" class="mt-4 text-sm text-slate-600"></div>
      </form>

      <div class="mt-6 grid grid-cols-2 gap-2 text-xs text-slate-600">
        <div>Max file size: depends on plan and Worker limits</div>
        <div>Storage: Cloudflare R2</div>
      </div>
    </main>

    <footer class="text-center text-xs text-slate-500 mt-6">
      Powered by Cloudflare R2 + D1 • Replace ad placeholders with your ad code
    </footer>
  </div>

<script>
const form = document.getElementById('uploadForm');
const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const statusEl = document.getElementById('status');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (!file) {
    statusEl.textContent = 'Pick a file first';
    return;
  }

  uploadBtn.disabled = true;
  statusEl.textContent = 'Uploading...';

  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('streamable', document.getElementById('streamable').checked ? '1' : '0');

    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const j = await r.json();

    if (j.ok) {
      const url = location.origin + '/f/' + j.short_id;
      statusEl.innerHTML = \`Uploaded — <a href="\${url}" class="text-blue-600 underline">Open share page</a>\`;
      fileInput.value = '';
    } else {
      statusEl.textContent = 'Upload failed: ' + (j.error || 'unknown');
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Upload error: ' + err.message;
  }

  // (No 'finally'—placed here to avoid inline script parsing issues)
  uploadBtn.disabled = false;
});
</script>
</body>
</html>`;
}

function renderDownloadPage(env, row) {
  const site = env.SITE_NAME || "FileShare";
  const name = htmlEscape(row.name);
  const size = bytesPretty(row.size || 0);
  const sid  = htmlEscape(row.short_id);
  const canStream = row.streamable == 1 || row.streamable === "1";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Download: ${name} — ${htmlEscape(site)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
  <div class="max-w-3xl mx-auto p-6">
    <header class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-semibold">${htmlEscape(site)}</h1>
      <a href="/" class="text-sm underline">Home</a>
    </header>

    <!-- Ad placeholder: top banner -->
    <div class="w-full bg-slate-100 border rounded p-4 text-center mb-4">[Ad slot — place your ad script here]</div>

    <main class="bg-white p-6 rounded shadow">
      <h2 class="text-lg font-medium mb-1">${name}</h2>
      <p class="text-sm text-slate-600 mb-4">Size: ${size}</p>

      <div class="flex gap-3 mb-4">
        <a class="px-4 py-2 bg-green-600 text-white rounded" href="/d/${sid}">Download</a>
        ${canStream ? `<a class="px-4 py-2 bg-indigo-600 text-white rounded" href="/stream/${sid}">Stream</a>` : ""}
        <button onclick="shareLink()" class="px-4 py-2 border rounded">Copy Link</button>
      </div>

      <div class="text-xs text-slate-500">Direct link: <code id="direct">\${location.origin}/d/${sid}</code></div>

      <hr class="my-4" />
      <p class="text-xs text-slate-600">By using this site you agree to the <a href="/terms" class="underline">Terms</a> and <a href="/privacy" class="underline">Privacy</a>.</p>

      <!-- Ad placeholder: inline -->
      <div class="mt-6 w-full bg-slate-100 border rounded p-4 text-center">[Ad slot — replace with ad code]</div>
    </main>
  </div>

<script>
function shareLink(){
  const url = location.origin + location.pathname;
  navigator.clipboard?.writeText(url).then(()=>alert('Link copied'));
}
</script>
</body>
</html>`;
}

function renderStreamPage(env, row) {
  const site = env.SITE_NAME || "FileShare";
  const name = htmlEscape(row.name);
  const sid  = htmlEscape(row.short_id);
  const type = row.mime || "";
  const isVideo = type.startsWith("video/");
  const isAudio = type.startsWith("audio/");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Stream: ${name} — ${htmlEscape(site)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-900 min-h-screen">
  <div class="max-w-3xl mx-auto p-6">
    <header class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-semibold">${htmlEscape(site)}</h1>
      <a href="/" class="text-sm underline">Home</a>
    </header>

    <!-- Ad placeholder -->
    <div class="mb-4 w-full bg-slate-100 border rounded p-4 text-center">[Ad slot — pre-roll placeholder]</div>

    <main class="bg-white p-6 rounded shadow">
      <h2 class="text-lg font-medium mb-2">${name}</h2>

      ${isVideo ? `<video id="player" controls class="w-full max-h-[60vh]"><source src="/d/${sid}" type="${type}"></video>` : ""}
      ${isAudio ? `<audio id="player" controls class="w-full"><source src="/d/${sid}" type="${type}"></audio>` : ""}

      <div class="mt-4 text-xs text-slate-500">If the player does not load, use the <a href="/d/${sid}" class="underline">direct download</a>.</div>
    </main>
  </div>
</body>
</html>`;
}

function renderPolicy(type, env) {
  const site = env.SITE_NAME || "FileShare";
  const title = type === "terms" ? "Terms of Service" : "Privacy Policy";
  const body = type === "terms"
    ? `\n1. Don't upload illegal content.\n2. No copyright infringement.\n3. Files may be removed at our discretion.\n4. Ads may be shown on download pages.`
    : `\nWe collect minimal metadata (filename, size, mime, timestamps).\nNo account system. Server logs may include IPs for abuse prevention.`;
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${htmlEscape(site)} — ${title}</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-slate-50 text-slate-900 min-h-screen"><div class="max-w-3xl mx-auto p-6"><header class="mb-6"><a href="/" class="underline">Home</a></header><main class="bg-white p-6 rounded shadow"><h1 class="text-xl font-semibold mb-4">${title}</h1><pre class="whitespace-pre-wrap text-sm text-slate-700">${body}</pre></main></div></body></html>`;
}

// --------------------------- Router / Handlers -------------------------------
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // API
  if (request.method === "POST" && path === "/api/upload") return handleUpload(request, env);

  // Pages
 if (request.method === "GET" && path === "/") return html(renderHome(env));
if (request.method === "GET" && path === "/terms") return html(renderPolicy("terms", env));
if (request.method === "GET" && path === "/privacy") return html(renderPolicy("privacy", env));

  if (request.method === "GET" && path.startsWith("/f/")) return handleFriendlyPage(request, env);
  if (request.method === "GET" && path.startsWith("/d/")) return handleDownload(request, env);
  if (request.method === "GET" && path.startsWith("/stream/")) return handleStreamPage(request, env);
  if (request.method === "GET" && path.startsWith("/meta/")) return handleMeta(request, env);

  return new Response("Not found", { status: 404 });
}

// --------------------------- Upload -----------------------------------------
async function handleUpload(request, env) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.startsWith("multipart/form-data")) return json({ ok: false, error: "Expected multipart/form-data" }, 400);

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file.stream !== "function") return json({ ok: false, error: "Missing file" }, 400);
  const streamable = form.get("streamable") === "1" || form.get("streamable") === "on" || form.get("streamable") === "true" ? 1 : 0;

  const name = file.name || "untitled";
  const size = file.size || 0;
  const mime = file.type || "application/octet-stream";

  // 1) Insert placeholder
  const tempShort = "x" + Math.random().toString(36).slice(2, 8);
  const insert = await env.DB.prepare(
    "INSERT INTO files (short_id, name, size, mime, streamable, r2_key) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(tempShort, name, size, mime, streamable, "pending").run();

  const numericId = insert.meta?.last_row_id ?? insert.lastRowId ?? 0;
  if (!numericId) return json({ ok: false, error: "DB insert failed" }, 500);

  // 2) Compute short id
  const shortId = base62encode(numericId);

  // 3) Upload blob to R2 under files/{id}
  const key = `files/${numericId}`;
  await env.R2_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: mime } });

  // 4) Update row
  await env.DB.prepare("UPDATE files SET short_id=?, r2_key=? WHERE id=?")
    .bind(shortId, key, numericId).run();

  return json({ ok: true, id: numericId, short_id: shortId });
}

// ------------------------ Read helpers --------------------------------------
async function getByShort(env, short) {
  const row = await env.DB.prepare(
    "SELECT id, short_id, name, size, mime, streamable, created_at, r2_key FROM files WHERE short_id=? LIMIT 1"
  ).bind(short).first();
  return row || null;
}

// ----------------------------- Pages ----------------------------------------
async function handleFriendlyPage(request, env) {
  const short = new URL(request.url).pathname.replace("/f/", "").replace(/\/+$/, "");
  if (!short) return new Response("Missing id", { status: 400 });
  const row = await getByShort(env, short);
  if (!row) return new Response("File not found", { status: 404 });
  return html(renderDownloadPage(env, row));
}

async function handleStreamPage(request, env) {
  const short = new URL(request.url).pathname.replace("/stream/", "").replace(/\/+$/, "");
  if (!short) return new Response("Missing id", { status: 400 });
  const row = await getByShort(env, short);
  if (!row) return new Response("File not found", { status: 404 });
  if (!(row.streamable == 1 || row.streamable === "1")) return new Response("Not streamable", { status: 400 });
  return html(renderStreamPage(env, row));
}

// ------------------------------ Download ------------------------------------
async function handleDownload(request, env) {
  const short = new URL(request.url).pathname.replace("/d/", "").replace(/\/+$/, "");
  if (!short) return new Response("Missing id", { status: 400 });
  const row = await getByShort(env, short);
  if (!row) return new Response("File not found", { status: 404 });

  const size = await headR2Size(env, row.r2_key);
  if (size == null) return new Response("File missing in storage", { status: 404 });

  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Type", row.mime || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${sanitizeFilename(row.name)}"`);

  const range = request.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) return new Response("Invalid range", { status: 416 });
    let start = m[1] === "" ? 0 : parseInt(m[1], 10);
    let end   = m[2] === "" ? (size - 1) : parseInt(m[2], 10);
    if (isNaN(start) || isNaN(end) || start > end || end >= size) return new Response("Range not satisfiable", { status: 416 });

    const length = end - start + 1;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(length));

    const ranged = await env.R2_BUCKET.get(row.r2_key, { range: { offset: start, length } });
    if (!ranged) return new Response("File not found", { status: 404 });
    return new Response(ranged.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(size));
  const whole = await env.R2_BUCKET.get(row.r2_key);
  if (!whole) return new Response("File not found", { status: 404 });
  return new Response(whole.body, { status: 200, headers });
}

async function headR2Size(env, key) {
  const h = await env.R2_BUCKET.head(key);
  return h ? h.size : null;
}

// ------------------------------ Metadata API --------------------------------
async function handleMeta(request, env) {
  const short = new URL(request.url).pathname.replace("/meta/", "").replace(/\/+$/, "");
  if (!short) return json({ ok: false, error: "Missing id" }, 400);
  const row = await getByShort(env, short);
  if (!row) return json({ ok: false, error: "Not found" }, 404);
  return json({ ok: true, file: row });
}
