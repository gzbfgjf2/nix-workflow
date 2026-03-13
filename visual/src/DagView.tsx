import type { Layout } from "./types";

interface Props {
  layout: Layout;
  selectedNode: string | null;
  connectedNodes: Set<string>;
  onSelectNode: (id: string) => void;
}

export function DagView({ layout, selectedNode, connectedNodes, onSelectNode }: Props) {
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      style={{ width: layout.width, height: layout.height, flexShrink: 0 }}
    >
      <defs>
        <marker id="arrow" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
          <polygon points="0 0, 6 2, 0 4" fill="#94a3b8" />
        </marker>
        <marker id="arrow-hl" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
          <polygon points="0 0, 6 2, 0 4" fill="#111827" />
        </marker>
      </defs>

      {layout.edges.map((edge, i) => {
        const [start, cp1, cp2, end] = edge.points;
        const d = `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;
        const isHighlighted =
          selectedNode !== null &&
          (edge.from === selectedNode || edge.to === selectedNode);
        return (
          <path
            key={i}
            d={d}
            fill="none"
            stroke={isHighlighted ? "#111827" : "#cbd5e1"}
            strokeWidth={0.75}
            markerEnd={isHighlighted ? "url(#arrow-hl)" : "url(#arrow)"}
          />
        );
      })}

      {layout.nodes.map((node) => {
        const isSelected = node.id === selectedNode;
        const isConnected = connectedNodes.has(node.id);

        let fill = "#ffffff";
        let stroke = "#d1d5db";
        let textFill = "#374151";
        if (isSelected) { fill = "#111827"; stroke = "#111827"; textFill = "#ffffff"; }
        else if (isConnected) { fill = "#f3f4f6"; stroke = "#6b7280"; textFill = "#111827"; }

        return (
          <g
            key={node.id}
            onClick={() => onSelectNode(node.id)}
            style={{ cursor: "pointer" }}
          >
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
            >
              {node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
