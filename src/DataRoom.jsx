import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const CATEGORY_LABELS = {
  brand: "브랜드",
  product: "상품/가격",
  documents: "문서",
  images: "이미지",
  sheets: "시트",
  slides: "슬라이드",
  meeting: "회의",
  uploads: "업로드",
  outputs: "산출물",
  system: "시스템",
};

const dataRoomCache = new Map();
const dataRoomInflight = new Map();
const DRIVE_PLACEHOLDER_FILES = new Set(["README.md", "asset_manifest.csv"]);

function dataRoomCacheKey(path, params, method = "GET") {
  return `${method} ${path}?${new URLSearchParams(params).toString()}`;
}

function getDataRoomCache(key) {
  const entry = dataRoomCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    dataRoomCache.delete(key);
    return null;
  }
  return entry.value;
}

const SPACE_DEFINITIONS = [
  {
    id: "profiles",
    label: "구성원 작업 공간",
    shortLabel: "구성원",
    description: "각 AI 구성원의 개인 초안, 진행 작업, 산출물, 세션 기록",
    matches: ["구성원", "profile"],
  },
  {
    id: "workspace",
    label: "전체 문서",
    shortLabel: "문서",
    description: "GitHub와 동기화되는 공식 문서함과 Archive",
    matches: ["전체 문서", "workspace", "문서"],
  },
  {
    id: "drive",
    label: "데이터 공간",
    shortLabel: "데이터",
    description: "Google Drive 자산 구조와 대용량 이미지, 영상, 시트 자료",
    matches: ["데이터 공간", "google-drive", "drive"],
  },
];

function formatBytes(value = 0) {
  if (value === null || value === undefined) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "기록 없음";
  return new Intl.DateTimeFormat("ko", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}

function dataRoomUrl(path, params) {
  const query = new URLSearchParams(params);
  return `/bridge/data-room/${path}?${query}`;
}

async function fetchJson(path, params = {}, options = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const isRead = method === "GET";
  const ttlMs = options.cacheTtlMs ?? (isRead ? 30000 : 0);
  const key = dataRoomCacheKey(path, params, method);
  if (isRead && ttlMs) {
    const cached = getDataRoomCache(key);
    if (cached) return cached;
  }
  if (isRead && dataRoomInflight.has(key)) return dataRoomInflight.get(key);
  if (!isRead) dataRoomCache.clear();

  const request = (async () => {
    const fetchOptions = { ...options };
    delete fetchOptions.cacheTtlMs;
    const response = await fetch(dataRoomUrl(path, params), { cache: "no-store", ...fetchOptions });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "데이터를 불러오지 못했습니다.");
    if (isRead && ttlMs) dataRoomCache.set(key, { value: payload, expiresAt: Date.now() + ttlMs });
    return payload;
  })();

  if (isRead) {
    dataRoomInflight.set(key, request);
    request.finally(() => dataRoomInflight.delete(key)).catch(() => {});
  }
  return request;
}

function nodeKey(rootId, relativePath = "") {
  return `${rootId}:${relativePath}`;
}

function itemIcon(item) {
  if (item.type === "root") return "workspace";
  if (item.type === "folder") return "folder";
  if (item.kind === "image") return "image";
  if (item.kind === "sheet") return "sheet";
  if (item.kind === "slide") return "slide";
  if (item.kind === "pdf") return "pdf";
  return "file";
}

function sortTreeItems(items = []) {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, "ko");
  });
}

function isMarkdownFile(item) {
  return item?.kind === "text" && /\.(md|markdown|mdown|mkdn)$/i.test(item.name || item.relativePath || "");
}

