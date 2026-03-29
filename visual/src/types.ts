export interface FileEntry {
  type: "file" | "symlink" | "directory";
  content?: string | null;
  target?: string;
  children?: string[];
  resolvedDir?: string[];
}

export interface DirEntry {
  name: string;
  type: "file" | "symlink" | "directory";
  target?: string;
  isDir?: boolean;
  size?: number;
  broken?: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  type: "recipe" | "resolved" | "output";
  storePath?: string;
  drvPath?: string;
  canonicalCmd?: string | null;
  recipe?: Record<string, unknown> | null;
  contentPath?: string | null;
  contentHash?: string | null;
  resolvedRecipe?: {
    canonical: Record<string, unknown>;
    canonicalCmd: string;
    out: string;
  } | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "recipe" | "resolved" | "cross";
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LayoutNode {
  id: string;
  label: string;
  type: "recipe" | "resolved" | "output";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  type: "recipe" | "resolved" | "cross";
  points: { x: number; y: number }[];
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}
