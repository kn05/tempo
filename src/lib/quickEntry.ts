import type { ParsedQuickEntry, Tag, TickTickProject } from "../types";

const TRAILING_PUNCTUATION = /[,.;:!?)\]]+$/;

/**
 * Parses `@project` / `@"Multi Word Project"` and `#tag` / `#"Multi Word Tag"` tokens
 * from a quick-entry string. Mirrors `crates/tempo-core/src/parser.rs`.
 */
export function parseQuickEntry(input: string): ParsedQuickEntry {
  const descriptionParts: string[] = [];
  let projectHint: string | null = null;
  const tagNames: string[] = [];
  const seenTags = new Set<string>();

  const chars = Array.from(input);
  const len = chars.length;
  let i = 0;

  while (i < len) {
    while (i < len && /\s/.test(chars[i])) {
      i += 1;
    }
    if (i >= len) break;

    const start = i;
    const ch = chars[i];

    if (ch === "@" || ch === "#") {
      const isProject = ch === "@";
      if (i + 1 < len && chars[i + 1] === '"') {
        let end = i + 2;
        while (end < len && chars[end] !== '"') {
          end += 1;
        }
        if (end < len && chars[end] === '"') {
          const trimmed = chars.slice(i + 2, end).join("").trim();
          if (trimmed.length > 0) {
            if (isProject) {
              projectHint = trimmed;
            } else {
              const key = trimmed.toLowerCase();
              if (!seenTags.has(key)) {
                seenTags.add(key);
                tagNames.push(trimmed);
              }
            }
            i = end + 1;
            continue;
          }
        }
      } else {
        let end = i + 1;
        while (end < len && !/\s/.test(chars[end])) {
          end += 1;
        }
        const raw = chars.slice(i + 1, end).join("");
        const cleaned = raw.replace(TRAILING_PUNCTUATION, "");
        if (cleaned.length > 0 && !cleaned.startsWith("@") && !cleaned.startsWith("#")) {
          if (isProject) {
            projectHint = cleaned;
          } else {
            const key = cleaned.toLowerCase();
            if (!seenTags.has(key)) {
              seenTags.add(key);
              tagNames.push(cleaned);
            }
          }
          i = end;
          continue;
        }
      }
    }

    let end = start;
    while (end < len && !/\s/.test(chars[end])) {
      end += 1;
    }
    descriptionParts.push(chars.slice(start, end).join(""));
    i = end;
  }

  return {
    description: descriptionParts.join(" "),
    projectHint,
    tagNames,
  };
}

export interface ActiveQuickToken {
  trigger: "@" | "#";
  query: string;
  start: number;
  end: number;
}

/**
 * Detects an active `@project` or `#tag` token at the current caret position for live autocomplete.
 */
export function getActiveTokenAtCursor(
  input: string,
  cursorPos: number,
): ActiveQuickToken | null {
  const safePos = Math.max(0, Math.min(cursorPos, input.length));
  let start = safePos;
  while (start > 0 && !/\s/.test(input[start - 1])) {
    start -= 1;
  }
  const token = input.slice(start, safePos);
  if (token.length === 0) return null;
  const trigger = token[0];
  if (trigger !== "@" && trigger !== "#") return null;
  const query = token.slice(1).replace(/^"/, "");
  return {
    trigger,
    query,
    start,
    end: safePos,
  };
}

export function matchProjectByHint(
  hint: string | null,
  projects: TickTickProject[],
): TickTickProject | null {
  if (!hint) return null;
  const needle = hint.trim().toLowerCase();
  if (!needle) return null;

  const exact = projects.find((p) => p.name.toLowerCase() === needle);
  if (exact) return exact;

  const prefix = projects.find((p) => p.name.toLowerCase().startsWith(needle));
  if (prefix) return prefix;

  return projects.find((p) => p.name.toLowerCase().includes(needle)) ?? null;
}

export function matchTagByName(name: string, tags: Tag[]): Tag | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return tags.find((t) => t.name.toLowerCase() === needle) ?? null;
}

/**
 * Removes the active `@token` or `#token` range from the input string cleanly.
 */
export function stripTokenRange(input: string, start: number, end: number): string {
  const before = input.slice(0, start);
  const after = input.slice(end);
  return `${before}${after}`.replace(/\s{2,}/g, " ").trimStart();
}
