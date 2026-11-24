import {
  Clock,
  Code2,
  Coffee,
  FileText,
  Folder,
  Globe,
  MessageSquare,
  Music,
  Palette,
  Presentation,
  Settings,
  Table2,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { cleanProcessLabel, getProcessColor } from "../lib/time";
import type { AppActivitySummary } from "../lib/timelineLayout";

type BadgeSize = "xs" | "sm" | "md";

const ICON_MATCHERS: { test: (key: string) => boolean; icon: LucideIcon }[] = [
  {
    test: (k) =>
      k.includes("code") ||
      k.includes("cursor") ||
      k.includes("idea") ||
      k.includes("devenv") ||
      k.includes("windsurf") ||
      k.includes("zed") ||
      k.includes("neovim") ||
      k.includes("nvim") ||
      k.includes("pycharm") ||
      k.includes("webstorm") ||
      k.includes("rustrover"),
    icon: Code2,
  },
  {
    test: (k) =>
      k.includes("chrome") ||
      k.includes("msedge") ||
      k.includes("edge") ||
      k.includes("firefox") ||
      k.includes("brave") ||
      k.includes("arc") ||
      k.includes("whale") ||
      k.includes("opera") ||
      k.includes("vivaldi"),
    icon: Globe,
  },
  {
    test: (k) =>
      k.includes("terminal") ||
      k === "wt.exe" ||
      k.includes("pwsh") ||
      k.includes("powershell") ||
      k === "cmd.exe" ||
      k.includes("alacritty") ||
      k.includes("wezterm") ||
      k.includes("mintty") ||
      k.includes("bash"),
    icon: Terminal,
  },
  {
    test: (k) =>
      k.includes("slack") ||
      k.includes("discord") ||
      k.includes("kakao") ||
      k.includes("teams") ||
      k.includes("telegram") ||
      k.includes("line") ||
      k.includes("zoom") ||
      k.includes("mail") ||
      k.includes("outlook"),
    icon: MessageSquare,
  },
  {
    test: (k) =>
      k.includes("figma") ||
      k.includes("photoshop") ||
      k.includes("illustrator") ||
      k.includes("blender") ||
      k.includes("paint"),
    icon: Palette,
  },
  {
    test: (k) =>
      k.includes("notion") ||
      k.includes("obsidian") ||
      k.includes("winword") ||
      k.includes("notepad") ||
      k.includes("ticktick") ||
      k.includes("onenote") ||
      k.includes("acrobat"),
    icon: FileText,
  },
  {
    test: (k) => k === "explorer.exe" || k.includes("files"),
    icon: Folder,
  },
  {
    test: (k) => k.includes("excel"),
    icon: Table2,
  },
  {
    test: (k) => k.includes("powerpnt") || k.includes("keynote"),
    icon: Presentation,
  },
  {
    test: (k) => k.includes("spotify") || k.includes("music") || k.includes("vlc"),
    icon: Music,
  },
  {
    test: (k) => k.includes("tempo"),
    icon: Clock,
  },
  {
    test: (k) => k.includes("settings") || k.includes("control"),
    icon: Settings,
  },
];

function resolveAppIcon(processName: string): LucideIcon | null {
  const key = processName.trim().toLowerCase();
  for (const matcher of ICON_MATCHERS) {
    if (matcher.test(key)) return matcher.icon;
  }
  return null;
}

function getMonogram(processName: string): string {
  const cleaned = cleanProcessLabel(processName).trim();
  if (!cleaned) return "?";
  return cleaned.slice(0, 1).toUpperCase();
}

const SIZE_CLASSES: Record<BadgeSize, { box: string; icon: string; text: string }> = {
  xs: { box: "h-3.5 w-3.5", icon: "h-2 w-2", text: "text-[8px]" },
  sm: { box: "h-4 w-4", icon: "h-2.5 w-2.5", text: "text-[9px]" },
  md: { box: "h-5 w-5", icon: "h-3 w-3", text: "text-[10px]" },
};

interface AppBadgeIconProps {
  processName: string;
  isIdle?: boolean;
  size?: BadgeSize;
  ring?: boolean;
  title?: string;
}

export function AppBadgeIcon({
  processName,
  isIdle = false,
  size = "sm",
  ring = false,
  title,
}: AppBadgeIconProps) {
  const dims = SIZE_CLASSES[size];

  if (isIdle) {
    return (
      <span
        title={title ?? "유휴 (Idle)"}
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-amber-500/25 text-amber-300 ${dims.box} ${
          ring ? "ring-1 ring-zinc-900" : ""
        }`}
      >
        <Coffee className={dims.icon} />
      </span>
    );
  }

  const style = getProcessColor(processName);
  const Icon = resolveAppIcon(processName);

  return (
    <span
      title={title ?? cleanProcessLabel(processName)}
      style={{
        backgroundColor: style.hex,
        color: "#09090b",
      }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold shadow-xs ${dims.box} ${
        ring ? "ring-[1.5px] ring-zinc-900" : ""
      }`}
    >
      {Icon ? (
        <Icon className={dims.icon} strokeWidth={2.5} />
      ) : (
        <span className={`leading-none ${dims.text}`}>{getMonogram(processName)}</span>
      )}
    </span>
  );
}

interface AppIconStackProps {
  apps: AppActivitySummary[];
  maxIcons?: number;
  size?: BadgeSize;
}

/**
 * Stacked circular app badges showing the top apps active inside a grouped timeline block.
 */
export function AppIconStack({ apps, maxIcons = 4, size = "sm" }: AppIconStackProps) {
  const visible = apps.slice(0, maxIcons);
  const overflow = Math.max(0, apps.length - visible.length);
  const dims = SIZE_CLASSES[size];

  return (
    <span className="inline-flex shrink-0 items-center -space-x-1">
      {visible.map((app) => (
        <AppBadgeIcon
          key={app.processKey}
          processName={app.processName}
          size={size}
          ring
          title={app.label}
        />
      ))}
      {overflow > 0 && (
        <span
          className={`inline-flex shrink-0 items-center justify-center rounded-full bg-zinc-700 font-mono font-semibold text-zinc-100 ring-[1.5px] ring-zinc-900 ${dims.box} ${dims.text}`}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
