import { useState, useEffect } from "react";
import type { GraphNode, DirEntry } from "./types";

interface Props {
  node: GraphNode;
  onNavigateNode: (id: string) => void;
}

type View =
  | { kind: "list" }
  | { kind: "file"; name: string }
  | { kind: "remote-dir"; path: string; name: string };

export function FileExplorer({ node, onNavigateNode }: Props) {
  const [view, setView] = useState<View>({ kind: "list" });

  useEffect(() => {
    setView({ kind: "list" });
  }, [node.id]);

  const fileEntries = Object.entries(node.files).sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return (
    <div className="p-4">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-gray-900">{node.label}</h3>
        <span className="text-[11px] text-gray-400 break-all">{node.id}</span>
      </div>

      {view.kind === "list" && (
        <ul className="space-y-0.5">
          {fileEntries.map(([name, entry]) => (
            <li
              key={name}
              className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[13px] hover:bg-gray-100"
              onClick={() => {
                if (entry.type === "file" || entry.type === "directory") {
                  setView({ kind: "file", name });
                } else if (entry.type === "symlink" && entry.resolvedDir) {
                  setView({ kind: "remote-dir", path: entry.target!, name });
                }
              }}
            >
              <span className="text-base shrink-0">
                {entry.type === "directory"
                  ? "\u{1F4C1}"
                  : entry.type === "symlink"
                    ? entry.resolvedDir
                      ? "\u{1F4C2}"
                      : "\u{1F517}"
                    : "\u{1F4C4}"}
              </span>
              <span className="font-medium text-gray-700 truncate">{name}</span>
              <span className="text-[11px] text-gray-400 ml-auto shrink-0">{entry.type}</span>
              {entry.type === "symlink" && entry.target && (
                <span className="text-[11px] text-gray-400 max-w-48 truncate">&rarr; {entry.target}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {view.kind === "file" && node.files[view.name] && (
        <div className="mt-3">
          <BackButton onClick={() => setView({ kind: "list" })} />
          <div className="text-sm font-semibold text-gray-900 mb-3 pb-2 border-b border-gray-200">{view.name}</div>
          <FileContent name={view.name} entry={node.files[view.name]} onNavigateNode={onNavigateNode} />
        </div>
      )}

      {view.kind === "remote-dir" && node.files[view.name] && (
        <div className="mt-3">
          <BackButton onClick={() => setView({ kind: "list" })} />
          <div className="text-sm font-semibold text-gray-900 mb-3 pb-2 border-b border-gray-200">{view.name}</div>
          <RemoteDir path={view.path} />
        </div>
      )}
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="border border-gray-300 text-gray-500 px-3 py-1 rounded text-[13px] cursor-pointer mb-3 hover:bg-gray-100"
      onClick={onClick}
    >
      &larr; Back
    </button>
  );
}

function FileContent({
  name,
  entry,
  onNavigateNode,
}: {
  name: string;
  entry: { type: string; content?: string | null; children?: string[] };
  onNavigateNode: (id: string) => void;
}) {
  if (entry.type === "directory" && entry.children) {
    return (
      <div className="text-[13px]">
        <p className="text-gray-400 mb-2">Contents:</p>
        <ul>
          {entry.children.map((child) => (
            <li
              key={child}
              className="py-1.5 px-2 text-xs text-gray-600 break-all rounded cursor-pointer hover:bg-gray-100 hover:text-gray-900"
              onClick={() => onNavigateNode(child)}
            >
              {"\u{1F517}"} {child}
            </li>
          ))}
          {entry.children.length === 0 && (
            <li className="text-gray-400 text-[13px]">(empty)</li>
          )}
        </ul>
      </div>
    );
  }

  if (!entry.content) {
    return <div className="text-gray-400 text-[13px]">No content available</div>;
  }

  if (name.endsWith(".json")) {
    try {
      const parsed = JSON.parse(entry.content);
      return (
        <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-gray-600">
          <JsonTree data={parsed} />
        </pre>
      );
    } catch {
      // fall through
    }
  }

  return <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-gray-600">{entry.content}</pre>;
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
        <BackButton onClick={() => setSelectedFile(null)} />
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
