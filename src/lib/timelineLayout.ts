import type { ActivityLog, TimeEntry } from "../types";
import { cleanProcessLabel } from "./time";

export interface ClampedActivity {
  log: ActivityLog;
  startMs: number;
  endMs: number;
}

export interface ClampedEntry {
  entry: TimeEntry;
  startMs: number;
  endMs: number;
}

export interface ParsedActivityMeta {
  workspace?: string;
  branch?: string;
  file?: string;
}

export interface AppWindowSummary {
  title: string;
  durationMs: number;
  source: string;
  workspace?: string;
  branch?: string;
  count: number;
}

export interface AppActivitySummary {
  processKey: string;
  processName: string;
  label: string;
  durationMs: number;
  /** Fraction of total active duration in this block (0..1). */
  share: number;
  logCount: number;
  windows: AppWindowSummary[];
}

export type TimelineBlockKind = "single" | "cluster" | "idle";

export interface TimelineBlock {
  id: string;
  kind: TimelineBlockKind;
  startMs: number;
  endMs: number;
  /** Sum of actual constituent activity durations (excludes inter-log gaps). */
  activeDurationMs: number;
  /** Guaranteed non-overlapping visual top offset (px) inside the 24h track. */
  topPx: number;
  /** Guaranteed non-overlapping visual height (px). */
  heightPx: number;
  /** Exact unadjusted proportional top offset (px). */
  rawTopPx: number;
  /** Exact unadjusted proportional height (px). */
  rawHeightPx: number;
  logs: ClampedActivity[];
  logIds: number[];
  /** Distinct apps sorted by duration descending (empty for idle blocks). */
  apps: AppActivitySummary[];
  dominantApp: AppActivitySummary | null;
  dominantWindowTitle: string | null;
  windowTitleCount: number;
}

export interface LayoutTimeEntry {
  entry: TimeEntry;
  startMs: number;
  endMs: number;
  topPx: number;
  heightPx: number;
  colIndex: number;
  totalCols: number;
}

export interface TimelineLayoutOptions {
  /** Max gap (ms) to bridge consecutive logs of the exact same app (handles poll intervals). */
  sameAppGapMs?: number;
  /** Min proportional height (px) for a span to stand alone instead of clustering. */
  minStandalonePx?: number;
  /** Max visual gap (px) allowed when clustering adjacent short spans. */
  clusterGapPx?: number;
  /** Max real time gap (ms) allowed when clustering adjacent short spans. */
  clusterGapMs?: number;
  /** Soft cap on a single multi-app cluster height (px) so long streaks split chronologically. */
  maxClusterPx?: number;
  /** Vertical gap (px) reserved between touching blocks. */
  blockGapPx?: number;
}

interface MergedSpan {
  isIdle: boolean;
  processKey: string;
  processName: string;
  startMs: number;
  endMs: number;
  logs: ClampedActivity[];
}

interface ClusterBucket {
  isIdle: boolean;
  isShortCluster: boolean;
  startMs: number;
  endMs: number;
  logs: ClampedActivity[];
}

const DEFAULT_SAME_APP_GAP_MS = 15_000;
const DEFAULT_MIN_STANDALONE_PX = 18;
const DEFAULT_EXPANDED_CARD_PX = 24;
const DEFAULT_CLUSTER_GAP_PX = 4;
const DEFAULT_CLUSTER_GAP_MS = 180_000; // 3 minutes
const DEFAULT_MAX_CLUSTER_PX = 60;
const DEFAULT_BLOCK_GAP_PX = 1.5;
const MIN_SLIVER_PX = 6;

export function normalizeProcessKey(processName: string): string {
  return processName.trim().toLowerCase();
}

export function parseActivityMetadata(metadataJson: string | null): ParsedActivityMeta | null {
  if (!metadataJson) return null;
  try {
    return JSON.parse(metadataJson) as ParsedActivityMeta;
  } catch {
    return null;
  }
}

