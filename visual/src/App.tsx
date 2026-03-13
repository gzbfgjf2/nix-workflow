import { useEffect, useMemo, useState } from "react";
import type { GraphData } from "./types";
import { computeLayout } from "./layout";
import { DagView } from "./DagView";
import { FileExplorer } from "./FileExplorer";
import { demoData } from "./demo-data";

export function App() {
  const [data, setData] = useState<GraphData | null>(null);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

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

  const layout = useMemo(() => (data ? computeLayout(data) : null), [data]);

  const connectedIds = useMemo(() => {
    if (!data || !selectedNodeId) return new Set<string>();
    const ids = new Set<string>();
    for (const e of data.edges) {
      if (e.from === selectedNodeId) ids.add(e.to);
      if (e.to === selectedNodeId) ids.add(e.from);
    }
    return ids;
  }, [data, selectedNodeId]);

  const selectedNode = selectedNodeId
    ? data?.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  if (loading) {
    return <div className="flex items-center justify-center h-screen text-gray-400 text-sm">Loading graph...</div>;
  }

  return (
    <div className="flex h-screen bg-white text-gray-800 font-sans">
      <div className="flex-[7] overflow-auto flex flex-col items-start">
        <div className="flex gap-1 p-3 sticky top-0 bg-white z-10">
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
        </div>
        {layout && (
          <DagView
            layout={layout}
            selectedNode={selectedNodeId}
            connectedNodes={connectedIds}
            onSelectNode={setSelectedNodeId}
          />
        )}
      </div>
      <div className="flex-[3] min-w-80 border-l border-gray-200 overflow-y-auto bg-gray-50">
        {selectedNode ? (
          <FileExplorer node={selectedNode} onNavigateNode={setSelectedNodeId} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">Click a node to explore its files</div>
        )}
      </div>
    </div>
  );
}
