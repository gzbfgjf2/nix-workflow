import { readdir, readFile, lstat, readlink, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Resolve sqlite3 binary: use NW_SQLITE3 env var, PATH, or nix-build fallback
let sqlite3Bin = process.env.NW_SQLITE3 || "sqlite3";
async function resolveSqlite3() {
  try {
    await execFileAsync(sqlite3Bin, ["--version"]);
  } catch {
    try {
      const { stdout } = await execFileAsync("nix-build", [
        "<nixpkgs>", "-A", "sqlite", "--no-out-link",
      ]);
      sqlite3Bin = join(stdout.trim(), "bin", "sqlite3");
    } catch {}
  }
}
const sqlite3Ready = resolveSqlite3();

const NW_BASE = "/nix-workflow";
const NW_STORE = join(NW_BASE, "store");
const DB_PATH = join(NW_BASE, "db", "db.sqlite");

// Experiment file path — set via setExperimentPath()
let experimentPath = null;

export function setExperimentPath(path) {
  experimentPath = path;
}

// Cache
let graphCache = null;
let graphCacheTime = 0;
const CACHE_TTL_MS = 10_000;

async function nixEval(path) {
  const { stdout } = await execFileAsync("nix", [
    "eval", "-f", path,
    "--apply", 'attr: builtins.mapAttrs (_: w: builtins.removeAttrs w ["__toString"]) attr',
    "--json",
  ]);
  return JSON.parse(stdout);
}

async function nixStoreReferences(storePath) {
  try {
    const { stdout } = await execFileAsync("nix-store", [
      "--query", "--references", storePath,
    ]);
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function readRecipeJson(storePath) {
  try {
    const content = await readFile(join(storePath, "recipe.json"), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function dbQuery(sql) {
  try {
    await sqlite3Ready;
    const { stdout } = await execFileAsync(sqlite3Bin, [DB_PATH, "-json", sql]);
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed);
  } catch {
    return [];
  }
}

async function dbLookupResolved(pathRecipeUnresolved) {
  const rows = await dbQuery(
    `SELECT path_recipe_resolved FROM placeholder_to_resolved WHERE path_recipe_unresolved = '${pathRecipeUnresolved}'`,
  );
  return rows.length > 0 ? rows[0].path_recipe_resolved : null;
}

async function dbLookupHashOutput(resolvedPath) {
  const rows = await dbQuery(
    `SELECT hash_output FROM realisations WHERE path_recipe_resolved = '${resolvedPath}'`,
  );
  return rows.length > 0 ? rows[0].hash_output : null;
}

async function readResolvedRecipe(resolvedPath) {
  try {
    const content = await readFile(resolvedPath, "utf-8");
    return JSON.parse(content);
  } catch {}
  return null;
}

async function buildGraphFresh() {
  if (!experimentPath) {
    return { nodes: [], edges: [] };
  }

  const evalResult = await nixEval(experimentPath);
  const nodes = [];
  const edges = [];
  const edgeSet = new Set();

  // Extract tasks from eval result
  const tasks = {};
  for (const [attr, value] of Object.entries(evalResult)) {
    if (value?.__type__ !== "task") continue;
    tasks[attr] = value;
  }

  // Build path-to-attr map first (needed for edge lookup)
  const pathRecipeUnresolvedToAttr = {};
  for (const [attr, task] of Object.entries(tasks)) {
    pathRecipeUnresolvedToAttr[task.pathRecipeUnresolved] = attr;
  }

  // Build recipe nodes
  for (const [attr, task] of Object.entries(tasks)) {
    const pathRecipeUnresolved = task.pathRecipeUnresolved;

    const recipe = await readRecipeJson(pathRecipeUnresolved);

    // Lookup resolved recipe and hash via DB
    const resolvedPath = await dbLookupResolved(pathRecipeUnresolved);
    let contentHash = null;
    let resolvedRecipe = null;
    if (resolvedPath) {
      contentHash = await dbLookupHashOutput(resolvedPath);
      resolvedRecipe = await readResolvedRecipe(resolvedPath);
    }
    const contentPath = contentHash ? join(NW_STORE, contentHash) : null;

    nodes.push({
      id: attr,
      label: attr,
      type: "recipe",
      storePath: pathRecipeUnresolved,
      recipe: recipe || null,
      contentPath,
      contentHash,
    });

    // Recipe dependency edges via nix-store references
    const refs = await nixStoreReferences(pathRecipeUnresolved);
    for (const ref of refs) {
      const depAttr = pathRecipeUnresolvedToAttr[ref];
      if (depAttr && depAttr !== attr) {
        const key = `${depAttr}->${attr}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ from: depAttr, to: attr, type: "recipe" });
        }
      }
    }

    // Resolved node
    if (resolvedPath) {
      const resolvedId = `${attr}:resolved`;
      nodes.push({
        id: resolvedId,
        label: `${attr} (resolved)`,
        type: "resolved",
        drvPath: resolvedPath,
        contentPath,
        contentHash,
        resolvedRecipe,
      });

      // Cross-edge
      edges.push({ from: attr, to: resolvedId, type: "cross" });
    }
  }

  // Derive resolved edges from unresolved recipe edges:
  // if unresolved_A -> unresolved_B, then resolved_A -> resolved_B
  for (const edge of edges) {
    if (edge.type !== "recipe") continue;
    const fromResolved = `${edge.from}:resolved`;
    const toResolved = `${edge.to}:resolved`;
    // Only add if both resolved nodes exist
    if (nodes.some((n) => n.id === fromResolved) && nodes.some((n) => n.id === toResolved)) {
      const key = `${fromResolved}->${toResolved}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ from: fromResolved, to: toResolved, type: "resolved" });
      }
    }
  }

  return { nodes, edges };
}

export async function buildGraph() {
  const now = Date.now();
  if (graphCache && now - graphCacheTime < CACHE_TTL_MS) {
    return graphCache;
  }
  graphCache = await buildGraphFresh();
  graphCacheTime = now;
  return graphCache;
}

export async function listPath(reqPath) {
  const safePath = resolve(reqPath);
  const entries = await readdir(safePath);
  const result = [];

  for (const name of entries) {
    const full = join(safePath, name);
    const s = await lstat(full);
    const entry = { name };
    if (s.isSymbolicLink()) {
      entry.type = "symlink";
      entry.target = await readlink(full);
      try {
        const resolved = await stat(full);
        entry.isDir = resolved.isDirectory();
        entry.size = resolved.isDirectory() ? undefined : resolved.size;
      } catch {
        entry.broken = true;
      }
    } else if (s.isDirectory()) {
      entry.type = "directory";
    } else {
      entry.type = "file";
      entry.size = s.size;
    }
    result.push(entry);
  }
  return result;
}

export async function readPath(reqPath) {
  const safePath = resolve(reqPath);
  const s = await stat(safePath);
  if (s.size > 10 * 1024 * 1024) {
    return { error: "File too large", size: s.size };
  }
  const content = await readFile(safePath, "utf-8");
  return { content, size: s.size };
}