function renderInlineMarkdown(text, keyPrefix) {
  const parts = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));

    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("**")) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const [, label, href] = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/) || [];
      const safeHref = href && /^(https?:\/\/|mailto:|#|\/)/i.test(href) ? href : undefined;
      parts.push(
        safeHref ? (
          <a key={key} href={safeHref} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          <span key={key}>{label || token}</span>
        ),
      );
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function MarkdownPreview({ content = "", truncated = false }) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let listItems = [];
  let inCode = false;
  let codeLines = [];

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(
      <ul key={`list-${blocks.length}`}>
        {listItems.map((item, index) => (
          <li key={`${item}-${index}`}>
            {item.checkbox !== null && <input type="checkbox" checked={item.checkbox} readOnly />}
            <span>{renderInlineMarkdown(item.text, `li-${blocks.length}-${index}`)}</span>
          </li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  const flushCode = () => {
    blocks.push(
      <pre key={`code-${blocks.length}`}>
        <code>{codeLines.join("\n")}</code>
      </pre>,
    );
    codeLines = [];
  };

  lines.forEach((line, index) => {
    if (/^```/.test(line.trim())) {
      flushList();
      if (inCode) flushCode();
      inCode = !inCode;
      return;
    }

    if (inCode) {
      codeLines.push(line);
      return;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const HeadingTag = `h${level}`;
      blocks.push(
        <HeadingTag key={`h-${index}`}>
          {renderInlineMarkdown(heading[2], `h-${index}`)}
        </HeadingTag>,
      );
      return;
    }

    const list = /^\s*[-*]\s+(\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (list) {
      const marker = list[1];
      listItems.push({
        checkbox: marker ? /\[[xX]\]/.test(marker) : null,
        text: list[2],
      });
      return;
    }

    const quote = /^>\s?(.+)$/.exec(line);
    if (quote) {
      flushList();
      blocks.push(
        <blockquote key={`q-${index}`}>
          {renderInlineMarkdown(quote[1], `q-${index}`)}
        </blockquote>,
      );
      return;
    }

    if (!line.trim()) {
      flushList();
      return;
    }

    flushList();
    blocks.push(<p key={`p-${index}`}>{renderInlineMarkdown(line, `p-${index}`)}</p>);
  });

  flushList();
  if (inCode || codeLines.length) flushCode();

  return (
    <article className="markdown-preview">
      {blocks.length ? blocks : <p>No preview content.</p>}
      {truncated && <p className="markdown-preview-note">...preview truncated</p>}
    </article>
  );
}

function spaceForRoot(root) {
  return SPACE_DEFINITIONS.find((space) => (
    space.matches.some((keyword) => root.label.toLowerCase().includes(keyword.toLowerCase()))
  )) || null;
}

function rootForSpace(roots, spaceId) {
  return roots.find((root) => spaceForRoot(root)?.id === spaceId) ?? null;
}

function meaningfulSpaceItems(spaceId, items = []) {
  if (spaceId !== "drive") return items;
  return items.filter((item) => !DRIVE_PLACEHOLDER_FILES.has(item.name));
}

function TreeNode({
  node,
  depth,
  selectedKey,
  expandedKeys,
  loadingKeys,
  childrenMap,
  onToggle,
  onSelect,
}) {
  const key = nodeKey(node.rootId, node.relativePath);
  const expanded = expandedKeys.has(key);
  const loading = loadingKeys.has(key);
  const children = childrenMap[key] || [];
  const isFolderLike = node.type === "root" || node.type === "folder";

  return (
    <div className="data-tree-node">
      <button
        type="button"
        className={`${selectedKey === key ? "active" : ""} ${node.type}`}
        style={{ "--depth": depth }}
        onClick={() => {
          if (isFolderLike) onToggle(node);
          onSelect(node);
        }}
      >
        <span className="tree-caret">{isFolderLike ? (expanded ? "▾" : "▸") : ""}</span>
        <span className={`tree-icon ${itemIcon(node)}`} aria-hidden="true" />
        <strong>{node.name}</strong>
        {loading && <em>읽는 중</em>}
      </button>
      {expanded && children.length > 0 && (
        <div className="data-tree-children">
          {children.map((child) => (
            <TreeNode
              key={nodeKey(child.rootId, child.relativePath)}
              node={child}
              depth={depth + 1}
              selectedKey={selectedKey}
              expandedKeys={expandedKeys}
              loadingKeys={loadingKeys}
              childrenMap={childrenMap}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function DataRoom({ onStartChat, onStartMeeting }) {
  const [activeSpace, setActiveSpace] = useState("profiles");
  const [query, setQuery] = useState("");
  const [searchData, setSearchData] = useState({ files: [], roots: [] });
  const [browseData, setBrowseData] = useState({ roots: [], root: null, path: [], relativePath: "", items: [] });
  const [rootIndex, setRootIndex] = useState(0);
  const [folderPath, setFolderPath] = useState("");
  const [childrenMap, setChildrenMap] = useState({});
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  const [loadingKeys, setLoadingKeys] = useState(() => new Set());
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [driveStatus, setDriveStatus] = useState(null);
  const [driveRefreshVersion, setDriveRefreshVersion] = useState(0);
  const driveReadyKeyRef = useRef("");

  const isSearching = query.trim().length > 0;

  useEffect(() => {
    let ignore = false;
    const loadStatus = () => fetchJson("drive-status", {}, { cacheTtlMs: 0 })
      .then((payload) => { if (!ignore) setDriveStatus(payload); })
      .catch(() => { if (!ignore) setDriveStatus(null); });
    loadStatus();
    const timer = window.setInterval(loadStatus, 15000);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, []);

  const normalizeBrowseItems = useCallback((items, rootId) => sortTreeItems(items.map((item) => ({
    ...item,
    rootId,
  }))), []);

  const roots = browseData.roots.length ? browseData.roots : searchData.roots;
  const availableSpaces = useMemo(() => SPACE_DEFINITIONS.map((space) => ({
    ...space,
    root: rootForSpace(roots, space.id),
  })), [roots]);

  const activeSpaceMeta = availableSpaces.find((space) => space.id === activeSpace) ?? availableSpaces[0] ?? SPACE_DEFINITIONS[1];
  const activeRootIds = useMemo(() => new Set(activeSpaceMeta?.root ? [activeSpaceMeta.root.id] : []), [activeSpaceMeta]);
  const activeRootKey = activeSpaceMeta?.root ? nodeKey(activeSpaceMeta.root.id, "") : "";
  const activeRootLoaded = Boolean(activeRootKey) && Object.prototype.hasOwnProperty.call(childrenMap, activeRootKey);
  const activeRootItems = activeRootLoaded ? childrenMap[activeRootKey] : [];
  const activeSpaceEmpty = activeRootLoaded && meaningfulSpaceItems(activeSpaceMeta?.id, activeRootItems).length === 0;

  const loadTreeChildren = useCallback((rootId, relativePath = "", force = false) => {
    const key = nodeKey(rootId, relativePath);
    if (!force && (childrenMap[key] || loadingKeys.has(key))) return;
    setLoadingKeys((current) => new Set([...current, key]));
    fetchJson("browse", { root: rootId, path: relativePath }, { cacheTtlMs: force ? 0 : undefined })
      .then((payload) => {
        setChildrenMap((current) => ({
          ...current,
          [key]: normalizeBrowseItems(payload.items, rootId),
        }));
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => {
        setLoadingKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
  }, [childrenMap, loadingKeys, normalizeBrowseItems]);

  const driveReadyKey = driveStatus?.phase === "ready" && driveStatus.lastCompletedAt
    ? `${driveStatus.lastCompletedAt}:${driveStatus.files || 0}`
    : "";

  useEffect(() => {
    if (!driveReadyKey || driveReadyKeyRef.current === driveReadyKey) return;
    const driveRoot = availableSpaces.find((space) => space.id === "drive")?.root;
    if (!driveRoot) return;
    driveReadyKeyRef.current = driveReadyKey;
    const rootKey = nodeKey(driveRoot.id, "");
    dataRoomCache.clear();
    const refreshTimer = window.setTimeout(() => {
      setChildrenMap((current) => Object.fromEntries(
        Object.entries(current).filter(([key]) => !key.startsWith(`${driveRoot.id}:`)),
      ));
      setExpandedKeys((current) => new Set(
        [...current].filter((key) => !key.startsWith(`${driveRoot.id}:`) || key === rootKey),
      ));
      loadTreeChildren(driveRoot.id, "", true);
      setDriveRefreshVersion((current) => current + 1);
    }, 0);
    return () => window.clearTimeout(refreshTimer);
  }, [availableSpaces, driveReadyKey, loadTreeChildren]);

  useEffect(() => {
    let ignore = false;
    fetchJson("browse", { root: rootIndex, path: folderPath })
      .then((payload) => {
        if (ignore) return;
        setBrowseData(payload);
        const key = nodeKey(rootIndex, folderPath);
        setChildrenMap((current) => ({
          ...current,
          [key]: normalizeBrowseItems(payload.items, rootIndex),
        }));
        setExpandedKeys((current) => new Set([...current, key]));
        setSelected((current) => current?.type === "file" && payload.items.some((item) => item.id === current.id) ? current : {
          type: folderPath ? "folder" : "root",
          rootId: rootIndex,
          relativePath: folderPath,
          name: payload.path.at(-1) || payload.root?.label || "Root",
        });
      })
      .catch((loadError) => {
        if (!ignore) setError(loadError.message);
      });
    return () => {
      ignore = true;
    };
  }, [driveRefreshVersion, rootIndex, folderPath, normalizeBrowseItems]);

  useEffect(() => {
    if (!isSearching) {
      return undefined;
    }
    let ignore = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      fetchJson("list", { category: "all", q: query })
        .then((payload) => {
          if (!ignore) setSearchData(payload);
        })
        .catch((loadError) => {
          if (!ignore) setError(loadError.message);
        })
        .finally(() => {
          if (!ignore) setLoading(false);
        });
    }, 260);
    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [isSearching, query]);

  useEffect(() => {
    if (!selected?.id || selected.type === "folder" || selected.type === "root") {
      return undefined;
    }
    let ignore = false;
    fetchJson("item", { id: selected.id })
      .then((payload) => {
        if (ignore) return;
        setDetail(payload);
        setDraft(payload.preview || "");
      })
      .catch((loadError) => {
        if (!ignore) setError(loadError.message);
      });
    return () => {
      ignore = true;
    };
  }, [selected]);

  const rootNodes = activeSpaceMeta?.root ? [{
    type: "root",
    rootId: activeSpaceMeta.root.id,
    relativePath: "",
    name: activeSpaceMeta.label,
  }] : [];

  const searchItems = isSearching
    ? searchData.files
      .map((file) => ({ ...file, type: "file" }))
      .filter((file) => activeRootIds.has(file.rootId))
    : [];

  const selectedKey = selected ? nodeKey(selected.rootId ?? rootIndex, selected.relativePath || "") : "";
  const activeDetail = selected?.id === detail?.id ? detail : null;
  const rawUrl = activeDetail?.id ? dataRoomUrl("download", { id: activeDetail.id, inline: "1" }) : "";
  const downloadUrl = activeDetail?.id ? dataRoomUrl("download", { id: activeDetail.id }) : "";
  const editable = activeDetail?.kind === "text" && !activeDetail.truncated;

  const selectFolder = (node) => {
    setRootIndex(node.rootId);
    setFolderPath(node.relativePath || "");
    setSelected(node);
    setDetail(null);
    setEditing(false);
  };

  const selectFile = (node) => {
    setSelected(node);
    setEditing(false);
  };

  const toggleNode = (node) => {
    const key = nodeKey(node.rootId, node.relativePath || "");
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        loadTreeChildren(node.rootId, node.relativePath || "");
      }
      return next;
    });
  };

  const handleTreeSelect = (node) => {
    if (node.type === "root" || node.type === "folder") {
      const nextSpace = availableSpaces.find((space) => space.root.id === node.rootId);
      if (nextSpace) setActiveSpace(nextSpace.id);
      selectFolder(node);
      return;
    }
    selectFile(node);
  };

  const resetFilters = () => {
    setQuery("");
  };

  const switchSpace = (space) => {
    setActiveSpace(space.id);
    setFolderPath("");
    setDetail(null);
    setEditing(false);
    if (!space.root) {
      setSelected(null);
      return;
    }
    const rootKey = nodeKey(space.root.id, "");
    setRootIndex(space.root.id);
    setExpandedKeys((current) => new Set([...current, rootKey]));
    loadTreeChildren(space.root.id, "", true);
    setSelected({
      type: "root",
      rootId: space.root.id,
      relativePath: "",
      name: space.label,
    });
  };

  const sendToChat = () => {
    if (!activeDetail) return;
    onStartChat?.({
      id: "data-room",
      label: activeDetail.name,
      profile: "default",
      prompt: [
        "[Data Room Reference]",
        `File: ${activeDetail.name}`,
        `Path: ${activeDetail.relativePath}`,
        `Category: ${CATEGORY_LABELS[activeDetail.category] ?? activeDetail.category}`,
        "",
        "이 자료를 기준으로 요약, 활용 가능한 업무, 다음 액션을 정리해주세요.",
      ].join("\n"),
    });
  };

  const startReviewMeeting = () => {
    if (!activeDetail) return;
    onStartMeeting?.({
      id: crypto.randomUUID(),
      source: "data-room",
      topic: `자료 검토: ${activeDetail.name}`,
      subtitle: activeDetail.relativePath,
      participants: ["default", "greeming-junseo", "greeming-seoyun"],
      requestedBy: "default",
      dataItem: {
        id: activeDetail.id,
        name: activeDetail.name,
        path: activeDetail.relativePath,
        category: activeDetail.category,
      },
      startedAt: Date.now(),
    });
  };

  const saveEdit = () => {
    if (!activeDetail || saving) return;
    setSaving(true);
    setError("");
    fetchJson("item", { id: activeDetail.id }, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: draft }),
    })
      .then((payload) => {
        setDetail(payload);
        setDraft(payload.preview || "");
        setEditing(false);
      })
      .catch((saveError) => setError(saveError.message))
      .finally(() => setSaving(false));
  };

  const toggleEdit = () => {
    if (!editable) return;
    if (editing) {
      saveEdit();
      return;
    }
    setDraft(activeDetail.preview || "");
    setEditing(true);
  };

  return (
    <section className="data-room-shell tree-mode compact-explorer">
      <header className="data-room-header compact">
        <div className="data-room-title">
          <span>DATA ROOM</span>
          <strong>{activeSpaceMeta?.label || "데이터룸"}</strong>
          <p>{activeSpaceMeta?.root
            ? activeSpaceMeta.id === "drive" && driveStatus?.enabled
              ? `${activeSpaceMeta.description} · ${driveStatus.message}`
              : activeSpaceMeta.description
            : `${activeSpaceMeta?.label || "선택한"} 저장소가 서버에 연결되지 않았습니다.`}</p>
        </div>
        <div className="data-room-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={activeSpaceMeta?.root ? "파일명, 폴더, 키워드 검색" : "저장소 연결 후 검색할 수 있습니다"}
            disabled={!activeSpaceMeta?.root}
          />
          <button type="button" onClick={resetFilters}>초기화</button>
        </div>
      </header>

      <nav className="data-space-tabs" aria-label="데이터 공간">
        {availableSpaces.map((space) => (
          <button
            type="button"
            key={space.id}
            className={`${activeSpace === space.id ? "active" : ""} ${space.root ? "" : "unavailable"}`.trim()}
            onClick={() => switchSpace(space)}
            aria-label={`${space.label} · ${space.root ? "저장소 연결됨" : "저장소 연결 안 됨"}`}
          >
            <small>{space.shortLabel}</small>
            <strong>{space.label}</strong>
            <span>{space.root ? space.description : "연결된 저장 공간이 없습니다."}</span>
          </button>
        ))}
      </nav>

      <div className="data-room-body tree-layout">
        <aside className="data-tree-panel">
          <div className="data-tree-title">
            <span>FOLDER TREE</span>
            <strong>폴더 구조</strong>
          </div>
          <div className="data-tree-scroll">
            {rootNodes.map((node) => (
              <TreeNode
                key={nodeKey(node.rootId, node.relativePath)}
                node={node}
                depth={0}
                selectedKey={selectedKey}
                expandedKeys={expandedKeys}
                loadingKeys={loadingKeys}
                childrenMap={childrenMap}
                onToggle={toggleNode}
                onSelect={handleTreeSelect}
              />
            ))}
          </div>
        </aside>

        <aside className="data-room-preview">
          {error && <p className="profile-chat-error">{error}</p>}
          {isSearching && !activeDetail ? (
            <div className="data-search-results">
              <header>
                <span>SEARCH RESULT</span>
                <h3>{loading ? "검색 중입니다." : `${searchItems.length}개 결과`}</h3>
                <p>{activeSpaceMeta?.label} 안에서 "{query}" 검색</p>
              </header>
              <div>
                {searchItems.map((item) => (
                  <button type="button" key={item.id} onClick={() => selectFile(item)}>
                    <span className={`row-icon ${itemIcon(item)}`} />
                    <strong>{item.name}</strong>
                    <small>{item.relativePath}</small>
                    <em>{formatBytes(item.size)}</em>
                  </button>
                ))}
                {!loading && !searchItems.length && (
                  <div className="data-room-empty">
                    <strong>검색 결과가 없습니다.</strong>
                    <p>다른 키워드로 검색하거나 초기화 후 폴더를 직접 열어보세요.</p>
                  </div>
                )}
              </div>
            </div>
          ) : !activeDetail ? (
            <div className="data-room-empty">
              <strong>{!activeSpaceMeta?.root
                ? `${activeSpaceMeta?.label || "선택한 저장소"}가 연결되지 않았습니다.`
                : activeSpaceEmpty
                  ? activeSpaceMeta.id === "drive" ? "실제 Google Drive 자료가 아직 동기화되지 않았습니다." : "저장소가 비어 있습니다."
                  : selected?.type === "folder" || selected?.type === "root" ? "폴더 구조를 탐색 중입니다." : "자료를 선택하세요."}</strong>
              <p>{!activeSpaceMeta?.root
                ? "서버의 저장소 연결 설정을 완료하면 이 탭에서 실제 자료를 탐색할 수 있습니다. 다른 데이터 공간은 계속 사용할 수 있습니다."
                : activeSpaceEmpty
                  ? activeSpaceMeta.id === "drive"
                    ? driveStatus?.enabled
                      ? driveStatus.message
                      : "현재는 안내 파일만 있습니다. Google Drive 동기화 또는 Drive bridge 연결이 완료되면 실제 파일이 이 트리에 표시됩니다."
                    : "새 자료가 추가되면 폴더 트리에 바로 표시됩니다."
                  : "왼쪽 폴더를 열고 닫으며 전체 구조를 확인하고, 파일을 선택하면 이곳에 미리보기와 액션이 표시됩니다."}</p>
            </div>
          ) : (
            <>
              <header className="data-preview-toolbar">
                <div>
                  <span>{CATEGORY_LABELS[activeDetail.category] ?? activeDetail.category}</span>
                  <h3>{activeDetail.name}</h3>
                  <p>{activeDetail.relativePath}</p>
                </div>
                <div className="data-room-meta compact">
                  <span>{activeDetail.kind}</span>
                  <span>{formatBytes(activeDetail.size)}</span>
                  <span>{formatDate(activeDetail.modified)}</span>
                </div>
                <div className="data-room-actions compact">
                  {editable && <button type="button" onClick={toggleEdit} disabled={saving}>{editing ? (saving ? "저장 중" : "완료") : "수정"}</button>}
                  <button type="button" onClick={sendToChat}>Hermes</button>
                  <button type="button" onClick={startReviewMeeting}>회의</button>
                  <a href={downloadUrl}>다운로드</a>
                </div>
              </header>
              <section className={`data-room-viewer ${editing ? "editing" : ""}`}>
                {editing && activeDetail.kind === "text" && (
                  <textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck="false" />
                )}
                {!editing && activeDetail.kind === "image" && <img src={rawUrl} alt={activeDetail.name} />}
                {!editing && activeDetail.kind === "pdf" && <iframe src={rawUrl} title={activeDetail.name} />}
                {!editing && isMarkdownFile(activeDetail) && (
                  <MarkdownPreview content={activeDetail.preview} truncated={activeDetail.truncated} />
                )}
                {!editing && activeDetail.kind === "text" && !isMarkdownFile(activeDetail) && (
                  <pre>{activeDetail.preview || "미리볼 수 있는 텍스트가 없습니다."}{activeDetail.truncated ? "\n\n...preview truncated" : ""}</pre>
                )}
                {!editing && !["image", "pdf", "text"].includes(activeDetail.kind) && (
                  <div className="data-room-empty">
                    <strong>미리보기 준비 중</strong>
                    <p>이 파일 형식은 현재 다운로드와 업무 연결을 지원합니다. Word, PPT, Excel 렌더링은 다음 단계에서 확장할 수 있습니다.</p>
                  </div>
                )}
              </section>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
