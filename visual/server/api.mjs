import { buildGraph, listPath, readPath, setExperimentPath } from "./api-core.mjs";

/** Vite plugin that adds API routes */
export function apiPlugin() {
  return {
    name: "nix-workflow-api",
    configureServer(server) {
      if (process.env.NW_EXPERIMENT) {
        setExperimentPath(process.env.NW_EXPERIMENT);
      }
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/api/")) return next();

        res.setHeader("Content-Type", "application/json");

        try {
          if (req.url === "/api/graph") {
            const data = await buildGraph();
            res.end(JSON.stringify(data));
          } else if (req.url.startsWith("/api/ls?path=")) {
            const path = decodeURIComponent(req.url.slice("/api/ls?path=".length));
            const data = await listPath(path);
            res.end(JSON.stringify(data));
          } else if (req.url.startsWith("/api/read?path=")) {
            const path = decodeURIComponent(req.url.slice("/api/read?path=".length));
            const data = await readPath(path);
            res.end(JSON.stringify(data));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Not found" }));
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}
