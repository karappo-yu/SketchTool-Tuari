export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3));
  const g = parseInt(hex.slice(3, 5));
  const b = parseInt(hex.slice(5, 7));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 快捷键的物理键位映射：中文输入法等 IME 激活时，macOS 会把 event.key
// 报告为 "Process"（keyCode 229），此时改按 event.code 识别按下的键
const PHYSICAL_KEY_BY_CODE = {
  BracketLeft: "[",
  BracketRight: "]",
  KeyB: "b",
  KeyE: "e",
  KeyG: "g",
  KeyH: "h",
  KeyM: "m",
  Space: " ",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  Escape: "escape",
};

/** 统一解析快捷键键名（小写）：优先物理键位 event.code（IME 下 key 不可靠），回退 event.key */
export function shortcutKey(event) {
  const mapped = event.code ? PHYSICAL_KEY_BY_CODE[event.code] : undefined;
  if (mapped) {
    return mapped;
  }
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  return key === "process" ? "" : key;
}

/** 快捷键涉及的物理键位集合 */
export const SHORTCUT_CODE_SET = new Set(Object.keys(PHYSICAL_KEY_BY_CODE));

// 双路径去重：同一物理按键会同时到达 DOM keydown（英文输入法）与 Rust
// native-key 桥（中文输入法下唯一可达的通道），两边只允许处理一次
const recentShortcutCodes = new Map();
const SHORTCUT_DEDUPE_MS = 50;

export function wasShortcutKeyJustHandled(code) {
  const at = recentShortcutCodes.get(code);
  return typeof at === "number" && performance.now() - at < SHORTCUT_DEDUPE_MS;
}

export function markShortcutKeyHandled(code) {
  recentShortcutCodes.set(code, performance.now());
}

export function formatTimeForHint(totalSeconds, lang = "zh-CN") {
  if (totalSeconds === Infinity) {
    if (lang === "en") {
      return "Unlimited";
    }
    if (lang === "ja") {
      return "無制限";
    }
    return "无限制时间";
  }

  if (Number.isNaN(totalSeconds) || totalSeconds <= 0) {
    return "";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (lang === "en") {
    if (hours > 0) {
      parts.push(`${hours}h`);
    }
    if (minutes > 0) {
      parts.push(`${minutes}m`);
    }
    if (seconds > 0) {
      parts.push(`${seconds}s`);
    }
    return parts.length > 0 ? parts.join(" ") : `${totalSeconds}s`;
  }

  if (lang === "ja") {
    if (hours > 0) {
      parts.push(`${hours}時間`);
    }
    if (minutes > 0) {
      parts.push(`${minutes}分`);
    }
    if (seconds > 0) {
      parts.push(`${seconds}秒`);
    }
    return parts.length > 0 ? parts.join("") : `${totalSeconds}秒`;
  }

  if (hours > 0) {
    parts.push(`${hours}小时`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}分`);
  }
  if (seconds > 0) {
    parts.push(`${seconds}秒`);
  }

  return parts.length > 0 ? parts.join("") : `${totalSeconds}秒`;
}
