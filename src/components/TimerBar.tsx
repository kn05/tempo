import {
  CheckSquare,
  Clock,
  FolderKanban,
  PictureInPicture2,
  Play,
  Plus,
  Square,
  Tag as TagIcon,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  getActiveTokenAtCursor,
  matchProjectByHint,
  matchTagByName,
  parseQuickEntry,
  stripTokenRange,
} from "../lib/quickEntry";
import { formatDurationHms } from "../lib/time";
import type {
  StartTimerInput,
  Tag,
  TickTickProject,
  TickTickTask,
  TimeEntry,
  UpdateTimeEntryInput,
} from "../types";
import { ProjectPicker } from "./ProjectPicker";
import { TagPicker } from "./TagPicker";

interface TimerBarProps {
  runningEntry: TimeEntry | null;
  projects: TickTickProject[];
  tasks: TickTickTask[];
  tags: Tag[];
  recentEntries: TimeEntry[];
  inputRef: RefObject<HTMLInputElement | null>;
  onStart: (input: StartTimerInput) => Promise<void>;
  onStop: () => Promise<void>;
  onUpdateRunning: (id: string, input: UpdateTimeEntryInput) => Promise<void>;
  onCreateTag: (name: string, color?: string | null) => Promise<Tag>;
  onDeleteTag: (id: string) => Promise<void>;
  onToggleMiniTimer: () => Promise<void>;
}

type SuggestionItem =
  | { kind: "project"; project: TickTickProject }
  | { kind: "tag"; tag: Tag }
  | { kind: "create-tag"; name: string }
  | { kind: "task"; task: TickTickTask; project: TickTickProject | null }
  | { kind: "recent"; entry: TimeEntry; project: TickTickProject | null };