/**
 * Stage 1: Merge consecutive raw activity logs belonging to the same app (or consecutive idle spans)
 * across normal polling intervals without bridging real breaks or sleep gaps.
 */
export function mergeConsecutiveSameApp(
  activities: ClampedActivity[],
  sameAppGapMs = DEFAULT_SAME_APP_GAP_MS,
): MergedSpan[] {
  if (activities.length === 0) return [];

  const sorted = [...activities].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const merged: MergedSpan[] = [];

  for (const item of sorted) {
    const key = item.log.isIdle ? "__idle__" : normalizeProcessKey(item.log.processName);
    const prev = merged[merged.length - 1];

    if (
      prev &&
      prev.isIdle === item.log.isIdle &&
      prev.processKey === key &&
      item.startMs - prev.endMs <= sameAppGapMs
    ) {
      prev.endMs = Math.max(prev.endMs, item.endMs);
      prev.logs.push(item);
    } else {
      merged.push({
        isIdle: item.log.isIdle,
        processKey: key,
        processName: item.log.processName,
        startMs: item.startMs,
        endMs: item.endMs,
        logs: [item],
      });
    }
  }

  return merged;
}

function summarizeApps(logs: ClampedActivity[]): {
  apps: AppActivitySummary[];
  activeDurationMs: number;
  dominantWindowTitle: string | null;
  windowTitleCount: number;
} {
  const byApp = new Map<
    string,
    {
      processKey: string;
      processName: string;
      durationMs: number;
      logCount: number;
      windows: Map<string, AppWindowSummary>;
    }
  >();

  let activeDurationMs = 0;
  const allTitles = new Set<string>();

  for (const item of logs) {
    const dur = Math.max(0, item.endMs - item.startMs);
    activeDurationMs += dur;
    if (item.log.isIdle) continue;

    const processKey = normalizeProcessKey(item.log.processName);
    let appEntry = byApp.get(processKey);
    if (!appEntry) {
      appEntry = {
        processKey,
        processName: item.log.processName,
        durationMs: 0,
        logCount: 0,
        windows: new Map(),
      };
      byApp.set(processKey, appEntry);
    }
    appEntry.durationMs += dur;
    appEntry.logCount += 1;

    const meta = parseActivityMetadata(item.log.metadataJson);
    const titleLabel =
      item.log.windowTitle?.trim() ||
      (meta?.workspace
        ? meta.branch
          ? `${meta.workspace} (${meta.branch})`
          : meta.workspace
        : "(창 제목 없음)");

    allTitles.add(`${processKey}::${titleLabel}`);

    const existingWin = appEntry.windows.get(titleLabel);
    if (existingWin) {
      existingWin.durationMs += dur;
      existingWin.count += 1;
      if (!existingWin.workspace && meta?.workspace) existingWin.workspace = meta.workspace;
      if (!existingWin.branch && meta?.branch) existingWin.branch = meta.branch;
    } else {
      appEntry.windows.set(titleLabel, {
        title: titleLabel,
        durationMs: dur,
        source: item.log.source,
        workspace: meta?.workspace,
        branch: meta?.branch,
        count: 1,
      });
    }
  }

  const totalAppMs = [...byApp.values()].reduce((acc, a) => acc + a.durationMs, 0);
  const apps: AppActivitySummary[] = [...byApp.values()]
    .sort((a, b) => b.durationMs - a.durationMs || a.processName.localeCompare(b.processName))
    .map((app) => ({
      processKey: app.processKey,
      processName: app.processName,
      label: cleanProcessLabel(app.processName),
      durationMs: app.durationMs,
      share: totalAppMs > 0 ? app.durationMs / totalAppMs : 0,
      logCount: app.logCount,
      windows: [...app.windows.values()].sort((a, b) => b.durationMs - a.durationMs),
    }));

  const dominantWindowTitle = apps[0]?.windows[0]?.title ?? null;

  return {
    apps,
    activeDurationMs,
    dominantWindowTitle,
    windowTitleCount: allTitles.size,
  };
}

