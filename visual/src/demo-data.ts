import type { GraphData, GraphNode, GraphEdge } from "./types";

function node(id: string, deps: string[] = []): GraphNode {
  const files: GraphNode["files"] = {
    "task.json": {
      type: "file",
      content: JSON.stringify({ nix_var_name: id, canonical_cmd: `minidata build ${id}`, name: id }, null, 2),
    },
    output: { type: "symlink", target: `/nix-workflow/store/${id}` },
    state: { type: "symlink", target: `/nix-workflow/state/${id}` },
  };
  if (deps.length > 0) {
    files.requires = { type: "directory", children: deps };
  }
  return { id, label: id, files };
}

const nodes: GraphNode[] = [
  // Layer 0: raw data sources
  node("raw_wiki"),
  node("raw_arxiv"),
  node("raw_books"),
  node("raw_code"),
  node("raw_math"),
  node("raw_web"),

  // Layer 1: language detection & initial filtering
  node("langdet_wiki", ["raw_wiki"]),
  node("langdet_arxiv", ["raw_arxiv"]),
  node("langdet_books", ["raw_books"]),
  node("langdet_web", ["raw_web"]),
  node("filter_code", ["raw_code"]),
  node("filter_math", ["raw_math"]),

  // Layer 2: quality filtering
  node("quality_wiki", ["langdet_wiki"]),
  node("quality_arxiv", ["langdet_arxiv"]),
  node("quality_books", ["langdet_books"]),
  node("quality_web", ["langdet_web"]),
  node("lint_code", ["filter_code"]),

  // Layer 3: deduplication
  node("dedup_wiki", ["quality_wiki"]),
  node("dedup_arxiv", ["quality_arxiv"]),
  node("dedup_books", ["quality_books"]),
  node("dedup_web", ["quality_web"]),
  node("dedup_code", ["lint_code"]),

  // Layer 4: PII removal
  node("pii_wiki", ["dedup_wiki"]),
  node("pii_arxiv", ["dedup_arxiv"]),
  node("pii_books", ["dedup_books"]),
  node("pii_web", ["dedup_web"]),

  // Layer 5: merge streams
  node("merge_text", ["pii_wiki", "pii_arxiv", "pii_books"]),
  node("merge_web", ["pii_web"]),
  node("normalize_code", ["dedup_code"]),
  node("normalize_math", ["filter_math"]),

  // Layer 6: tokenization
  node("tokenize_text", ["merge_text"]),
  node("tokenize_web", ["merge_web"]),
  node("tokenize_code", ["normalize_code"]),
  node("tokenize_math", ["normalize_math"]),

  // Layer 7: embedding
  node("embed_text", ["tokenize_text"]),
  node("embed_web", ["tokenize_web"]),
  node("embed_code", ["tokenize_code"]),

  // Layer 8: mixing
  node("mix_text_web", ["tokenize_text", "tokenize_web"]),
  node("mix_code_math", ["tokenize_code", "tokenize_math"]),

  // Layer 9: final mix & index
  node("final_mix", ["mix_text_web", "mix_code_math"]),
  node("build_index", ["embed_text", "embed_web", "embed_code"]),

  // Layer 10: validation
  node("validate_tokens", ["final_mix"]),
  node("validate_index", ["build_index"]),
  node("validate_cross", ["final_mix", "build_index"]),

  // Layer 11: benchmarks
  node("bench_perplexity", ["validate_tokens"]),
  node("bench_retrieval", ["validate_index"]),
  node("bench_contamination", ["validate_cross"]),

  // Layer 12: export
  node("export_hf", ["bench_perplexity", "bench_contamination"]),
  node("export_stats", ["bench_perplexity", "bench_retrieval", "bench_contamination"]),
  node("export_manifest", ["export_hf", "export_stats"]),
];

const edges: GraphEdge[] = [];
const edgeSet = new Set<string>();
for (const n of nodes) {
  const req = n.files.requires;
  if (req && req.type === "directory" && req.children) {
    for (const dep of req.children) {
      const key = `${dep}->${n.id}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ from: dep, to: n.id });
      }
    }
  }
}

export const demoData: GraphData = { nodes, edges };
