import { Check, Plus, Search, Tag as TagIcon, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Tag } from "../types";

const TAG_COLOR_SWATCHES = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#f43f5e",
  "#8b5cf6",
  "#ec4899",
];

function pickColorForTagName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return TAG_COLOR_SWATCHES[Math.abs(hash) % TAG_COLOR_SWATCHES.length];
}

interface TagPickerProps {
  tags: Tag[];
  selectedTagIds: string[];
  onChange: (nextTagIds: string[]) => void;
  onCreateTag: (name: string, color?: string | null) => Promise<Tag>;
  onDeleteTag?: (id: string) => Promise<void>;
  compact?: boolean;
  align?: "left" | "right";
}

export function TagPicker({
  tags,
  selectedTagIds,
  onChange,
  onCreateTag,
  onDeleteTag,
  compact = false,
  align = "right",
}: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedSet = useMemo(() => new Set(selectedTagIds), [selectedTagIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  }, [tags, query]);

  const trimmedQuery = query.trim();
  const canCreateNew =
    trimmedQuery.length > 0 &&
    !tags.some((t) => t.name.toLowerCase() === trimmedQuery.toLowerCase());

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function toggleTag(id: string) {
    if (selectedSet.has(id)) {
      onChange(selectedTagIds.filter((tid) => tid !== id));
    } else {
      onChange([...selectedTagIds, id]);
    }
  }

  async function handleCreate() {
    if (!canCreateNew || creating) return;
    setCreating(true);
    try {
      const created = await onCreateTag(trimmedQuery, pickColorForTagName(trimmedQuery));
      if (!selectedSet.has(created.id)) {
        onChange([...selectedTagIds, created.id]);
      }
      setQuery("");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={selectedTagIds.length > 0 ? `태그 ${selectedTagIds.length}개 선택됨` : "태그 선택"}
        className={`inline-flex items-center gap-1.5 rounded-lg border transition ${
          compact ? "h-8 px-2.5 text-xs" : "h-9 px-2.5 text-xs"
        } ${
          selectedTagIds.length > 0
            ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-200 hover:border-indigo-400"
            : "border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
        }`}
      >
        <TagIcon className="h-3.5 w-3.5 shrink-0" />
        {selectedTagIds.length > 0 && (
          <span className="font-mono text-[11px] font-semibold">{selectedTagIds.length}</span>
        )}
      </button>

      {open && (
        <div
          className={`absolute top-full z-40 mt-1.5 w-64 overflow-hidden rounded-xl border border-zinc-700/90 bg-zinc-900 shadow-2xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="flex items-center gap-2 border-b border-zinc-800 px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-zinc-500" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreateNew) {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder="태그 검색 또는 새 태그 입력..."
              className="w-full bg-transparent text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <div className="max-h-60 overflow-y-auto p-1">
            {canCreateNew && (
              <button
                type="button"
                disabled={creating}
                onClick={() => void handleCreate()}
                className="mb-1 flex w-full items-center gap-2 rounded-lg bg-indigo-500/15 px-2.5 py-1.5 text-left text-xs font-medium text-indigo-300 transition hover:bg-indigo-500/25 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">새 로컬 태그 &ldquo;#{trimmedQuery}&rdquo; 생성</span>
              </button>
            )}

            {filtered.length === 0 && !canCreateNew ? (
              <div className="px-2.5 py-4 text-center text-xs text-zinc-500">
                태그가 없습니다. 이름을 입력해 추가하세요.
              </div>
            ) : (
              filtered.map((tag) => {
                const checked = selectedSet.has(tag.id);
                return (
                  <div
                    key={tag.id}
                    className={`group flex items-center justify-between rounded-lg px-2 py-1.5 text-xs transition ${
                      checked
                        ? "bg-indigo-500/15 text-indigo-200"
                        : "text-zinc-200 hover:bg-zinc-800"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked
                            ? "border-indigo-400 bg-indigo-500 text-white"
                            : "border-zinc-600 bg-zinc-950"
                        }`}
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color ?? "#6366f1" }}
                      />
                      <span className="truncate">#{tag.name}</span>
                      <span className="rounded bg-zinc-800 px-1 py-0.5 text-[9px] uppercase text-zinc-400">
                        {tag.source === "ticktick" ? "TT" : "local"}
                      </span>
                    </button>

                    {onDeleteTag && tag.source !== "ticktick" && (
                      <button
                        type="button"
                        title="로컬 태그 삭제"
                        onClick={() => {
                          if (checked) {
                            onChange(selectedTagIds.filter((tid) => tid !== tag.id));
                          }
                          void onDeleteTag(tag.id);
                        }}
                        className="ml-1 rounded p-1 text-zinc-500 opacity-0 transition hover:bg-rose-500/15 hover:text-rose-400 group-hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {selectedTagIds.length > 0 && (
            <div className="border-t border-zinc-800 px-2.5 py-1.5 text-right">
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-[11px] text-zinc-400 hover:text-zinc-200"
              >
                선택 모두 해제
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
