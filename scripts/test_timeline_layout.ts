import assert from "node:assert/strict";
import {
  buildTimelineBlocks,
  layoutTimeEntries,
  mergeConsecutiveSameApp,
  type ClampedActivity,
  type ClampedEntry,
} from "../src/lib/timelineLayout.ts";

const DAY_START = new Date(2026, 10, 24, 0, 0, 0, 0).getTime();
const at = (h: number, m: number, s = 0) => DAY_START + ((h * 60 + m) * 60 + s) * 1000;

let nextId = 1;
function makeAct(
  processName: string,
  startMs: number,
  endMs: number,
  windowTitle: string | null = null,
  isIdle = false,
): ClampedActivity {
  const id = nextId++;
  return {
    log: {
      id,
      source: "win_api",
      processName,
      windowTitle,
      metadataJson: null,
      isIdle,
      startedAt: startMs,
      endedAt: endMs,
    },
    startMs,
    endMs,
  };
}

function assertZeroOverlap(blocks: ReturnType<typeof buildTimelineBlocks>, label: string) {
  for (let i = 0; i < blocks.length; i += 1) {
    assert.ok(blocks[i].heightPx >= 2, `${label}: block ${i} heightPx >= 2 (got ${blocks[i].heightPx})`);
    if (i < blocks.length - 1) {
      const bottom = blocks[i].topPx + blocks[i].heightPx;
      assert.ok(
        bottom <= blocks[i + 1].topPx + 0.001,
        `${label}: overlap between block ${i} (bottom=${bottom}) and block ${i + 1} (top=${blocks[i + 1].topPx})`,
      );
    }
  }
}

// 1. Consecutive same-app tab/file switches merge across 2s poll gaps, but NOT across 5m breaks
{
  const acts = [
    makeAct("Code.exe", at(9, 0, 0), at(9, 10, 0), "App.tsx"),
    makeAct("code.exe", at(9, 10, 2), at(9, 25, 0), "TimelineView.tsx"),
    makeAct("Code.exe", at(9, 25, 2), at(9, 32, 0), "timelineLayout.ts"),
    // 5-minute genuine gap -> separate block
    makeAct("Code.exe", at(9, 37, 0), at(10, 0, 0), "lib.rs"),
  ];

  const merged = mergeConsecutiveSameApp(acts);
  assert.equal(merged.length, 2, "same-app logs across 2s poll gaps merge, 5m gap splits");
  assert.equal(merged[0].logs.length, 3);
  assert.equal(merged[1].logs.length, 1);

  const blocks = buildTimelineBlocks(acts, DAY_START, 120);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, "single");
  assert.equal(blocks[0].windowTitleCount, 3);
  assert.equal(blocks[0].dominantWindowTitle, "TimelineView.tsx");
  assertZeroOverlap(blocks, "same-app-merge");
}

// 2. Rapid multi-window switching clusters at 1x/2x and unpacks cleanly at 8x with ZERO overlap
{
  const apps = ["Code.exe", "chrome.exe", "WindowsTerminal.exe", "Slack.exe", "explorer.exe", "Notion.exe"];
  const acts: ClampedActivity[] = [];
  let cursor = at(11, 0, 0);
  for (let i = 0; i < 24; i += 1) {
    const durMs = (i % 4 === 0 ? 180 : i % 3 === 0 ? 90 : 35) * 1000;
    const app = apps[i % apps.length];
    acts.push(makeAct(app, cursor, cursor + durMs, `${app} window #${i}`));
    cursor += durMs + 2_000;
  }

  for (const pxPerHour of [60, 120, 240, 480]) {
    const blocks = buildTimelineBlocks(acts, DAY_START, pxPerHour);
    assertZeroOverlap(blocks, `rapid-switch-${pxPerHour}`);
    // Every raw log must be accounted for in exactly one block
    const allIds = blocks.flatMap((b) => b.logIds);
    assert.equal(allIds.length, acts.length, `all raw logs preserved at ${pxPerHour}px/h`);
  }

  const blocks2x = buildTimelineBlocks(acts, DAY_START, 120);
  const blocks8x = buildTimelineBlocks(acts, DAY_START, 480);
  assert.ok(
    blocks2x.some((b) => b.kind === "cluster" && b.apps.length >= 4),
    "2x zoom groups rapid multi-app switches into multi-icon cluster(s)",
  );
  assert.ok(
    blocks8x.length > blocks2x.length,
    `zooming in to 8x (${blocks8x.length}) expands clusters compared to 2x (${blocks2x.length})`,
  );
}

