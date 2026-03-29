import type { GraphData, GraphNode, GraphEdge } from "./types";

function node(id: string, deps: string[] = []): GraphNode {
  return {
    id,
    label: id,
    type: "recipe",
    canonicalCmd: `minidata build ${id}`,
    contentPath: `/nix-workflow/store/${id}`,
  };
}

function resolvedNode(id: string): GraphNode {
  return {
    id: `${id}:resolved`,
    label: `${id} (resolved)`,
    type: "resolved",
    contentPath: `/nix-workflow/store/${id}`,
    contentHash: `demo-hash-${id}`,
    resolvedRecipe: {
      canonical: { program: `/nix/store/xxx-${id}/bin/${id}`, subcommands: [], flags: [], options: {}, operands: [] },
      canonicalCmd: `/nix/store/xxx-${id}/bin/${id} --input=/nix-workflow/store/${id}`,
      out: `/nix-workflow-ca-placeholder-${id}`,
    },
  };
}

const taskIds = [
  // Layer 0
  "raw_wiki", "raw_arxiv", "raw_books", "raw_code", "raw_math", "raw_web",
  // Layer 1
  "langdet_wiki", "langdet_arxiv", "langdet_books", "langdet_web", "filter_code", "filter_math",
  // Layer 2
  "quality_wiki", "quality_arxiv", "quality_books", "quality_web", "lint_code",
  // Layer 3
  "dedup_wiki", "dedup_arxiv", "dedup_books", "dedup_web", "dedup_code",
  // Layer 4
  "pii_wiki", "pii_arxiv", "pii_books", "pii_web",
  // Layer 5
  "merge_text", "merge_web", "normalize_code", "normalize_math",
  // Layer 6
  "tokenize_text", "tokenize_web", "tokenize_code", "tokenize_math",
  // Layer 7
  "embed_text", "embed_web", "embed_code",
  // Layer 8
  "mix_text_web", "mix_code_math",
  // Layer 9
  "final_mix", "build_index",
  // Layer 10
  "validate_tokens", "validate_index", "validate_cross",
  // Layer 11
  "bench_perplexity", "bench_retrieval", "bench_contamination",
  // Layer 12
  "export_hf", "export_stats", "export_manifest",
];

const deps: Record<string, string[]> = {
  langdet_wiki: ["raw_wiki"], langdet_arxiv: ["raw_arxiv"],
  langdet_books: ["raw_books"], langdet_web: ["raw_web"],
  filter_code: ["raw_code"], filter_math: ["raw_math"],
  quality_wiki: ["langdet_wiki"], quality_arxiv: ["langdet_arxiv"],
  quality_books: ["langdet_books"], quality_web: ["langdet_web"],
  lint_code: ["filter_code"],
  dedup_wiki: ["quality_wiki"], dedup_arxiv: ["quality_arxiv"],
  dedup_books: ["quality_books"], dedup_web: ["quality_web"],
  dedup_code: ["lint_code"],
  pii_wiki: ["dedup_wiki"], pii_arxiv: ["dedup_arxiv"],
  pii_books: ["dedup_books"], pii_web: ["dedup_web"],
  merge_text: ["pii_wiki", "pii_arxiv", "pii_books"],
  merge_web: ["pii_web"],
  normalize_code: ["dedup_code"], normalize_math: ["filter_math"],
  tokenize_text: ["merge_text"], tokenize_web: ["merge_web"],
  tokenize_code: ["normalize_code"], tokenize_math: ["normalize_math"],
  embed_text: ["tokenize_text"], embed_web: ["tokenize_web"],
  embed_code: ["tokenize_code"],
  mix_text_web: ["tokenize_text", "tokenize_web"],
  mix_code_math: ["tokenize_code", "tokenize_math"],
  final_mix: ["mix_text_web", "mix_code_math"],
  build_index: ["embed_text", "embed_web", "embed_code"],
  validate_tokens: ["final_mix"], validate_index: ["build_index"],
  validate_cross: ["final_mix", "build_index"],
  bench_perplexity: ["validate_tokens"], bench_retrieval: ["validate_index"],
  bench_contamination: ["validate_cross"],
  export_hf: ["bench_perplexity", "bench_contamination"],
  export_stats: ["bench_perplexity", "bench_retrieval", "bench_contamination"],
  export_manifest: ["export_hf", "export_stats"],
};

const nodes: GraphNode[] = [];
const edges: GraphEdge[] = [];

for (const id of taskIds) {
  nodes.push(node(id, deps[id]));
  nodes.push(resolvedNode(id));
  edges.push({ from: id, to: `${id}:resolved`, type: "cross" });

  for (const dep of deps[id] || []) {
    edges.push({ from: dep, to: id, type: "recipe" });
    edges.push({ from: `${dep}:resolved`, to: `${id}:resolved`, type: "resolved" });
  }
}

export const demoData: GraphData = { nodes, edges };
