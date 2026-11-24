import { Check, FolderKanban, Inbox, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TickTickProject } from "../types";

interface ProjectPickerProps {
  projects: TickTickProject[];
  selectedProjectId: string | null;
  onChange: (projectId: string | null) => void;
  compact?: boolean;
  align?: "left" | "right";
  placeholder?: string;
}

export function ProjectPicker({
  projects,
  selectedProjectId,
  onChange,
  compact = false,
  align = "right",
  placeholder = "프로젝트",
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, query]);

  useEffect(() => {
    if (!open) return;
    searchInputRef.current?.focus();

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

  function selectProject(id: string | null) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={selected ? selected.name : placeholder}
        className={`inline-flex items-center gap-1.5 rounded-lg transition-colors ${
          compact ? "h-8 px-2.5 text-xs" : "h-8 px-2.5 text-xs"
        } ${
          selected
            ? "bg-white/[0.07] text-zinc-100 ring-1 ring-inset ring-white/[0.1] hover:bg-white/[0.11]"
            : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
        }`}
      >
        {selected ? (
          <>
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: selected.color ?? "#6366f1" }}
            />
            <span className="max-w-[110px] truncate font-medium">{selected.name}</span>
          </>
        ) : (
          <>
            <FolderKanban className="h-3.5 w-3.5 shrink-0" />
            {!compact && <span className="hidden sm:inline">{placeholder}</span>}
          </>
        )}
      </button>

      {open && (
        <div
          className={`absolute top-full z-40 mt-1.5 w-56 overflow-hidden rounded-xl border border-white/[0.1] bg-[#14141a]/98 shadow-2xl shadow-black/70 backdrop-blur-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-2.5 py-2">
            <Search className="h-3.5 w-3.5 text-zinc-500" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="검색..."
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
            <button
              type="button"
              onClick={() => selectProject(null)}
              className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                selectedProjectId === null
                  ? "bg-indigo-500/15 text-indigo-300"
                  : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
              }`}
            >
              <span>없음</span>
              {selectedProjectId === null && <Check className="h-3.5 w-3.5" />}
            </button>

            {filtered.length === 0 ? (
              <div className="px-2.5 py-4 text-center text-xs text-zinc-500">결과 없음</div>
            ) : (
              filtered.map((project) => {
                const active = project.id === selectedProjectId;
                return (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => selectProject(project.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                      active
                        ? "bg-indigo-500/15 text-indigo-200"
                        : "text-zinc-200 hover:bg-white/[0.05]"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {project.isInbox ? (
                        <Inbox className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      ) : (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: project.color ?? "#6366f1" }}
                        />
                      )}
                      <span className="truncate">{project.name}</span>
                    </span>
                    {active && <Check className="h-3.5 w-3.5 shrink-0 text-indigo-400" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
