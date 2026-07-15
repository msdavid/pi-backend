/**
 * Standalone static server for local development of the console SPA.
 *
 * In production the console is served by the backend at /console (same origin
 * as /v1, so the SPA's same-origin fetch calls need no CORS). This script is a
 * convenience for developing the SPA against a running backend without mounting
 * it there: set the "API base URL" in the UI to the backend's origin.
 *
 * Usage: node scripts/serve.mjs [distDir]   (default port 4173)
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../dist");
const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    let url = (req.url ?? "/").split("?")[0];
    if (url === "/") url = "/index.html";
    let fp = normalize(join(root, url));
    if (!fp.startsWith(root)) {
      res.writeHead(404).end("not found");
      return;
    }
    try { await stat(fp); }
    catch { fp = join(root, "index.html"); } // SPA fallback
    const body = await readFile(fp);
    res.writeHead(200, { "Content-Type": MIME[extname(fp)] ?? "application/octet-stream" });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e?.message ?? e));
  }
});

server.listen(PORT, () => {
  console.log(`web-console: serving ${root} at http://localhost:${PORT}`);
});
