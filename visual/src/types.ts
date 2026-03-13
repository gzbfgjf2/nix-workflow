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
  files: Record<string, FileEntry>;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LayoutNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  points: { x: number; y: number }[];
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}
