import { readdir, readFile, lstat, readlink, stat } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { writeFile } from "node:fs/promises";

const INPUT_DIR = resolve(import.meta.dirname, "../../nix-workflow-output");
const OUTPUT_FILE = resolve(import.meta.dirname, "../src/graph-data.json");

async function isDirectory(p) {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function isSymlink(p) {
  try {
    const s = await lstat(p);
    return s.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readDirSafe(p) {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

async function readFileSafe(p) {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return null;
  }
}

async function main() {
  const entries = await readdir(INPUT_DIR);
  const nodes = {};
  const edges = [];

  // First pass: discover all node folders
  for (const entry of entries) {
    const fullPath = join(INPUT_DIR, entry);
    if (!(await isDirectory(fullPath))) continue;

    // Read files in this folder
    const contents = await readdir(fullPath);
    const files = {};

    for (const item of contents) {
      const itemPath = join(fullPath, item);
      const itemStat = await lstat(itemPath);

      if (itemStat.isSymbolicLink()) {
        const target = await readlink(itemPath);
        files[item] = { type: "symlink", target };
      } else if (itemStat.isDirectory()) {
        // required_by or requires directories - read their symlinks
        const subEntries = await readDirSafe(itemPath);
        const links = [];
        for (const sub of subEntries) {
          const subPath = join(itemPath, sub);
          if (await isSymlink(subPath)) {
            links.push(sub);
          }
        }
        files[item] = { type: "directory", children: links };
      } else if (itemStat.isFile()) {
        const content = await readFileSafe(itemPath);
        files[item] = { type: "file", content };
      }
    }

    // Extract label from task.json if available
    let label = entry;
    if (files["task.json"] && files["task.json"].content) {
      try {
        const taskData = JSON.parse(files["task.json"].content);
        label = taskData.nix_var_name || entry;
      } catch {}
    }

    nodes[entry] = { id: entry, label, files };
  }

  // Second pass: build edges from requires/required_by
  const edgeSet = new Set();
  for (const [nodeId, node] of Object.entries(nodes)) {
    const requiresDir = node.files["requires"];
    if (requiresDir && requiresDir.type === "directory") {
      for (const dep of requiresDir.children) {
        if (nodes[dep]) {
          const key = `${dep}->${nodeId}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ from: dep, to: nodeId });
          }
        }
      }
    }

    const requiredByDir = node.files["required_by"];
    if (requiredByDir && requiredByDir.type === "directory") {
      for (const dep of requiredByDir.children) {
        if (nodes[dep]) {
          const key = `${nodeId}->${dep}`;
          if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push({ from: nodeId, to: dep });
          }
        }
      }
    }
  }

  const data = {
    nodes: Object.values(nodes),
    edges,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(data, null, 2));
  console.log(
    `Generated ${OUTPUT_FILE} with ${data.nodes.length} nodes and ${data.edges.length} edges`
  );
}

main().catch(console.error);
