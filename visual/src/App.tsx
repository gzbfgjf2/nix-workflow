import { useEffect, useMemo, useState } from "react";
import type { GraphData, GraphNode, GraphEdge } from "./types";
import { computeLayout } from "./layout";
import { DagView } from "./DagView";
import { FileExplorer } from "./FileExplorer";
import { demoData } from "./demo-data";

type ViewMode = "ca" | "recipe";

export function App() {
  const [data, setData] = useState<GraphData | null>(null);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("ca");

  useEffect(() => {
    if (demo) {
      setData(demoData);
      setLoading(false);
      setSelectedNodeId(null);
      return;
    }
    setLoading(true);
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => {
        setData(demoData);
        setDemo(true);
        setLoading(false);
      });
  }, [demo]);

  // Build resolved nodes with cleaned labels
  const resolvedNodes = useMemo(() => {
    if (!data) return [];
    return data.nodes
      .filter((n) => n.type === "resolved")
      .map((n) => {
        let label = n.label.replace(/ \(resolved\)$/, "");
        // Try to get label from the recipe node via cross edge
        const crossEdge = data.edges.find((e) => e.type === "cross" && e.to === n.id);
        if (crossEdge) {
          const recipe = data.nodes.find((r) => r.id === crossEdge.from);
          if (recipe) label = recipe.label;
        }
        return { ...n, label };
      });
  }, [data]);

  // Build CA output nodes (one per unique contentHash)
  const { outputNodes, hashToOutputId, resolvedIdToHash } = useMemo(() => {
    const hashToNode = new Map<string, GraphNode>();
    const r2h = new Map<string, string>();
    for (const n of resolvedNodes) {
      if (!n.contentHash) continue;
      r2h.set(n.id, n.contentHash);
      if (!hashToNode.has(n.contentHash)) {
        hashToNode.set(n.contentHash, {
          id: `output:${n.contentHash}`,
          label: n.label,
          type: "output",
          contentHash: n.contentHash,
          contentPath: n.contentPath,
        });
      } else {
        // Merge labels for multiple recipes producing same output
        const existing = hashToNode.get(n.contentHash)!;
        if (!existing.label.includes(n.label)) {
          hashToNode.set(n.contentHash, {
            ...existing,
            label: `${existing.label}, ${n.label}`,
          });
        }
      }
    }
    return {
      outputNodes: [...hashToNode.values()],
      hashToOutputId: new Map([...hashToNode.entries()].map(([h, n]) => [h, n.id])),
      resolvedIdToHash: r2h,
    };
  }, [resolvedNodes]);

  const filteredData = useMemo(() => {
    if (!data) return null;

    if (viewMode === "ca") {
      // CA output DAG: edges between outputs derived from resolved recipe edges
      const edgeSet = new Set<string>();
      const edges: GraphEdge[] = [];
      for (const e of data.edges.filter((e) => e.type === "resolved")) {
        const fromHash = resolvedIdToHash.get(e.from);
        const toHash = resolvedIdToHash.get(e.to);
        if (!fromHash || !toHash || fromHash === toHash) continue;
        const from = hashToOutputId.get(fromHash)!;
        const to = hashToOutputId.get(toHash)!;
        const key = `${from}->${to}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({ from, to, type: "resolved" });
      }
      return { nodes: outputNodes, edges };
    }

    // Recipe view: resolved recipe DAG
    return {
      nodes: resolvedNodes,
      edges: data.edges.filter((e) => e.type === "resolved"),
    };
  }, [data, viewMode, resolvedNodes, outputNodes, resolvedIdToHash, hashToOutputId]);

  const layout = useMemo(() => (filteredData ? computeLayout(filteredData) : null), [filteredData]);

  const connectedIds = useMemo(() => {
    if (!filteredData || !selectedNodeId) return new Set<string>();
    const ids = new Set<string>();
    for (const e of filteredData.edges) {
      if (e.from === selectedNodeId) ids.add(e.to);
      if (e.to === selectedNodeId) ids.add(e.from);
    }
    return ids;
  }, [filteredData, selectedNodeId]);

  const selectedNode = selectedNodeId
    ? filteredData?.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  // Linked nodes: CA output → all resolved recipes, resolved recipe → its CA output
  const linkedNodes = useMemo((): GraphNode[] => {
    if (!selectedNodeId || !selectedNode) return [];

    if (viewMode === "ca") {
      const hash = selectedNode.contentHash;
      if (!hash) return [];
      return resolvedNodes.filter((n) => n.contentHash === hash);
    }

    const hash = resolvedIdToHash.get(selectedNodeId);
    if (!hash) return [];
    const output = outputNodes.find((n) => n.contentHash === hash);
    return output ? [output] : [];
  }, [selectedNodeId, selectedNode, viewMode, resolvedNodes, outputNodes, resolvedIdToHash]);

  // Sibling recipe IDs: other resolved recipes that produce the same CA output
  const siblingIds = useMemo((): string[] => {
    if (!selectedNodeId || viewMode !== "recipe") return [];
    const hash = resolvedIdToHash.get(selectedNodeId);
    if (!hash) return [];
    return resolvedNodes
      .filter((n) => n.id !== selectedNodeId && n.contentHash === hash)
      .map((n) => n.id);
  }, [selectedNodeId, viewMode, resolvedNodes, resolvedIdToHash]);

  const handleViewSwitch = (mode: ViewMode) => {
    setSelectedNodeId(null);
    setViewMode(mode);
  };

  const handleNavigateNode = (id: string) => {
    // Navigate between CA output and recipe views
    if (id.startsWith("output:")) {
      setViewMode("ca");
      setSelectedNodeId(id);
    } else {
      setViewMode("recipe");
      setSelectedNodeId(id);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-screen text-gray-400 text-sm">Loading graph...</div>;
  }

  return (
    <div className="flex h-screen bg-white text-gray-800 font-sans">
      <div className="flex-[7] overflow-auto flex flex-col items-start">
        <div className="flex items-center gap-1 p-3 sticky top-0 bg-white z-10">
          <button
            className={`px-3.5 py-1 rounded text-xs border cursor-pointer ${!demo ? "bg-gray-800 border-gray-600 text-white" : "bg-gray-100 border-gray-300 text-gray-500 hover:bg-gray-200"}`}
            onClick={() => setDemo(false)}
          >
            Live
          </button>
          <button
            className={`px-3.5 py-1 rounded text-xs border cursor-pointer ${demo ? "bg-gray-800 border-gray-600 text-white" : "bg-gray-100 border-gray-300 text-gray-500 hover:bg-gray-200"}`}
            onClick={() => setDemo(true)}
          >
            Demo
          </button>

          <div className="w-px h-5 bg-gray-200 mx-1.5" />

          <button
            className={`px-3.5 py-1 rounded text-xs border cursor-pointer ${viewMode === "ca" ? "bg-blue-600 border-blue-500 text-white" : "bg-gray-100 border-gray-300 text-gray-500 hover:bg-gray-200"}`}
            onClick={() => handleViewSwitch("ca")}
          >
            Content Addressing
          </button>
          <button
            className={`px-3.5 py-1 rounded text-xs border cursor-pointer ${viewMode === "recipe" ? "bg-orange-600 border-orange-500 text-white" : "bg-gray-100 border-gray-300 text-gray-500 hover:bg-gray-200"}`}
            onClick={() => handleViewSwitch("recipe")}
          >
            Recipe
          </button>
        </div>
        {layout && (
          <DagView
            layout={layout}
            viewMode={viewMode}
            selectedNode={selectedNodeId}
            connectedNodes={connectedIds}
            linkedNodes={linkedNodes}
            siblingIds={siblingIds}
            onSelectNode={setSelectedNodeId}
            onNavigateNode={handleNavigateNode}
          />
        )}
      </div>
      <div className="flex-[3] min-w-80 border-l border-gray-200 overflow-y-auto bg-gray-50">
        {selectedNode ? (
          <FileExplorer
            node={selectedNode}
            linkedNodes={linkedNodes}
            onNavigateNode={handleNavigateNode}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">Click a node to inspect</div>
        )}
      </div>
    </div>
  );
}