export function TimerBar({
  runningEntry,
  projects,
  tasks,
  tags,
  recentEntries,
  inputRef,
  onStart,
  onStop,
  onUpdateRunning,
  onCreateTag,
  onDeleteTag,
  onToggleMiniTimer,
}: TimerBarProps) {
  const [description, setDescription] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [cursorPos, setCursorPos] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastRunningIdRef = useRef<string | null>(null);

  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const tagMap = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  // Sync local draft state when running timer starts/changes/stops externally.
  useEffect(() => {
    if (runningEntry) {
      const switched = lastRunningIdRef.current !== runningEntry.id;
      lastRunningIdRef.current = runningEntry.id;
      if (switched || document.activeElement !== inputRef.current) {
        setDescription(runningEntry.description);
      }
      setSelectedProjectId(runningEntry.ticktickProjectId);
      setSelectedTaskId(runningEntry.ticktickParentTaskId);
      setSelectedTagIds(runningEntry.tagIds);
    } else if (lastRunningIdRef.current !== null) {
      lastRunningIdRef.current = null;
      setDescription("");
      setSelectedProjectId(null);
      setSelectedTaskId(null);
      setSelectedTagIds([]);
    }
  }, [runningEntry, inputRef]);

  useEffect(() => {
    if (!runningEntry) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [runningEntry]);

  // Dismiss autocomplete when clicking outside.
  useEffect(() => {
    if (!dropdownOpen) return;
    function handleOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [dropdownOpen]);

  const activeToken = useMemo(
    () => getActiveTokenAtCursor(description, cursorPos),
    [description, cursorPos],
  );

  const parsedInline = useMemo(() => parseQuickEntry(description), [description]);
  const inlineMatchedProject = useMemo(
    () => matchProjectByHint(parsedInline.projectHint, projects),
    [parsedInline.projectHint, projects],
  );

  const suggestions = useMemo<SuggestionItem[]>(() => {
    if (activeToken?.trigger === "@") {
      const q = activeToken.query.toLowerCase();
      return projects
        .filter((p) => !q || p.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((project) => ({ kind: "project", project }));
    }

    if (activeToken?.trigger === "#") {
      const q = activeToken.query.toLowerCase();
      const matched = tags
        .filter((t) => !q || t.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map<SuggestionItem>((tag) => ({ kind: "tag", tag }));
      if (
        activeToken.query.trim().length > 0 &&
        !tags.some((t) => t.name.toLowerCase() === q)
      ) {
        matched.unshift({ kind: "create-tag", name: activeToken.query.trim() });
      }
      return matched;
    }

    // Standard task + recent entry autocomplete.
    const q = parsedInline.description.trim().toLowerCase();
    const openTasks = tasks.filter((t) => t.status === 0);
    const matchedTasks = openTasks
      .filter((t) => {
        if (!q) return true;
        const projName = projectMap.get(t.projectId)?.name ?? "";
        return (
          t.title.toLowerCase().includes(q) ||
          (t.content ?? "").toLowerCase().includes(q) ||
          projName.toLowerCase().includes(q)
        );
      })
      .slice(0, 6)
      .map<SuggestionItem>((task) => ({
        kind: "task",
        task,
        project: projectMap.get(task.projectId) ?? null,
      }));

    const seenDesc = new Set<string>();
    const matchedRecent: SuggestionItem[] = [];
    for (const entry of recentEntries) {
      if (entry.endedAt === null) continue;
      const desc = entry.description.trim();
      if (!desc) continue;
      const key = `${desc.toLowerCase()}::${entry.ticktickProjectId ?? ""}`;
      if (seenDesc.has(key)) continue;
      if (q && !desc.toLowerCase().includes(q)) continue;
      seenDesc.add(key);
      matchedRecent.push({
        kind: "recent",
        entry,
        project: entry.ticktickProjectId ? (projectMap.get(entry.ticktickProjectId) ?? null) : null,
      });
      if (matchedRecent.length >= 4) break;
    }

    return [...matchedTasks, ...matchedRecent];
  }, [activeToken, parsedInline.description, projects, tasks, tags, recentEntries, projectMap]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [suggestions.length, activeToken?.trigger, activeToken?.query]);

  const linkedTask = selectedTaskId ? (taskMap.get(selectedTaskId) ?? null) : null;
  const elapsedMs = runningEntry ? nowMs - runningEntry.startedAt : 0;

  async function resolveAndCreateTags(tagNames: string[], baseIds: string[]): Promise<string[]> {
    const nextIds = new Set(baseIds);
    for (const name of tagNames) {
      const existing = matchTagByName(name, tags);
      if (existing) {
        nextIds.add(existing.id);
      } else {
        const created = await onCreateTag(name, null);
        nextIds.add(created.id);
      }
    }
    return [...nextIds];
  }

  async function commitRunningEdits(overrides?: {
    description?: string;
    projectId?: string | null;
    taskId?: string | null;
    tagIds?: string[];
  }) {
    if (!runningEntry) return;
    const rawDesc = overrides?.description ?? description;
    const parsed = parseQuickEntry(rawDesc);

    const nextDesc =
      parsed.projectHint || parsed.tagNames.length > 0
        ? parsed.description || runningEntry.description
        : rawDesc.trim();

    let nextProjectId =
      overrides?.projectId !== undefined ? overrides.projectId : selectedProjectId;
    if (parsed.projectHint) {
      const matched = matchProjectByHint(parsed.projectHint, projects);
      if (matched) nextProjectId = matched.id;
    }

    const nextTaskId = overrides?.taskId !== undefined ? overrides.taskId : selectedTaskId;
    let nextTagIds = overrides?.tagIds ?? selectedTagIds;
    if (parsed.tagNames.length > 0) {
      nextTagIds = await resolveAndCreateTags(parsed.tagNames, nextTagIds);
    }

    const patch: UpdateTimeEntryInput = {};
    let changed = false;

    if (nextDesc !== runningEntry.description) {
      patch.description = nextDesc;
      changed = true;
    }
    if (nextProjectId !== runningEntry.ticktickProjectId) {
      patch.ticktickProjectId = nextProjectId;
      changed = true;
    }
    if (nextTaskId !== runningEntry.ticktickParentTaskId) {
      patch.ticktickParentTaskId = nextTaskId;
      changed = true;
    }
    const prevTagKey = [...runningEntry.tagIds].sort().join(",");
    const nextTagKey = [...nextTagIds].sort().join(",");
    if (prevTagKey !== nextTagKey) {
      patch.tagIds = nextTagIds;
      changed = true;
    }

    if (parsed.projectHint || parsed.tagNames.length > 0) {
      setDescription(nextDesc);
      setSelectedProjectId(nextProjectId);
      setSelectedTagIds(nextTagIds);
    }

    if (changed) {
      await onUpdateRunning(runningEntry.id, patch);
    }
  }

  async function handleSelectSuggestion(item: SuggestionItem) {
    if (item.kind === "project" && activeToken) {
      const cleaned = stripTokenRange(description, activeToken.start, activeToken.end);
      setDescription(cleaned);
      setSelectedProjectId(item.project.id);
      setDropdownOpen(false);
      if (runningEntry) {
        await commitRunningEdits({ description: cleaned, projectId: item.project.id });
      }
      inputRef.current?.focus();
      return;
    }

    if (item.kind === "tag" && activeToken) {
      const cleaned = stripTokenRange(description, activeToken.start, activeToken.end);
      const nextTags = selectedTagIds.includes(item.tag.id)
        ? selectedTagIds
        : [...selectedTagIds, item.tag.id];
      setDescription(cleaned);
      setSelectedTagIds(nextTags);
      setDropdownOpen(false);
      if (runningEntry) {
        await commitRunningEdits({ description: cleaned, tagIds: nextTags });
      }
      inputRef.current?.focus();
      return;
    }

    if (item.kind === "create-tag" && activeToken) {
      const cleaned = stripTokenRange(description, activeToken.start, activeToken.end);
      const created = await onCreateTag(item.name, null);
      const nextTags = selectedTagIds.includes(created.id)
        ? selectedTagIds
        : [...selectedTagIds, created.id];
      setDescription(cleaned);
      setSelectedTagIds(nextTags);
      setDropdownOpen(false);
      if (runningEntry) {
        await commitRunningEdits({ description: cleaned, tagIds: nextTags });
      }
      inputRef.current?.focus();
      return;
    }

    if (item.kind === "task") {
      const mappedTagIds = new Set<string>(selectedTagIds);
      for (const taskTag of item.task.tags) {
        const matched = matchTagByName(taskTag, tags);
        if (matched) mappedTagIds.add(matched.id);
      }
      const nextTagArr = [...mappedTagIds];
      setDescription(item.task.title);
      setSelectedProjectId(item.task.projectId);
      setSelectedTaskId(item.task.id);
      setSelectedTagIds(nextTagArr);
      setDropdownOpen(false);
      if (runningEntry) {
        await commitRunningEdits({
          description: item.task.title,
          projectId: item.task.projectId,
          taskId: item.task.id,
          tagIds: nextTagArr,
        });
      }
      inputRef.current?.focus();
      return;
    }

    if (item.kind === "recent") {
      setDescription(item.entry.description);
      setSelectedProjectId(item.entry.ticktickProjectId);
      setSelectedTaskId(item.entry.ticktickParentTaskId);
      setSelectedTagIds(item.entry.tagIds);
      setDropdownOpen(false);
      if (runningEntry) {
        await commitRunningEdits({
          description: item.entry.description,
          projectId: item.entry.ticktickProjectId,
          taskId: item.entry.ticktickParentTaskId,
          tagIds: item.entry.tagIds,
        });
      }
      inputRef.current?.focus();
    }
  }

  async function handleStartFromDraft() {
    const parsed = parseQuickEntry(description);
    const matchedProj = matchProjectByHint(parsed.projectHint, projects);
    const finalProjectId = matchedProj?.id ?? selectedProjectId;
    const finalTagIds = await resolveAndCreateTags(parsed.tagNames, selectedTagIds);
    const finalDescription = parsed.description.trim() || linkedTask?.title || "(Untitled)";

    await onStart({
      description: finalDescription,
      ticktickProjectId: finalProjectId,
      ticktickParentTaskId: selectedTaskId,
      tagIds: finalTagIds,
    });
    setDropdownOpen(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (runningEntry) {
        // Pressing Enter inside the description input while running saves live edits
        // instead of unexpectedly stopping the timer; clicking Stop stops the timer.
        if (document.activeElement === inputRef.current) {
          await commitRunningEdits();
          setDropdownOpen(false);
        } else {
          await commitRunningEdits();
          await onStop();
        }
      } else {
        await handleStartFromDraft();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handlePrimaryButtonClick() {
    if (busy) return;
    setBusy(true);
    try {
      if (runningEntry) {
        await commitRunningEdits();
        await onStop();
      } else {
        await handleStartFromDraft();
      }
    } finally {
      setBusy(false);
    }
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (dropdownOpen && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && activeToken)) {
        event.preventDefault();
        void handleSelectSuggestion(suggestions[highlightIdx]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDropdownOpen(false);
        return;
      }
    } else if (event.key === "Escape") {
      setDropdownOpen(false);
    }
  }

  async function handleProjectChange(projectId: string | null) {
    setSelectedProjectId(projectId);
    // Clear linked task if it belongs to a different project.
    const nextTaskId =
      selectedTaskId && projectId && taskMap.get(selectedTaskId)?.projectId !== projectId
        ? null
        : selectedTaskId;
    if (nextTaskId !== selectedTaskId) {
      setSelectedTaskId(nextTaskId);
    }
    if (runningEntry) {
      await commitRunningEdits({ projectId, taskId: nextTaskId });
    }
  }

  async function handleTagsChange(nextTagIds: string[]) {
    setSelectedTagIds(nextTagIds);
    if (runningEntry) {
      await commitRunningEdits({ tagIds: nextTagIds });
    }
  }

  async function handleClearLinkedTask() {
    setSelectedTaskId(null);
    if (runningEntry) {
      await commitRunningEdits({ taskId: null });
    }
  }

  const showMetadataStrip =
    Boolean(linkedTask) ||
    selectedTagIds.length > 0 ||
    Boolean(parsedInline.projectHint) ||
    parsedInline.tagNames.length > 0;

  return (
    <header className="shrink-0 border-b border-zinc-800/80 bg-zinc-900/75 px-5 py-2.5 backdrop-blur">
      <form onSubmit={handleSubmit} className="flex items-center gap-2.5">
        <div ref={wrapperRef} className="relative min-w-0 flex-1">
          <div className="relative flex items-center">
            {runningEntry && (
              <span
                className="pointer-events-none absolute left-3 h-2 w-2 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)]"
                title="타이머 실행 중 (입력하면 즉시 수정됩니다)"
              />
            )}
            <input
              ref={inputRef}
              type="text"
              value={description}
              onFocus={(e) => {
                setCursorPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
                setDropdownOpen(true);
              }}
              onBlur={() => {
                if (runningEntry) {
                  void commitRunningEdits();
                }
              }}
              onClick={(e) => {
                setCursorPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
                setDropdownOpen(true);
              }}
              onKeyUp={(e) => {
                setCursorPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
              }}
              onKeyDown={handleInputKeyDown}
              onChange={(e) => {
                setDescription(e.target.value);
                setCursorPos(e.target.selectionStart ?? e.target.value.length);
                setDropdownOpen(true);
              }}
              placeholder={
                runningEntry
                  ? "실행 중 작업 설명 수정... (@프로젝트 #태그)"
                  : "무엇을 작업 중인가요? (TickTick 태스크 검색 또는 @프로젝트 #태그)"
              }
              className={`h-10 w-full rounded-lg border bg-zinc-950/90 pr-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none ${
                runningEntry ? "border-rose-500/40 pl-7" : "border-zinc-800 pl-3.5"
              }`}
            />
          </div>

          {dropdownOpen && suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-40 mt-1.5 max-h-80 overflow-y-auto rounded-xl border border-zinc-700/90 bg-zinc-900 p-1.5 shadow-2xl">
              {activeToken?.trigger === "@" && (
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  프로젝트 선택 (@)
                </div>
              )}
              {activeToken?.trigger === "#" && (
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  태그 선택 (#)
                </div>
              )}

              {suggestions.map((item, idx) => {
                const active = idx === highlightIdx;
                const prevItem = idx > 0 ? suggestions[idx - 1] : null;
                const showTaskHeader = item.kind === "task" && prevItem?.kind !== "task";
                const showRecentHeader = item.kind === "recent" && prevItem?.kind !== "recent";

                return (
                  <div key={`${item.kind}-${idx}`}>
                    {showTaskHeader && (
                      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        <CheckSquare className="h-3 w-3 text-indigo-400" />
                        TickTick 태스크
                      </div>
                    )}
                    {showRecentHeader && (
                      <div className="mt-1 flex items-center gap-1.5 border-t border-zinc-800 px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                        <Clock className="h-3 w-3 text-zinc-400" />
                        최근 시간 기록
                      </div>
                    )}

                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        void handleSelectSuggestion(item);
                      }}
                      onMouseEnter={() => setHighlightIdx(idx)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                        active ? "bg-indigo-500/20 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800"
                      }`}
                    >
                      {item.kind === "project" && (
                        <>
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: item.project.color ?? "#6366f1" }}
                            />
                            <span className="truncate font-medium">{item.project.name}</span>
                          </span>
                          <span className="text-[10px] text-zinc-500">@{item.project.name}</span>
                        </>
                      )}

                      {item.kind === "tag" && (
                        <>
                          <span className="flex min-w-0 items-center gap-2">
                            <TagIcon className="h-3 w-3 shrink-0 text-indigo-400" />
                            <span className="truncate">#{item.tag.name}</span>
                          </span>
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                            {item.tag.source === "ticktick" ? "TickTick" : "Local"}
                          </span>
                        </>
                      )}

                      {item.kind === "create-tag" && (
                        <span className="flex items-center gap-2 font-medium text-indigo-300">
                          <Plus className="h-3.5 w-3.5" />새 로컬 태그 &ldquo;#{item.name}&rdquo; 생성
                        </span>
                      )}

                      {item.kind === "task" && (
                        <>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-zinc-100">
                              {item.task.title}
                            </span>
                            {item.task.content && (
                              <span className="block truncate text-[11px] text-zinc-500">
                                {item.task.content}
                              </span>
                            )}
                          </span>
                          {item.project && (
                            <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-700/80 bg-zinc-950/70 px-2 py-0.5 text-[11px] text-zinc-300">
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: item.project.color ?? "#6366f1" }}
                              />
                              {item.project.name}
                            </span>
                          )}
                        </>
                      )}

                      {item.kind === "recent" && (
                        <>
                          <span className="truncate text-zinc-200">{item.entry.description}</span>
                          {item.project && (
                            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400">
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: item.project.color ?? "#6366f1" }}
                              />
                              {item.project.name}
                            </span>
                          )}
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <ProjectPicker
          projects={projects}
          selectedProjectId={selectedProjectId}
          onChange={(id) => void handleProjectChange(id)}
        />

        <TagPicker
          tags={tags}
          selectedTagIds={selectedTagIds}
          onChange={(ids) => void handleTagsChange(ids)}
          onCreateTag={onCreateTag}
          onDeleteTag={onDeleteTag}
        />

        <div
          className={`w-24 text-right font-mono text-base font-semibold tabular-nums ${
            runningEntry ? "text-rose-300" : "text-zinc-200"
          }`}
        >
          {formatDurationHms(elapsedMs)}
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void handlePrimaryButtonClick()}
          aria-label={runningEntry ? "Stop timer" : "Start timer"}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white shadow-sm transition disabled:opacity-50 ${
            runningEntry
              ? "bg-rose-500 hover:bg-rose-400"
              : "bg-indigo-500 hover:bg-indigo-400"
          }`}
        >
          {runningEntry ? (
            <Square className="h-4 w-4 fill-current" />
          ) : (
            <Play className="ml-0.5 h-4 w-4 fill-current" />
          )}
        </button>

        <button
          type="button"
          onClick={() => void onToggleMiniTimer()}
          title="미니 타이머 열기/닫기 (Always on top)"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 transition hover:border-zinc-700 hover:bg-zinc-800/80 hover:text-zinc-200"
        >
          <PictureInPicture2 className="h-4 w-4" />
        </button>
      </form>

      {showMetadataStrip && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          {linkedTask && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-0.5 text-indigo-200">
              <CheckSquare className="h-3 w-3 text-indigo-400" />
              <span className="max-w-[240px] truncate">태스크: {linkedTask.title}</span>
              <button
                type="button"
                onClick={() => void handleClearLinkedTask()}
                className="text-indigo-300 hover:text-white"
                title="태스크 연결 해제"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}

          {selectedTagIds.map((tagId) => {
            const tag = tagMap.get(tagId);
            if (!tag) return null;
            return (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 rounded-full border border-zinc-700/80 bg-zinc-800/80 px-2 py-0.5 text-zinc-200"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: tag.color ?? "#6366f1" }}
                />
                #{tag.name}
                <button
                  type="button"
                  onClick={() => void handleTagsChange(selectedTagIds.filter((id) => id !== tag.id))}
                  className="text-zinc-400 hover:text-zinc-100"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            );
          })}

          {parsedInline.projectHint && (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
              <FolderKanban className="h-3 w-3" />
              {inlineMatchedProject
                ? `@${inlineMatchedProject.name} 자동 지정`
                : `@${parsedInline.projectHint} (일치 프로젝트 없음)`}
            </span>
          )}

          {parsedInline.tagNames.map((name) => (
            <span
              key={`inline-${name}`}
              className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-sky-300"
            >
              #{name}
              {!matchTagByName(name, tags) && <span className="text-[9px] opacity-80">신규</span>}
            </span>
          ))}
        </div>
      )}
    </header>
  );
}
