import type { GraphData, Layout, LayoutNode, LayoutEdge } from "./types";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 50;
const HORIZONTAL_GAP = 60;
const VERTICAL_GAP = 80;
const ROW_GAP = VERTICAL_GAP;
const PADDING = 40;
const MAX_COLS = 3;

export function computeLayout(data: GraphData): Layout {
  const { nodes, edges } = data;
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const layers = new Map<string, number>();
  const visited = new Set<string>();

  function dfs(id: string): number {
    if (layers.has(id)) return layers.get(id)!;
    if (visited.has(id)) return 0;
    visited.add(id);
    let maxParentLayer = -1;
    for (const e of edges) {
      if (e.to === id && nodeMap.has(e.from)) {
        maxParentLayer = Math.max(maxParentLayer, dfs(e.from));
      }
    }
    const layer = maxParentLayer + 1;
    layers.set(id, layer);
    return layer;
  }

  for (const n of nodes) dfs(n.id);

  const layerGroups = new Map<number, string[]>();
  for (const [id, layer] of layers) {
    if (!layerGroups.has(layer)) layerGroups.set(layer, []);
    layerGroups.get(layer)!.push(id);
  }

  const maxLayer = Math.max(...layerGroups.keys());
  const layoutNodes: LayoutNode[] = [];

  // Compute cumulative Y offset per layer, accounting for wrapped rows
  let currentY = PADDING;
  for (let layer = 0; layer <= maxLayer; layer++) {
    const group = layerGroups.get(layer) || [];
    const rowCount = Math.ceil(group.length / MAX_COLS);

    for (let i = 0; i < group.length; i++) {
      const col = i % MAX_COLS;
      const row = Math.floor(i / MAX_COLS);
      const node = nodeMap.get(group[i])!;
      layoutNodes.push({
        id: node.id,
        label: node.label,
        type: node.type,
        x: PADDING + col * (NODE_WIDTH + HORIZONTAL_GAP),
        y: currentY + row * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    }

    currentY += rowCount * (NODE_HEIGHT + ROW_GAP) - ROW_GAP + VERTICAL_GAP;
  }

  const posMap = new Map(layoutNodes.map((n) => [n.id, n]));

  const layoutEdges: LayoutEdge[] = edges
    .filter((e) => posMap.has(e.from) && posMap.has(e.to))
    .map((e) => {
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
        type: e.type,
        points: [
          { x: startX, y: startY },
          { x: startX, y: midY },
          { x: endX, y: midY },
          { x: endX, y: endY },
        ],
      };
    });

  const maxRight = Math.max(...layoutNodes.map((n) => n.x + n.width), 0);
  const maxBottom = Math.max(...layoutNodes.map((n) => n.y + n.height), 0);

  const width = maxRight + PADDING;
  const height = maxBottom + PADDING;

  return { nodes: layoutNodes, edges: layoutEdges, width, height };
}
