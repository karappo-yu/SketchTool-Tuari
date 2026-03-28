export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
