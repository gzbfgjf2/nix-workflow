import type { GraphData, Layout, LayoutNode, LayoutEdge } from "./types";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 50;
const HORIZONTAL_GAP = 60;
const VERTICAL_GAP = 80;
const PADDING = 40;

export function computeLayout(data: GraphData): Layout {
  const { nodes, edges } = data;
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const n of nodes) {
    inDegree.set(n.id, 0);
    children.set(n.id, []);
  }

  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    children.get(e.from)?.push(e.to);
  }

  // Assign layers using longest path from roots
  const layers = new Map<string, number>();
  const visited = new Set<string>();

  function dfs(id: string): number {
    if (layers.has(id)) return layers.get(id)!;
    if (visited.has(id)) return 0; // cycle guard
    visited.add(id);

    // Find max layer of all parents
    let maxParentLayer = -1;
    for (const e of edges) {
      if (e.to === id) {
        maxParentLayer = Math.max(maxParentLayer, dfs(e.from));
      }
    }
    const layer = maxParentLayer + 1;
    layers.set(id, layer);
    return layer;
  }

  for (const n of nodes) {
    dfs(n.id);
  }

  // Group nodes by layer
  const layerGroups = new Map<number, string[]>();
  for (const [id, layer] of layers) {
    if (!layerGroups.has(layer)) layerGroups.set(layer, []);
    layerGroups.get(layer)!.push(id);
  }

  const maxLayer = Math.max(...layerGroups.keys());
  const maxNodesInLayer = Math.max(
    ...Array.from(layerGroups.values()).map((g) => g.length)
  );

  // Position nodes — left-aligned per layer
  const layoutNodes: LayoutNode[] = [];
  for (let layer = 0; layer <= maxLayer; layer++) {
    const group = layerGroups.get(layer) || [];

    for (let i = 0; i < group.length; i++) {
      const node = nodeMap.get(group[i])!;
      layoutNodes.push({
        id: node.id,
        label: node.label,
        x: PADDING + i * (NODE_WIDTH + HORIZONTAL_GAP),
        y: PADDING + layer * (NODE_HEIGHT + VERTICAL_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    }
  }

  // Build position lookup
  const posMap = new Map(layoutNodes.map((n) => [n.id, n]));

  // Create edges with simple bezier control points
  const layoutEdges: LayoutEdge[] = edges.map((e) => {
    const from = posMap.get(e.from)!;
    const to = posMap.get(e.to)!;
    const startX = from.x + from.width / 2;
    const startY = from.y + from.height;
    const endX = to.x + to.width / 2;
    const endY = to.y;
    const midY = (startY + endY) / 2;

    return {
      from: e.from,
      to: e.to,
      points: [
        { x: startX, y: startY },
        { x: startX, y: midY },
        { x: endX, y: midY },
        { x: endX, y: endY },
      ],
    };
  });

  const width =
    2 * PADDING +
    maxNodesInLayer * (NODE_WIDTH + HORIZONTAL_GAP) -
    HORIZONTAL_GAP;
  const height =
    2 * PADDING +
    (maxLayer + 1) * NODE_HEIGHT +
    maxLayer * VERTICAL_GAP;

  return { nodes: layoutNodes, edges: layoutEdges, width, height };
}
