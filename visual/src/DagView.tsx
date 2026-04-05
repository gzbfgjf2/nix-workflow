import type { GraphNode, Layout } from "./types";

const LABEL_MAX_CHARS = 22;

function truncateLabel(label: string): string {
  if (label.length <= LABEL_MAX_CHARS) return label;
  // Try to break at a word boundary
  const truncated = label.slice(0, LABEL_MAX_CHARS);
  const lastSpace = truncated.lastIndexOf("_");
  const cut = lastSpace > LABEL_MAX_CHARS / 2 ? lastSpace : LABEL_MAX_CHARS;
  return label.slice(0, cut) + "…";
}

interface Props {
  layout: Layout;
  viewMode: "ca" | "recipe";
  selectedNode: string | null;
  connectedNodes: Set<string>;
  linkedNodes: GraphNode[];
  siblingIds: string[];
  onSelectNode: (id: string) => void;
  onNavigateNode: (id: string) => void;
}

// Layout constants matching layout.ts
const LN_W = 200;
const LN_H = 50;
const LN_HGAP = 60;
const LN_VGAP = 80;
const LN_PADDING = 40;
const LN_MAX_COLS = 3;

export function DagView({ layout, viewMode, selectedNode, connectedNodes, linkedNodes, siblingIds, onSelectNode, onNavigateNode }: Props) {
  const selectedLayoutNode = selectedNode ? layout.nodes.find((n) => n.id === selectedNode) : null;
  const hasLinked = linkedNodes.length > 0 && selectedLayoutNode;

  // Linked nodes: start from top, flow left-to-right, wrap rows
  const linkedBaseX = layout.width + LN_PADDING;
  const linkedCols = Math.min(linkedNodes.length, LN_MAX_COLS);
  const linkedRows = Math.ceil(linkedNodes.length / LN_MAX_COLS);
  const linkedPanelW = linkedCols * LN_W + (linkedCols - 1) * LN_HGAP + LN_PADDING;
  const linkedPanelH = linkedRows * LN_H + (linkedRows - 1) * LN_VGAP;

  const totalWidth = hasLinked ? linkedBaseX + linkedPanelW : layout.width;
  const totalHeight = hasLinked ? Math.max(layout.height, LN_PADDING + linkedPanelH + LN_PADDING) : layout.height;

  return (
    <svg
      viewBox={`0 0 ${totalWidth} ${totalHeight}`}
      style={{ width: totalWidth, height: totalHeight, flexShrink: 0 }}
    >
      <defs>
        <marker id="arrow-ca" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
          <polygon points="0 0, 6 2, 0 4" fill="#3b82f6" />
        </marker>
        <marker id="arrow-ca-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#1d4ed8" />
        </marker>
        <marker id="arrow-recipe" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
          <polygon points="0 0, 6 2, 0 4" fill="#ea580c" />
        </marker>
        <marker id="arrow-recipe-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#c2410c" />
        </marker>
      </defs>

      {layout.edges.map((edge, i) => {
        const [start, cp1, cp2, end] = edge.points;
        const d = `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;
        const isHighlighted =
          selectedNode !== null &&
          (edge.from === selectedNode || edge.to === selectedNode);

        let color: string;
        let marker: string;
        if (viewMode === "ca") {
          color = isHighlighted ? "#1d4ed8" : "#3b82f6";
          marker = isHighlighted ? "url(#arrow-ca-hl)" : "url(#arrow-ca)";
        } else {
          color = isHighlighted ? "#c2410c" : "#ea580c";
          marker = isHighlighted ? "url(#arrow-recipe-hl)" : "url(#arrow-recipe)";
        }

        return (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={isHighlighted ? 3 : 0.75}
            markerEnd={marker}
          />
        );
      })}

      {layout.nodes.map((node) => {
        const isSelected = node.id === selectedNode;
        const isConnected = connectedNodes.has(node.id);
        const isSibling = siblingIds.includes(node.id);
        const isCA = viewMode === "ca";

        let fill: string, stroke: string, textFill: string;
        if (isCA) {
          if (isSelected) {
            fill = "#1d4ed8"; stroke = "#1d4ed8"; textFill = "#ffffff";
          } else if (isConnected) {
            fill = "#bfdbfe"; stroke = "#2563eb"; textFill = "#1e3a5f";
          } else {
            fill = "#dbeafe"; stroke = "#3b82f6"; textFill = "#1e3a5f";
          }
        } else {
          if (isSelected) {
            fill = "#c2410c"; stroke = "#c2410c"; textFill = "#ffffff";
          } else if (isSibling) {
            fill = "#fed7aa"; stroke = "#ea580c"; textFill = "#7c2d12";
          } else if (isConnected) {
            fill = "#fed7aa"; stroke = "#f97316"; textFill = "#7c2d12";
          } else {
            fill = "#ffedd5"; stroke = "#ea580c"; textFill = "#7c2d12";
          }
        }

        const clipId = `clip-${node.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
        return (
          <g
            key={node.id}
            onClick={() => onSelectNode(node.id)}
            style={{ cursor: "pointer" }}
          >
            <title>{node.label}</title>
            <clipPath id={clipId}>
              <rect x={node.x + 8} y={node.y} width={node.width - 16} height={node.height} />
            </clipPath>
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              rx={4}
              ry={4}
              fill={fill}
              stroke={stroke}
              strokeWidth={isSelected ? 1.5 : 0.75}
            />
            <text
              x={node.x + node.width / 2}
              y={node.y + node.height / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fill={textFill}
              fontSize={13}
              fontFamily="system-ui, sans-serif"
              clipPath={`url(#${clipId})`}
            >
              {truncateLabel(node.label)}
            </text>
          </g>
        );
      })}

      {hasLinked && linkedNodes.map((ln, idx) => {
        const isLinkedOutput = ln.type === "output";
        const linkedLabel = ln.label.replace(/ \(resolved\)$/, "");
        const clipId = `clip-linked-${ln.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const fill = isLinkedOutput ? "#dbeafe" : "#ffedd5";
        const stroke = isLinkedOutput ? "#3b82f6" : "#ea580c";
        const col = idx % LN_MAX_COLS;
        const row = Math.floor(idx / LN_MAX_COLS);
        const x = linkedBaseX + col * (LN_W + LN_HGAP);
        const y = LN_PADDING + row * (LN_H + LN_VGAP);

        const fromX = selectedLayoutNode.x + selectedLayoutNode.width;
        const fromY = selectedLayoutNode.y + selectedLayoutNode.height / 2;
        const toX = x;
        const toY = y + LN_H / 2;

        const midX = (fromX + toX) / 2;
        const d = `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;

        return (
          <g key={ln.id}>
            <path
              d={d}
              fill="none"
              stroke="#64748b"
              strokeWidth={0.75}
              strokeDasharray="6 4"
            />
            <g
              onClick={() => onNavigateNode(ln.id)}
              style={{ cursor: "pointer" }}
            >
              <clipPath id={clipId}>
                <rect x={x + 8} y={y} width={LN_W - 16} height={LN_H} />
              </clipPath>
              <rect
                x={x}
                y={y}
                width={LN_W}
                height={LN_H}
                rx={4}
                ry={4}
                fill={fill}
                stroke={stroke}
                strokeWidth={0.75}
                strokeDasharray="6 4"
              />
              <text
                x={x + LN_W / 2}
                y={y + LN_H / 2 - 6}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#374151"
                fontSize={13}
                fontFamily="system-ui, sans-serif"
                clipPath={`url(#${clipId})`}
              >
                {linkedLabel}
              </text>
              <text
                x={x + LN_W / 2}
                y={y + LN_H / 2 + 8}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#374151"
                fontSize={10}
                fontFamily="system-ui, sans-serif"
              >
                {isLinkedOutput ? "CA output" : "resolved recipe"}
              </text>
            </g>
          </g>
        );
      })}

      {/* Sibling lines: from DAG nodes to the first linked node (CA output) */}
      {hasLinked && siblingIds.length > 0 && linkedNodes[0] && (() => {
        const toX = linkedBaseX;
        const toY = LN_PADDING + LN_H / 2;
        return siblingIds.map((sibId) => {
          const sibNode = layout.nodes.find((n) => n.id === sibId);
          if (!sibNode) return null;
          const fromX = sibNode.x + sibNode.width;
          const fromY = sibNode.y + sibNode.height / 2;
          const midX = (fromX + toX) / 2;
          const d = `M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`;
          return (
            <path
              key={`sib-${sibId}`}
              d={d}
              fill="none"
              stroke="#94a3b8"
              strokeWidth={2.5}
              strokeDasharray="0.5 8"
              strokeLinecap="round"
            />
          );
        });
      })()}
    </svg>
  );
}
