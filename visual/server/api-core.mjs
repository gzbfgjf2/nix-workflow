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

async function dbLookupResolvedDrv(recipeDrvPath) {
  const rows = await dbQuery(
    `SELECT resolved_drv_path FROM placeholder_to_resolved WHERE placeholder_drv_path = '${recipeDrvPath}'`,
  );
  return rows.length > 0 ? rows[0].resolved_drv_path : null;
}

async function dbLookupContentHash(resolvedDrvPath) {
  const rows = await dbQuery(
    `SELECT content_hash FROM realisations WHERE resolved_drv_path = '${resolvedDrvPath}'`,
  );
  return rows.length > 0 ? rows[0].content_hash : null;
}

async function readResolvedRecipe(drvPath) {
  try {
    const { stdout } = await execFileAsync("nix", ["derivation", "show", drvPath]);
    const drv = JSON.parse(stdout);
    const val = Object.values(drv)[0];
    if (val?.args?.[3]) {
      return JSON.parse(val.args[3]);
    }
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

  // Build recipe nodes
  const recipePathToAttr = {};
  for (const [attr, task] of Object.entries(tasks)) {
    const recipePath = task.recipePath;
    const dirName = task.dirName;
    recipePathToAttr[recipePath] = attr;

    const recipe = await readRecipeJson(recipePath);
    const programName = recipe?.canonical?.program
      ? recipe.canonical.program.split("/").pop()
      : null;

    // Lookup resolved drv and content hash via DB
    const resolvedDrvPath = await dbLookupResolvedDrv(task.recipeDrvPath);
    let contentHash = null;
    let resolvedRecipe = null;
    if (resolvedDrvPath) {
      contentHash = await dbLookupContentHash(resolvedDrvPath);
      resolvedRecipe = await readResolvedRecipe(resolvedDrvPath);
    }
    const contentPath = contentHash ? join(NW_STORE, contentHash) : null;

    nodes.push({
      id: attr,
      label: attr,
      type: "recipe",
      storePath: recipePath,
      recipe: recipe || null,
      contentPath,
      contentHash,
    });

    // Recipe dependency edges via nix-store references
    const refs = await nixStoreReferences(recipePath);
    for (const ref of refs) {
      const depAttr = recipePathToAttr[ref];
      if (depAttr && depAttr !== attr) {
        const key = `${depAttr}->${attr}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ from: depAttr, to: attr, type: "recipe" });
        }
      }
    }

    // Resolved node
    if (resolvedDrvPath) {
      const resolvedId = `${attr}:resolved`;
      nodes.push({
        id: resolvedId,
        label: `${attr} (resolved)`,
        type: "resolved",
        drvPath: resolvedDrvPath,
        contentPath,
        contentHash,
        resolvedRecipe,
      });

      // Cross-edge
      edges.push({ from: attr, to: resolvedId, type: "cross" });

      // Resolved dependency edges from inputDrvs
      const drvRefs = await nixStoreReferences(resolvedDrvPath);
      for (const ref of drvRefs) {
        // Find which attr has this resolved drv
        for (const [depAttr, depTask] of Object.entries(tasks)) {
          if (depAttr === attr) continue;
          const depResolvedDrv = await dbLookupResolvedDrv(depTask.recipeDrvPath);
          if (depResolvedDrv === ref) {
            const key = `${depAttr}:resolved->${resolvedId}`;
            if (!edgeSet.has(key)) {
              edgeSet.add(key);
              edges.push({
                from: `${depAttr}:resolved`,
                to: resolvedId,
                type: "resolved",
              });
            }
          }
        }
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
