import { readdir, readFile, lstat, readlink, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

function getInputDir() {
  if (!process.env.DAG_DIR) {
    console.error("Error: DAG_DIR environment variable is required.\nUsage: DAG_DIR=./nix-workflow-output nw-visual");
    process.exit(1);
  }
  return resolve(process.env.DAG_DIR);
}

async function readDirSafe(p) {
  try { return await readdir(p); } catch { return []; }
}

async function readFileSafe(p) {
  try { return await readFile(p, "utf-8"); } catch { return null; }
}

async function scanNodeFolder(fullPath, entry) {
  const contents = await readdir(fullPath);
  const files = {};

  for (const item of contents) {
    const itemPath = join(fullPath, item);
    const itemStat = await lstat(itemPath);

    if (itemStat.isSymbolicLink()) {
      const target = await readlink(itemPath);
      const fileEntry = { type: "symlink", target };
      try {
        const resolved = await stat(itemPath);
        if (resolved.isDirectory()) {
          const dirEntries = await readDirSafe(itemPath);
          fileEntry.resolvedDir = dirEntries;
        }
      } catch { /* target not accessible */ }
      files[item] = fileEntry;
    } else if (itemStat.isDirectory()) {
      const subEntries = await readDirSafe(itemPath);
      const links = [];
      for (const sub of subEntries) {
        const subPath = join(itemPath, sub);
        try {
          const s = await lstat(subPath);
          if (s.isSymbolicLink()) links.push(sub);
        } catch { /* skip */ }
      }
      files[item] = { type: "directory", children: links };
    } else if (itemStat.isFile()) {
      const content = await readFileSafe(itemPath);
      files[item] = { type: "file", content };
    }
  }

  let label = entry;
  if (files["task.json"] && files["task.json"].content) {
    try {
      const taskData = JSON.parse(files["task.json"].content);
      label = taskData.nix_var_name || entry;
    } catch { /* skip */ }
  }

  return { id: entry, label, files };
}

export async function buildGraph() {
  const entries = await readdir(getInputDir());
  const nodes = {};
  const edges = [];

  for (const entry of entries) {
    const fullPath = join(getInputDir(), entry);
    try {
      const s = await stat(fullPath);
      if (!s.isDirectory()) continue;
    } catch { continue; }

    nodes[entry] = await scanNodeFolder(fullPath, entry);
  }

  const edgeSet = new Set();
  for (const [nodeId, node] of Object.entries(nodes)) {
    const requiresDir = node.files["requires"];
    if (requiresDir && requiresDir.type === "directory") {
      for (const dep of requiresDir.children) {
        if (nodes[dep]) {
          const key = `${dep}->${nodeId}`;
          if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ from: dep, to: nodeId }); }
        }
      }
    }
    const requiredByDir = node.files["required_by"];
    if (requiredByDir && requiredByDir.type === "directory") {
      for (const dep of requiredByDir.children) {
        if (nodes[dep]) {
          const key = `${nodeId}->${dep}`;
          if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ from: nodeId, to: dep }); }
        }
      }
    }
  }

  return { nodes: Object.values(nodes), edges };
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
