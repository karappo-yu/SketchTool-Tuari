export function shuffleArray(array) {
  const next = [...array];
  for (let currentIndex = next.length - 1; currentIndex > 0; currentIndex -= 1) {
    const randomIndex = Math.floor(Math.random() * (currentIndex + 1));
    [next[currentIndex], next[randomIndex]] = [next[randomIndex], next[currentIndex]];
  }
  return next;
}

export function naturalSort(a, b) {
  const nameA = a.name || "";
  const nameB = b.name || "";
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: "base" });
}

export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getParentPath(currentPath) {
  if (!currentPath) {
    return null;
  }

  const normalized = currentPath.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[/\\]/);
  if (parts.length <= 1) {
    return null;
  }

  if (parts.length === 1 && /^[a-zA-Z]:$/.test(parts[0])) {
    return null;
  }

  parts.pop();
  const separator = currentPath.includes("\\") ? "\\" : "/";
  let parent = parts.join(separator);

  if (!parent) {
    return separator;
  }

  if (/^[a-zA-Z]:$/.test(parent) && separator === "\\") {
    parent += "\\";
  }

  return parent;
}

export function formatTimeForHint(totalSeconds) {
  if (totalSeconds === Infinity) {
    return "无限制时间";
  }

  if (Number.isNaN(totalSeconds) || totalSeconds <= 0) {
    return "";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

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

export function createEmptyHistory() {
  return {
    displayedImageHistory: [],
    historyPointer: -1,
    currentSessionPlaybackQueue: [],
  };
}