/**
 * Builds zoom-adaptive, strictly non-overlapping visual timeline blocks from raw clamped activities:
 * 1. Consecutive logs of the same app (e.g. tab/file switches) merge into a single app span.
 * 2. Adjacent short active spans (< `minStandalonePx` at current zoom) cluster into multi-app pills
 *    (stacked app icons + proportional bar) while sustained focus spans remain standalone.
 * 3. Visual geometry guarantees `blocks[i].topPx + blocks[i].heightPx <= blocks[i + 1].topPx`
 *    at every zoom level without obscuring neighboring blocks.
 */
export function buildTimelineBlocks(
  activities: ClampedActivity[],
  dayStartMs: number,
  pxPerHour: number,
  options: TimelineLayoutOptions = {},
): TimelineBlock[] {
  if (activities.length === 0) return [];

  const sameAppGapMs = options.sameAppGapMs ?? DEFAULT_SAME_APP_GAP_MS;
  const minStandalonePx = options.minStandalonePx ?? DEFAULT_MIN_STANDALONE_PX;
  const clusterGapPx = options.clusterGapPx ?? DEFAULT_CLUSTER_GAP_PX;
  const clusterGapMs = options.clusterGapMs ?? DEFAULT_CLUSTER_GAP_MS;
  const maxClusterPx = options.maxClusterPx ?? DEFAULT_MAX_CLUSTER_PX;
  const blockGapPx = options.blockGapPx ?? DEFAULT_BLOCK_GAP_PX;

  const totalHeightPx = 24 * pxPerHour;
  const msToPx = (ms: number) => (ms / 3_600_000) * pxPerHour;
  const tsToY = (ts: number) => Math.max(0, Math.min(totalHeightPx, msToPx(ts - dayStartMs)));

  // Stage 1: Merge consecutive same-app / idle spans.
  const spans = mergeConsecutiveSameApp(activities, sameAppGapMs);

  // Stage 2: Zoom-adaptive clustering of adjacent short non-idle spans.
  const buckets: ClusterBucket[] = [];

  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    const spanRawPx = msToPx(span.endMs - span.startMs);
    const spanIsShort = !span.isIdle && spanRawPx < minStandalonePx;
    const prev = buckets[buckets.length - 1];

    if (prev && prev.isShortCluster && spanIsShort) {
      const gapMs = Math.max(0, span.startMs - prev.endMs);
      const gapPx = msToPx(gapMs);
      const prevHeightPx = msToPx(prev.endMs - prev.startMs);
      const projectedHeightPx = msToPx(Math.max(prev.endMs, span.endMs) - prev.startMs);

      // Avoid stranding a single tiny tail right after hitting maxClusterPx when the next span
      // will break the cluster anyway (e.g. a sustained focus block, idle, or long break).
      const nextSpan = spans[i + 1];
      const nextContinuesShort =
        Boolean(nextSpan) &&
        !nextSpan.isIdle &&
        msToPx(nextSpan.endMs - nextSpan.startMs) < minStandalonePx &&
        Math.max(0, nextSpan.startMs - span.endMs) <= clusterGapMs &&
        msToPx(Math.max(0, nextSpan.startMs - span.endMs)) <= clusterGapPx;

      const softCap = nextContinuesShort ? maxClusterPx : maxClusterPx + minStandalonePx;
      const withinGap = gapPx <= clusterGapPx && gapMs <= clusterGapMs;
      const withinCap = prevHeightPx < minStandalonePx || projectedHeightPx <= softCap;

      if (withinGap && withinCap) {
        prev.endMs = Math.max(prev.endMs, span.endMs);
        prev.logs.push(...span.logs);
        continue;
      }
    }

    buckets.push({
      isIdle: span.isIdle,
      isShortCluster: spanIsShort,
      startMs: span.startMs,
      endMs: span.endMs,
      logs: [...span.logs],
    });
  }

  // Build preliminary blocks with exact proportional raw geometry.
  const blocks: TimelineBlock[] = buckets.map((bucket) => {
    const rawTopPx = tsToY(bucket.startMs);
    const rawBottomPx = tsToY(bucket.endMs);
    const rawHeightPx = Math.max(0, rawBottomPx - rawTopPx);
    const { apps, activeDurationMs, dominantWindowTitle, windowTitleCount } = summarizeApps(
      bucket.logs,
    );
    const kind: TimelineBlockKind = bucket.isIdle
      ? "idle"
      : apps.length > 1
        ? "cluster"
        : "single";

    return {
      id: `${kind}-${bucket.logs[0].log.id}-${bucket.logs[bucket.logs.length - 1].log.id}`,
      kind,
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      activeDurationMs,
      topPx: rawTopPx,
      heightPx: rawHeightPx,
      rawTopPx,
      rawHeightPx,
      logs: bucket.logs,
      logIds: bucket.logs.map((item) => item.log.id),
      apps,
      dominantApp: apps[0] ?? null,
      dominantWindowTitle,
      windowTitleCount,
    };
  });

  // Stage 3: Assign clean, strictly non-overlapping visual geometry.
  // 3a. Expand short blocks ONLY into genuinely empty space below them (up to 24px for crisp icons),
  //     and trim touching edges by `blockGapPx` so neighboring cards stay distinct.
  for (let i = 0; i < blocks.length; i += 1) {
    const cur = blocks[i];
    const nextRawTop = i < blocks.length - 1 ? blocks[i + 1].rawTopPx : totalHeightPx;
    const availableBelow = Math.max(0, nextRawTop - cur.rawTopPx - blockGapPx);

    if (cur.rawHeightPx >= DEFAULT_EXPANDED_CARD_PX) {
      cur.heightPx =
        availableBelow > 0 ? Math.min(cur.rawHeightPx, availableBelow) : cur.rawHeightPx;
    } else {
      const targetHeight = Math.max(cur.rawHeightPx, DEFAULT_EXPANDED_CARD_PX);
      cur.heightPx = Math.min(targetHeight, availableBelow);
    }
  }

  // 3b. Rescue isolated micro-slivers (< MIN_SLIVER_PX) sandwiched tightly between tall focus blocks
  //     by borrowing at most a few pixels from tall neighbors (> 26px), keeping 1px separation intact.
  for (let i = 0; i < blocks.length; i += 1) {
    const cur = blocks[i];
    if (cur.heightPx >= MIN_SLIVER_PX) continue;

    let needed = MIN_SLIVER_PX - cur.heightPx;

    if (i > 0 && needed > 0) {
      const prev = blocks[i - 1];
      const freeAbove = Math.max(0, cur.topPx - (prev.topPx + prev.heightPx + blockGapPx));
      const useFree = Math.min(needed, freeAbove);
      if (useFree > 0) {
        cur.topPx -= useFree;
        cur.heightPx += useFree;
        needed -= useFree;
      }

      if (needed > 0) {
        const slackPrev = Math.max(0, prev.heightPx - 22);
        const borrowPrev = Math.min(needed, Math.min(4, slackPrev));
        if (borrowPrev > 0) {
          prev.heightPx -= borrowPrev;
          cur.topPx = Math.max(prev.topPx + prev.heightPx + 1, cur.topPx - borrowPrev);
          cur.heightPx += borrowPrev;
          needed -= borrowPrev;
        }
      }
    }

    if (i < blocks.length - 1 && needed > 0) {
      const next = blocks[i + 1];
      const slackNext = Math.max(0, next.heightPx - 22);
      const borrowNext = Math.min(needed, Math.min(4, slackNext));
      if (borrowNext > 0) {
        next.topPx += borrowNext;
        next.heightPx -= borrowNext;
        cur.heightPx += borrowNext;
      }
    }
  }

  // 3c. Final strict zero-overlap invariant guard:
  //     Guarantee `blocks[i].topPx + blocks[i].heightPx <= blocks[i + 1].topPx` for every pair.
  for (let i = 0; i < blocks.length; i += 1) {
    const cur = blocks[i];
    cur.topPx = Math.max(0, Math.min(totalHeightPx - 2, cur.topPx));
    cur.heightPx = Math.max(2, Math.min(cur.heightPx, totalHeightPx - cur.topPx));

    if (i < blocks.length - 1) {
      const next = blocks[i + 1];
      const maxWithGap = next.topPx - 1;
      if (cur.topPx + cur.heightPx > maxWithGap) {
        if (maxWithGap - cur.topPx >= 2) {
          cur.heightPx = maxWithGap - cur.topPx;
        } else if (next.topPx - cur.topPx >= 2) {
          cur.heightPx = next.topPx - cur.topPx;
        } else {
          // Extreme synthetic edge case (simultaneous timestamps): stack cleanly without overlap.
          const nextBottom = next.topPx + next.heightPx;
          next.topPx = Math.min(totalHeightPx - 2, cur.topPx + cur.heightPx);
          next.heightPx = Math.max(2, Math.min(next.heightPx, Math.max(2, nextBottom - next.topPx)));
        }
      }
    }
  }

  return blocks;
}