// 3. Idle blocks never merge with active blocks
{
  const acts = [
    makeAct("chrome.exe", at(13, 0, 0), at(13, 3, 0), "Docs"),
    makeAct("idle", at(13, 3, 2), at(13, 6, 0), null, true),
    makeAct("Slack.exe", at(13, 6, 2), at(13, 9, 0), "#general"),
  ];
  const blocks = buildTimelineBlocks(acts, DAY_START, 120);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].kind, "idle");
  assertZeroOverlap(blocks, "idle-boundary");
}

// 4. Tightly sandwiched 10s sliver between two 45m focus blocks stays visible & non-overlapping
{
  const acts = [
    makeAct("Code.exe", at(14, 0, 0), at(14, 45, 0), "main.rs"),
    makeAct("Slack.exe", at(14, 45, 2), at(14, 45, 12), "Quick DM"),
    makeAct("Code.exe", at(14, 45, 14), at(15, 30, 0), "main.rs"),
  ];
  for (const pxPerHour of [60, 120, 240, 480]) {
    const blocks = buildTimelineBlocks(acts, DAY_START, pxPerHour);
    assert.equal(blocks.length, 3);
    assert.ok(blocks[1].heightPx >= 4, `sliver stays hoverable at ${pxPerHour}px/h (got ${blocks[1].heightPx})`);
    assertZeroOverlap(blocks, `sliver-${pxPerHour}`);
  }
}

// 5. Fresh 3-minute multi-window burst followed by empty space gets a crisp 24px multi-icon card
{
  const acts = [
    makeAct("Code.exe", at(21, 20, 0), at(21, 20, 40), "TimelineView.tsx"),
    makeAct("chrome.exe", at(21, 20, 42), at(21, 21, 20), "Docs"),
    makeAct("WindowsTerminal.exe", at(21, 21, 22), at(21, 22, 0), "cargo build"),
    makeAct("Slack.exe", at(21, 22, 2), at(21, 22, 40), "#dev"),
    makeAct("explorer.exe", at(21, 22, 42), at(21, 23, 0), "target"),
  ];
  const blocks = buildTimelineBlocks(acts, DAY_START, 120);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "cluster");
  assert.equal(blocks[0].apps.length, 5);
  assert.equal(blocks[0].heightPx, 24);
  assertZeroOverlap(blocks, "fresh-3min-burst");
}

// 6. Synthetic simultaneous / overlapping raw logs still maintain strict zero visual overlap
{
  const acts = [
    makeAct("Code.exe", at(16, 0, 0), at(16, 30, 0), "A"),
    makeAct("idle", at(16, 0, 0), at(16, 0, 10), null, true),
    makeAct("chrome.exe", at(16, 0, 10), at(16, 25, 0), "B"),
  ];
  for (const pxPerHour of [60, 120, 240, 480]) {
    const blocks = buildTimelineBlocks(acts, DAY_START, pxPerHour);
    assertZeroOverlap(blocks, `simultaneous-${pxPerHour}`);
  }
}

// 7. Track 2 Time Entries calendar column partitioning handles overlapping and tight entries
{
  const makeEntry = (id: string, startMs: number, endMs: number): ClampedEntry => ({
    entry: {
      id,
      description: id,
      startedAt: startMs,
      endedAt: endMs,
      ticktickProjectId: null,
      ticktickParentTaskId: null,
      ticktickSubtaskId: null,
      syncMode: null,
      syncStatus: "local",
      syncError: null,
      retryCount: 0,
      completeParentTask: false,
      tagIds: [],
      createdAt: startMs,
      updatedAt: endMs,
    },
    startMs,
    endMs,
  });

  const entries = [
    makeEntry("a", at(9, 0), at(10, 0)),
    makeEntry("b", at(9, 30), at(10, 30)),
    makeEntry("c", at(9, 45), at(10, 15)),
    makeEntry("d", at(11, 0), at(12, 0)),
  ];

  const laid = layoutTimeEntries(entries, DAY_START, 120);
  const byId = new Map(laid.map((x) => [x.entry.id, x]));
  assert.equal(byId.get("a")?.totalCols, 3);
  assert.equal(byId.get("b")?.totalCols, 3);
  assert.equal(byId.get("c")?.totalCols, 3);
  assert.equal(new Set([byId.get("a")?.colIndex, byId.get("b")?.colIndex, byId.get("c")?.colIndex]).size, 3);
  assert.equal(byId.get("d")?.totalCols, 1);
  assert.equal(byId.get("d")?.colIndex, 0);
}

console.log("All timeline layout tests passed!");
