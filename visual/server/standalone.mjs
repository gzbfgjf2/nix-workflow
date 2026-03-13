import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, listPath, readPath } from "./api-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "dist");
const PORT = parseInt(process.env.PORT || "3000", 10);

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function serveStatic(res, urlPath) {
  const filePath = join(DIST_DIR, urlPath === "/" ? "index.html" : urlPath);
  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    // Fall back to index.html for SPA routing
    const index = await readFile(join(DIST_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(index);
  }
}

const server = createServer(async (req, res) => {
  const url = req.url || "/";

  if (url.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    try {
      if (url === "/api/graph") {
        res.end(JSON.stringify(await buildGraph()));
      } else if (url.startsWith("/api/ls?path=")) {
        const path = decodeURIComponent(url.slice("/api/ls?path=".length));
        res.end(JSON.stringify(await listPath(path)));
      } else if (url.startsWith("/api/read?path=")) {
        const path = decodeURIComponent(url.slice("/api/read?path=".length));
        res.end(JSON.stringify(await readPath(path)));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  } else {
    await serveStatic(res, url);
  }
});

server.listen(PORT, () => {
  console.log(`nix-workflow visual: http://localhost:${PORT}`);
});
