import { useState, useEffect } from "react";
import type { GraphNode, DirEntry } from "./types";

interface Props {
  node: GraphNode;
  linkedNodes: GraphNode[];
  onNavigateNode: (id: string) => void;
}

export function FileExplorer({ node, linkedNodes, onNavigateNode }: Props) {
  const [browsePath, setBrowsePath] = useState<string | null>(null);

  useEffect(() => {
    setBrowsePath(null);
  }, [node.id]);

  const isOutput = node.type === "output";
  const fields: [string, string | null | undefined][] = isOutput
    ? [
        ["contentHash", node.contentHash],
        ["contentPath", node.contentPath],
      ]
    : [
        ["drvPath", node.drvPath],
        ["contentHash", node.contentHash],
        ["contentPath", node.contentPath],
      ];

  return (
    <div className="p-4">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-gray-900">{node.label}</h3>
        <span className="text-[11px] text-gray-400 break-all">{node.id}</span>
      </div>

      {!browsePath && (
        <>
          {/* Linked counterparts */}
          {linkedNodes.length > 0 && (
            <div className="mb-4 space-y-2">
              <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide">
                {linkedNodes[0].type === "output" ? "CA Output" : `Resolved Recipe${linkedNodes.length > 1 ? "s" : ""}`}
              </div>
              {linkedNodes.map((ln) => (
                <button
                  key={ln.id}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-dashed border-gray-300 bg-white hover:bg-gray-50 cursor-pointer"
                  onClick={() => onNavigateNode(ln.id)}
                >
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="text-[13px] font-medium text-gray-800 truncate">
                      {ln.label.replace(/ \(resolved\)$/, "")}
                    </div>
                    <span className={`text-[11px] shrink-0 ml-2 ${ln.type === "output" ? "text-blue-500" : "text-orange-500"}`}>Switch &rarr;</span>
                  </div>
                  {ln.contentHash && (
                    <div className="text-[11px] text-gray-400 font-mono truncate">
                      {ln.contentHash}
                    </div>
                  )}
                  {ln.resolvedRecipe && (
                    <div className="text-[11px] text-gray-500 font-mono truncate mt-0.5">
                      {ln.resolvedRecipe.canonicalCmd}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {fields.map(([key, val]) =>
              val ? (
                <div key={key}>
                  <div className="text-[11px] text-gray-400">{key}</div>
                  <div className="text-[13px] text-gray-700 break-all font-mono">{val}</div>
                </div>
              ) : null,
            )}

            {node.contentPath && (
              <button
                className="mt-3 border border-gray-300 text-gray-600 px-3 py-1.5 rounded text-[13px] cursor-pointer hover:bg-gray-100"
                onClick={() => setBrowsePath(node.contentPath!)}
              >
                Browse output
              </button>
            )}
          </div>

          {node.resolvedRecipe && (
            <div className="mt-4 pt-3 border-t border-gray-200">
              <div className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-2">
                Resolved Recipe
              </div>
              <pre className="text-[12px] text-gray-600 font-mono whitespace-pre-wrap break-all bg-white rounded border border-gray-200 p-2">
                {JSON.stringify(node.resolvedRecipe, null, 2)}
              </pre>
            </div>
          )}
        </>
      )}

      {browsePath && (
        <div>
          <button
            className="border border-gray-300 text-gray-500 px-3 py-1 rounded text-[13px] cursor-pointer mb-3 hover:bg-gray-100"
            onClick={() => setBrowsePath(null)}
          >
            &larr; Back
          </button>
          <RemoteDir path={browsePath} />
        </div>
      )}
    </div>
  );
}

function RemoteDir({ path }: { path: string }) {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ name: string; path: string } | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);

  useEffect(() => {
    setEntries(null);
    setError(null);
    setSelectedFile(null);
    fetch(`/api/ls?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setEntries(data);
        else setError(data.error || "Failed to read directory");
      })
      .catch((e) => setError(e.message));
  }, [path]);

  useEffect(() => {
    if (!selectedFile) { setFileContent(null); return; }
    fetch(`/api/read?path=${encodeURIComponent(selectedFile.path)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.content) setFileContent(data.content);
        else setFileContent(`[Cannot read: ${data.error || "unknown error"}]`);
      })
      .catch(() => setFileContent("[Failed to fetch file]"));
  }, [selectedFile]);

  if (error) return <div className="text-gray-400 text-[13px]">Error: {error}</div>;
  if (!entries) return <div className="text-gray-400 text-[13px]">Loading...</div>;

  if (selectedFile && fileContent !== null) {
    const isJson = selectedFile.name.endsWith(".json");
    return (
      <div>
        <button
          className="border border-gray-300 text-gray-500 px-3 py-1 rounded text-[13px] cursor-pointer mb-3 hover:bg-gray-100"
          onClick={() => setSelectedFile(null)}
        >
          &larr; Back
        </button>
        <div className="text-sm font-semibold text-gray-900 mb-3 pb-2 border-b border-gray-200">{selectedFile.name}</div>
        {isJson ? (
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-gray-600">
            {(() => {
              try { return <JsonTree data={JSON.parse(fileContent)} />; }
              catch { return fileContent; }
            })()}
          </pre>
        ) : (
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-gray-600">{fileContent}</pre>
        )}
      </div>
    );
  }

  function formatSize(size?: number) {
    if (size === undefined) return "";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
    return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => (
        <li
          key={entry.name}
          className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[13px] hover:bg-gray-100"
          onClick={() => {
            if (entry.type === "file" || (entry.type === "symlink" && !entry.isDir)) {
              setSelectedFile({ name: entry.name, path: `${path}/${entry.name}` });
            }
          }}
        >
          <span className="text-base shrink-0">
            {entry.type === "directory" || entry.isDir
              ? "\u{1F4C1}"
              : entry.type === "symlink"
                ? "\u{1F517}"
                : "\u{1F4C4}"}
          </span>
          <span className="font-medium text-gray-700 truncate">{entry.name}</span>
          {entry.size !== undefined && (
            <span className="text-[11px] text-gray-400 ml-auto shrink-0">{formatSize(entry.size)}</span>
          )}
        </li>
      ))}
      {entries.length === 0 && <li className="text-gray-400 text-[13px]">(empty)</li>}
    </ul>
  );
}

function JsonTree({ data, indent = 0 }: { data: unknown; indent?: number }) {
  const pad = "  ".repeat(indent);

  if (data === null) return <span className="text-red-400">{pad}null</span>;
  if (typeof data === "boolean")
    return <span className="text-purple-500">{pad}{String(data)}</span>;
  if (typeof data === "number")
    return <span className="text-amber-600">{pad}{data}</span>;
  if (typeof data === "string")
    return (
      <span className="text-green-600">
        {pad}&quot;{data}&quot;
      </span>
    );

  if (Array.isArray(data)) {
    if (data.length === 0) return <span>{pad}[]</span>;
    return (
      <span>
        {"[\n"}
        {data.map((item, i) => (
          <span key={i}>
            {"  ".repeat(indent + 1)}
            <JsonTree data={item} indent={indent + 1} />
            {i < data.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {pad}]
      </span>
    );
  }

  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span>{pad}{"{}"}</span>;
    return (
      <span>
        {"{\n"}
        {entries.map(([key, val], i) => (
          <span key={key}>
            {"  ".repeat(indent + 1)}
            <span className="text-sky-600">&quot;{key}&quot;</span>
            {": "}
            <JsonTree data={val} indent={indent + 1} />
            {i < entries.length - 1 ? ",\n" : "\n"}
          </span>
        ))}
        {pad}
        {"}"}
      </span>
    );
  }

  return <span>{String(data)}</span>;
}