/**
 * Calendar-style side-by-side column partitioning for Confirmed Time Entries (Track 2)
 * so overlapping or tightly stacked short entries never collide visually.
 */
export function layoutTimeEntries(
  entries: ClampedEntry[],
  dayStartMs: number,
  pxPerHour: number,
  minHeightPx = 22,
): LayoutTimeEntry[] {
  if (entries.length === 0) return [];

  const totalHeightPx = 24 * pxPerHour;
  const tsToY = (ts: number) =>
    Math.max(0, Math.min(totalHeightPx, ((ts - dayStartMs) / 3_600_000) * pxPerHour));

  const items = [...entries]
    .sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs)
    .map((item) => {
      const topPx = tsToY(item.startMs);
      const rawBottom = tsToY(item.endMs);
      const heightPx = Math.max(minHeightPx, rawBottom - topPx);
      const clampedHeight = Math.min(heightPx, Math.max(minHeightPx, totalHeightPx - topPx));
      return {
        ...item,
        topPx,
        heightPx: clampedHeight,
        bottomPx: topPx + clampedHeight,
      };
    });

  const result: LayoutTimeEntry[] = [];
  let groupStart = 0;

  while (groupStart < items.length) {
    let groupEnd = groupStart + 1;
    let groupMaxBottom = items[groupStart].bottomPx;

    // Group connected overlapping visual intervals (with 1px tolerance so touching edges split cleanly).
    while (groupEnd < items.length && items[groupEnd].topPx < groupMaxBottom - 0.5) {
      groupMaxBottom = Math.max(groupMaxBottom, items[groupEnd].bottomPx);
      groupEnd += 1;
    }

    const colBottoms: number[] = [];
    const assignedCols: number[] = [];

    for (let i = groupStart; i < groupEnd; i += 1) {
      const cur = items[i];
      let chosen = colBottoms.findIndex((bottom) => bottom <= cur.topPx + 0.5);
      if (chosen === -1) {
        chosen = colBottoms.length;
        colBottoms.push(cur.bottomPx);
      } else {
        colBottoms[chosen] = cur.bottomPx;
      }
      assignedCols.push(chosen);
    }

    const totalCols = Math.max(1, colBottoms.length);
    for (let i = groupStart; i < groupEnd; i += 1) {
      const cur = items[i];
      result.push({
        entry: cur.entry,
        startMs: cur.startMs,
        endMs: cur.endMs,
        topPx: cur.topPx,
        heightPx: cur.heightPx,
        colIndex: assignedCols[i - groupStart],
        totalCols,
      });
    }

    groupStart = groupEnd;
  }

  return result;
}
