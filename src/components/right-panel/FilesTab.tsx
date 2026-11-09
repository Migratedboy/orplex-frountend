"use client";

/**
 * FilesTab.tsx — the Files tab of the right panel: the open workspace folder
 * as a tree with a name filter. Moved verbatim from RightPanel.tsx (behavior
 * unchanged in P1; lazy tree + create/upload/rename land in P3).
 */
import { useState, useEffect } from "react";
import { useFileSystemContext } from "../FileSystemProvider";
import { FilesPanelSkeleton } from "../PanelSkeletons";

export function FilesTab() {
  const { fileTree, activeFilePath, setActiveFilePath, readFile, directoryName } = useFileSystemContext();
  const [filter, setFilter] = useState("");

  const filteredTree = fileTree.filter(n =>
    n.name.toLowerCase().includes(filter.toLowerCase())
  );

  const noFolder = !directoryName && fileTree.length === 0;

  // A folder can be mapped while its tree is still streaming in. Render the
  // skeleton until the first non-empty tree lands so the panel doesn't show
  // "No files found" for a second and then snap to the real listing.
  const [treeSettled, setTreeSettled] = useState(false);
  useEffect(() => { if (fileTree.length > 0) setTreeSettled(true); }, [fileTree.length]);
  if (!noFolder && !treeSettled) return <FilesPanelSkeleton />;

  return (
    <div className="rp-files">
      <div className="rp-files-search">
        <input
          className="rp-files-input"
          placeholder="Filter files"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>
      <div className="rp-files-tree">
        {noFolder ? (
          <div className="rp-empty">No folder opened — use Open in the sidebar</div>
        ) : (
          <>
            {filteredTree.map(node => (
              <FileNodeItem key={node.path} node={node} depth={0} filter={filter} onSelect={(path) => {
                setActiveFilePath(path);
                readFile(path);
              }} activePath={activeFilePath} />
            ))}
            {filteredTree.length === 0 && <div className="rp-empty">No files found</div>}
          </>
        )}
      </div>
    </div>
  );
}

function FileNodeItem({ node, depth, filter, onSelect, activePath }: {
  node: any; depth: number; filter: string; onSelect: (path: string) => void; activePath: string | null;
}) {
  const [collapsed, setCollapsed] = useState(depth > 0);
  const isActive = activePath === node.path;

  if (node.kind === "directory") {
    const children = node.children?.filter((c: any) =>
      c.name.toLowerCase().includes(filter.toLowerCase())
    ) || [];
    return (
      <div>
        <div
          className={`rp-file-item ${isActive ? "rp-file-active" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="rp-file-arrow">{collapsed ? ">" : "v"}</span>
          <span className="rp-file-name">{node.name}</span>
        </div>
        {!collapsed && children.map((child: any) => (
          <FileNodeItem key={child.path} node={child} depth={depth + 1} filter={filter} onSelect={onSelect} activePath={activePath} />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`rp-file-item ${isActive ? "rp-file-active" : ""}`}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
      onClick={() => onSelect(node.path)}
    >
      <span className="rp-file-icon">-</span>
      <span className="rp-file-name">{node.name}</span>
    </div>
  );
}
