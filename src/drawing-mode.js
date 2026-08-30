import { desktop } from "./api/desktop.js";
import { elements } from "./dom.js";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n.js";
import { shortcutKey } from "./utils.js";

const ANNOTATION_OFFSCREEN_MAX_WIDTH = 2560;
const ANNOTATION_SIZE_MIN = 1;
const ANNOTATION_SIZE_MAX = 30;
const FILL_TOLERANCE = 32;
const STRIP_HIDE_DELAY_MS = 500;
const STRIP_REVEAL_EDGE_PX = 90;

const byId = (id) => document.getElementById(id);

/**
 * 笔画动作数据格式（v3，按图片路径持久化于 SQLite）：
 *   { version: 3, layers: [
 *       { id, name, opacity, actions: [
 *           { type: "draw"|"erase", stroke: { points: [[x, y, pressure?], ...], color, width } }
 *           { type: "fill", point: [x, y], color }
 *           { type: "clear" }
 *       ] }
 *   ] }
 * 点坐标为 0..1 归一化值，pressure 可省略（旧数据，按恒定线宽渲染）。
 * v2（单层 actions）与 v1（纯笔画数组）加载时自动迁移为单图层。
 */
function normalizeAnnotationActions(actions) {
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions.filter((action) => {
    if (!action) {
      return false;
    }
    if (action.type === "clear") {
      return true;
    }
    if (action.type === "fill") {
      return Array.isArray(action.point) && action.point.length >= 2;
    }
    if (action.type !== "draw" && action.type !== "erase") {
      return false;
    }
    const stroke = action.stroke;
    return stroke && Array.isArray(stroke.points) && stroke.points.length > 0;
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function hexToRgbBytes(hex) {
  const value = String(hex || "").replace("#", "");
  const full = value.length === 3 ? value.split("").map((ch) => ch + ch).join("") : value;
  const int = parseInt(full, 16);
  if (Number.isNaN(int)) {
    return [255, 77, 79, 255];
  }
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255, 255];
}

function hslToHex(h, s, l) {
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const light = Math.min(100, Math.max(0, l)) / 100;
  const hue = ((Number(h) || 0) % 360 + 360) % 360;
  const k = (n) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to255 = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${to255(f(0))}${to255(f(8))}${to255(f(4))}`.toUpperCase();
}

function hexToHsl(hex) {
  const [r, g, b] = hexToRgbBytes(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = light > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) {
      h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h = Math.round(h * 60);
  }
  return { h, s: Math.round(s * 100), l: Math.round(light * 100) };
}

/** 扫描线洪泛填充（油漆桶）：以起点颜色为基准，容差内的连续区域填充为目标色 */
function floodFill(ctx, scaleX, scaleY, point, hexColor) {
  const canvas = ctx.canvas;
  const width = canvas.width;
  const height = canvas.height;
  if (width <= 0 || height <= 0) {
    return;
  }
  const startX = Math.min(width - 1, Math.max(0, Math.floor(point[0] * scaleX)));
  const startY = Math.min(height - 1, Math.max(0, Math.floor(point[1] * scaleY)));

  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const fill = hexToRgbBytes(hexColor);
  const startIndex = (startY * width + startX) * 4;
  const target = [data[startIndex], data[startIndex + 1], data[startIndex + 2], data[startIndex + 3]];

  if (Math.abs(target[0] - fill[0]) <= FILL_TOLERANCE
    && Math.abs(target[1] - fill[1]) <= FILL_TOLERANCE
    && Math.abs(target[2] - fill[2]) <= FILL_TOLERANCE
    && Math.abs(target[3] - fill[3]) <= FILL_TOLERANCE) {
    return; // 起点已是目标色
  }

  const matches = (index) => {
    const i = index * 4;
    return Math.abs(data[i] - target[0]) <= FILL_TOLERANCE
      && Math.abs(data[i + 1] - target[1]) <= FILL_TOLERANCE
      && Math.abs(data[i + 2] - target[2]) <= FILL_TOLERANCE
      && Math.abs(data[i + 3] - target[3]) <= FILL_TOLERANCE;
  };

  if (!matches(startY * width + startX)) {
    return;
  }

  const visited = new Uint8Array(width * height);
  const stack = [[startX, startY]];
  while (stack.length > 0) {
    const [x, y] = stack.pop();

    let left = x;
    while (left >= 0) {
      const idx = y * width + left;
      if (visited[idx] || !matches(idx)) {
        break;
      }
      left -= 1;
    }
    left += 1;

    let right = x;
    while (right < width) {
      const idx = y * width + right;
      if (visited[idx] || !matches(idx)) {
        break;
      }
      right += 1;
    }
    right -= 1;

    for (let i = left; i <= right; i += 1) {
      const idx = y * width + i;
      visited[idx] = 1;
      const p = idx * 4;
      data[p] = fill[0];
      data[p + 1] = fill[1];
      data[p + 2] = fill[2];
      data[p + 3] = 255;
    }

    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) {
        continue;
      }
      let inSpan = false;
      for (let i = left; i <= right; i += 1) {
        const idx = ny * width + i;
        const ok = !visited[idx] && matches(idx);
        if (ok && !inSpan) {
          stack.push([i, ny]);
          inSpan = true;
        } else if (!ok) {
          inSpan = false;
        }
      }
    }
  }

  // 边缘外扩 1 像素：吞掉抗锯齿过渡像素，避免填充与轮廓之间留白缝
  const grown = [];
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = rowOffset + x;
      if (visited[idx]) {
        continue;
      }
      if (
        (x > 0 && visited[idx - 1])
        || (x < width - 1 && visited[idx + 1])
        || (y > 0 && visited[idx - width])
        || (y < height - 1 && visited[idx + width])
      ) {
        grown.push(idx);
      }
    }
  }
  for (const idx of grown) {
    const p = idx * 4;
    data[p] = fill[0];
    data[p + 1] = fill[1];
    data[p + 2] = fill[2];
    data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function applyAction(ctx, action, scaleX, scaleY) {
  if (action.type === "clear") {
    ctx.clearRect(0, 0, scaleX, scaleY);
    return;
  }
  if (action.type === "fill") {
    floodFill(ctx, scaleX, scaleY, action.point || [0.5, 0.5], action.color || "#FF4D4F");
    return;
  }

  const stroke = action.stroke || {};
  const points = stroke.points || [];
  if (points.length === 0) {
    return;
  }
  const baseWidth = Math.max(1, (stroke.width ?? 0.01) * scaleX);
  const pressureAt = (index) => {
    const point = points[index];
    return point.length >= 3 ? Math.min(1, Math.max(0.05, point[2])) : 1;
  };

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (action.type === "erase") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "#000000";
    ctx.fillStyle = "#000000";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color || "#FF4D4F";
    ctx.fillStyle = stroke.color || "#FF4D4F";
  }

  if (points.length === 1) {
    const [nx, ny] = points[0];
    ctx.lineWidth = baseWidth;
    ctx.beginPath();
    ctx.arc(nx * scaleX, ny * scaleY, baseWidth * pressureAt(0) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    for (let index = 1; index < points.length; index += 1) {
      const [ax, ay] = points[index - 1];
      const [bx, by] = points[index];
      ctx.lineWidth = Math.max(1, baseWidth * (pressureAt(index - 1) + pressureAt(index)) / 2);
      ctx.beginPath();
      ctx.moveTo(ax * scaleX, ay * scaleY);
      ctx.lineTo(bx * scaleX, by * scaleY);
      ctx.stroke();
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

/**
 * 一个可作画的画面：多个图层（各自位图与透明度）、动作回放渲染、
 * 独立的撤销/重做与持久化。临摹模式下有两个实例：
 * 参考图注释面（reference，最底层为参考图）与白色临摹画布面（practice，最底层为白色画布）。
 * layout/mirror/resolution/saveKey/newLayerName 由控制器注入。
 */
class AnnotationSurface {
  constructor({ canvas, layout, mirror, resolution, saveKey, newLayerName, onChanged }) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext("2d") : null;
    this.layoutFn = layout;
    this.mirrorFn = mirror;
    this.resolutionFn = resolution;
    this.saveKeyFn = saveKey;
    this.newLayerNameFn = newLayerName;
    this.onChanged = onChanged;
    this.layers = [];
    this.activeLayerId = null;
    this.layerIdCounter = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.offscreen = null;
    this.loadToken = 0;
    this.saveTimer = null;
  }

  makeLayer() {
    this.layerIdCounter += 1;
    return {
      id: this.layerIdCounter,
      name: this.newLayerNameFn(this.layerIdCounter),
      opacity: 1,
      actions: [],
      bitmap: null,
      dirty: true,
    };
  }

  activeLayer() {
    return this.layers.find((layer) => layer.id === this.activeLayerId) || null;
  }

  invalidate() {
    this.loadToken += 1;
    this.resetRuntime();
  }

  ensureOffscreen() {
    const resolution = this.resolutionFn();
    if (!resolution) {
      return null;
    }
    if (!this.offscreen || this.offscreen.width !== resolution.width || this.offscreen.height !== resolution.height) {
      this.offscreen = document.createElement("canvas");
      this.offscreen.width = resolution.width;
      this.offscreen.height = resolution.height;
    }
    return this.offscreen;
  }

  syncCanvas() {
    if (!this.ctx) {
      return null;
    }
    const layout = this.layoutFn();
    if (!layout) {
      return null;
    }
    const { left, top, width, height, dpr } = layout;
    if (this.canvas.style.left !== `${left}px`) {
      this.canvas.style.left = `${left}px`;
    }
    if (this.canvas.style.top !== `${top}px`) {
      this.canvas.style.top = `${top}px`;
    }
    if (this.canvas.style.width !== `${width}px`) {
      this.canvas.style.width = `${width}px`;
    }
    if (this.canvas.style.height !== `${height}px`) {
      this.canvas.style.height = `${height}px`;
    }
    if (this.canvas.width !== Math.round(width * dpr)) {
      this.canvas.width = Math.round(width * dpr);
    }
    if (this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.height = Math.round(height * dpr);
    }
    return layout;
  }

  /** 取图层位图（懒创建，脏时从动作重放重建） */
  layerBitmap(layer, resolution) {
    if (!layer.bitmap || layer.bitmap.width !== resolution.width || layer.bitmap.height !== resolution.height) {
      layer.bitmap = document.createElement("canvas");
      layer.bitmap.width = resolution.width;
      layer.bitmap.height = resolution.height;
      layer.dirty = true;
    }
    if (layer.dirty) {
      const ctx = layer.bitmap.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, resolution.width, resolution.height);
      for (const action of layer.actions) {
        applyAction(ctx, action, resolution.width, resolution.height);
      }
      layer.dirty = false;
    }
    return layer.bitmap;
  }

  /** 合成：图层自底向上按各自透明度叠加 */
  replay() {
    const offscreen = this.ensureOffscreen();
    if (!offscreen) {
      return;
    }
    const resolution = this.resolutionFn();
    if (!resolution) {
      return;
    }
    const ctx = offscreen.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, offscreen.width, offscreen.height);
    for (const layer of this.layers) {
      const bitmap = this.layerBitmap(layer, resolution);
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(bitmap, 0, 0);
    }
    ctx.globalAlpha = 1;
  }

  blit() {
    if (!this.ctx || !this.offscreen) {
      return;
    }
    const layout = this.syncCanvas();
    if (!layout) {
      return;
    }
    const { width, height, dpr } = layout;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    if (this.mirrorFn()) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.offscreen, 0, 0, width, height);
    ctx.restore();
  }

  render() {
    if (!this.ctx) {
      return;
    }
    if (this.ensureOffscreen()) {
      this.replay();
      this.blit();
      return;
    }
    const layout = this.syncCanvas();
    if (!layout) {
      return;
    }
    this.ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
    this.ctx.clearRect(0, 0, layout.width, layout.height);
  }

  clearVisible() {
    if (!this.ctx) {
      return;
    }
    const layout = this.syncCanvas();
    if (!layout) {
      return;
    }
    this.ctx.setTransform(layout.dpr, 0, 0, layout.dpr, 0, 0);
    this.ctx.clearRect(0, 0, layout.width, layout.height);
  }

  resetRuntime() {
    for (const layer of this.layers) {
      layer.bitmap = null;
    }
    const layer = this.makeLayer();
    this.layers = [layer];
    this.activeLayerId = layer.id;
    this.offscreen = null;
    this.clearVisible();
  }

  serialize() {
    return {
      version: 3,
      layers: this.layers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        opacity: layer.opacity,
        actions: layer.actions,
      })),
    };
  }

  scheduleSave() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }

    const saveKey = this.saveKeyFn();
    const snapshot = this.serialize();
    if (!saveKey) {
      return;
    }

    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      desktop.saveImageAnnotations(saveKey, snapshot).catch((error) => {
        console.error("Failed to save image annotations:", error);
      });
    }, 500);
  }

  async load() {
    const token = this.loadToken + 1;
    this.loadToken = token;
    this.resetRuntime();

    const saveKey = this.saveKeyFn();
    if (!saveKey || elements.imageDisplayArea.classList.contains("hidden")) {
      return;
    }

    try {
      const payload = await desktop.loadImageAnnotations(saveKey);
      if (this.loadToken !== token) {
        return;
      }

      if (payload && Array.isArray(payload.layers) && payload.layers.length > 0) {
        // v3：多图层
        this.layers = payload.layers.map((data) => {
          const layer = this.makeLayer();
          if (Number.isInteger(data.id) && data.id > 0) {
            layer.id = data.id;
          }
          if (typeof data.name === "string" && data.name) {
            layer.name = data.name;
          }
          const opacity = Number(data.opacity);
          layer.opacity = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
          layer.actions = normalizeAnnotationActions(data.actions);
          layer.dirty = true;
          return layer;
        });
        this.layerIdCounter = Math.max(...this.layers.map((layer) => layer.id), 0);
        this.activeLayerId = this.layers[this.layers.length - 1].id;
      } else {
        // v2 / v1：迁移为单图层
        this.layers[0].actions = normalizeAnnotationActions(Array.isArray(payload) ? payload : payload?.actions);
        this.layers[0].dirty = true;
      }
      this.onChanged();
    } catch (error) {
      console.error("Failed to load image annotations:", error);
    }
  }

  pushHistory(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 100) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  recordAction(action, layer) {
    layer.actions.push(action);
    const layerId = layer.id;
    this.pushHistory({
      undo: () => {
        const target = this.layers.find((item) => item.id === layerId);
        if (!target) {
          return;
        }
        const index = target.actions.indexOf(action);
        if (index >= 0) {
          target.actions.splice(index, 1);
        }
        target.dirty = true;
      },
      redo: () => {
        const target = this.layers.find((item) => item.id === layerId);
        if (!target) {
          return;
        }
        if (!target.actions.includes(action)) {
          target.actions.push(action);
          target.dirty = true;
        }
      },
    });
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) {
      return;
    }
    entry.undo();
    this.redoStack.push(entry);
    this.onChanged();
    this.scheduleSave();
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) {
      return;
    }
    entry.redo();
    this.undoStack.push(entry);
    if (this.undoStack.length > 100) {
      this.undoStack.shift();
    }
    this.onChanged();
    this.scheduleSave();
  }

  clearActiveLayer() {
    const layer = this.activeLayer();
    if (!layer || layer.actions.length === 0) {
      return;
    }
    const clearAction = { type: "clear" };
    layer.actions.push(clearAction);
    layer.dirty = true;
    const layerId = layer.id;
    this.pushHistory({
      undo: () => {
        const target = this.layers.find((item) => item.id === layerId);
        if (!target) {
          return;
        }
        const index = target.actions.indexOf(clearAction);
        if (index >= 0) {
          target.actions.splice(index, 1);
        }
        target.dirty = true;
      },
      redo: () => {
        const target = this.layers.find((item) => item.id === layerId);
        if (!target) {
          return;
        }
        if (!target.actions.includes(clearAction)) {
          target.actions.push(clearAction);
          target.dirty = true;
        }
      },
    });
    this.onChanged();
    this.scheduleSave();
  }

  addLayer() {
    const layer = this.makeLayer();
    this.layers.push(layer);
    this.activeLayerId = layer.id;
    this.onChanged();
    this.scheduleSave();
  }

  deleteActiveLayer() {
    if (this.layers.length <= 1) {
      return;
    }
    const index = this.layers.findIndex((layer) => layer.id === this.activeLayerId);
    if (index === -1) {
      return;
    }
    this.layers.splice(index, 1);
    this.activeLayerId = this.layers[Math.min(index, this.layers.length - 1)].id;
    this.onChanged();
    this.scheduleSave();
  }

  moveActiveLayer(delta) {
    const index = this.layers.findIndex((layer) => layer.id === this.activeLayerId);
    const target = index + delta;
    if (index === -1 || target < 0 || target >= this.layers.length) {
      return;
    }
    const [layer] = this.layers.splice(index, 1);
    this.layers.splice(target, 0, layer);
    this.onChanged();
    this.scheduleSave();
  }

  setLayerOpacity(percent) {
    const layer = this.activeLayer();
    if (!layer) {
      return;
    }
    layer.opacity = Math.min(1, Math.max(0, (Number(percent) || 0) / 100));
    this.onChanged();
    this.scheduleSave();
  }
}

/**
 * 画笔模式控制器：参考图上的笔记画板（画笔 / 像素橡皮 / 油漆桶 / 图层 / 撤销重做 / 持久化）、
 * 临摹模式（右侧同尺寸白色画布 + 同款网格），以及画笔模式专属的竖条工具菜单。
 *
 * host 为 AppController，模块通过它访问共享状态：
 * - host.state: isMirrorEnabled / isGridEnabled / currentGridColorHex /
 *   imageFiles / currentImageIndex 等
 * - host.isPlaybackVisible(): 轮播界面是否可见
 * - host.paintGridLines(ctx, width, height, dpr): 在给定画布上绘制与参考图一致的网格
 */
export class DrawingModeController {
  constructor(host) {
    this.host = host;

    this.canvas = byId("annotation-canvas");
    this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
    this.drawModeToggle = byId("drawModeToggle");
    this.backdrop = byId("image-backdrop");
    this.brushCursor = byId("brush-cursor");
    this.practiceStage = byId("practice-stage");
    this.practiceGridCanvas = byId("practice-grid-canvas");

    this.strip = byId("drawing-controls");
    this.stripToggle = byId("strip-toggle");
    this.stripCollapsed = false;
    this.toolButtons = {
      pen: byId("drawPenTool"),
      eraser: byId("drawEraserTool"),
      bucket: byId("drawBucketTool"),
      color: byId("drawColorTool"),
      size: byId("drawSizeTool"),
      undo: byId("drawUndoTool"),
      clear: byId("drawClearTool"),
      layer: byId("drawLayerTool"),
      copy: byId("drawCopyTool"),
      hideReference: byId("drawHideReferenceTool"),
      mirror: byId("drawMirrorTool"),
      exit: byId("drawExitTool"),
    };
    this.colorIndicator = byId("drawColorIndicator");
    this.colorPopout = byId("drawColorPopout");
    this.colorPreview = byId("drawColorPreview");
    this.colorHex = byId("drawColorHex");
    this.colorHueSlider = byId("colorHueSlider");
    this.colorSatSlider = byId("colorSatSlider");
    this.colorLightSlider = byId("colorLightSlider");
    this.sizeIndicatorDot = byId("drawSizeIndicatorDot");
    this.sizePopout = byId("drawSizePopout");
    this.sizeSlider = byId("drawSizeSlider");
    this.sizeValue = byId("drawSizeValue");
    this.layerList = byId("layerList");
    this.layerSurfaceToggle = byId("layerSurfaceToggle");
    this.layerSurfaceReference = byId("layerSurfaceReference");
    this.layerSurfacePractice = byId("layerSurfacePractice");
    this.layerAddButton = byId("layerAddButton");
    this.layerDeleteButton = byId("layerDeleteButton");
    this.layerUpButton = byId("layerUpButton");
    this.layerDownButton = byId("layerDownButton");
    this.popoutHosts = new Map([
      ["color", byId("drawColorSlot")],
      ["size", byId("drawSizeSlot")],
      ["layer", byId("drawLayerSlot")],
    ]);

    this.tool = {
      color: "#FF4D4F",
      size: 4,
      eraser: false,
      bucket: false,
    };
    this.isDrawModeEnabled = false;
    this.isCopyModeEnabled = false;
    this.referenceHidden = false;
    this.previewImageOpacity = 1;

    // 数位板：Rust 桥（macOS）推送的笔压样本流与橡皮擦设备标志；Windows 走原生 pressure
    this.pressureSamples = [];
    this.pressureSmoothed = 1;
    this.penEraserHeld = false;

    this.referenceSurface = new AnnotationSurface({
      canvas: byId("annotation-canvas"),
      layout: () => this.layoutReferenceCanvas(),
      mirror: () => this.host.state.isMirrorEnabled,
      resolution: () => this.imageNaturalResolution(),
      saveKey: () => this.currentImagePath(),
      newLayerName: (n) => t("layerDefaultName").replace("{n}", n),
      onChanged: () => this.renderAll(),
    });
    this.practiceSurface = new AnnotationSurface({
      canvas: byId("practice-canvas"),
      layout: () => this.layoutPracticeCanvas(),
      mirror: () => false,
      resolution: () => this.imageNaturalResolution(),
      saveKey: () => {
        const path = this.currentImagePath();
        return path ? `practice:${path}` : "";
      },
      newLayerName: (n) => t("layerDefaultName").replace("{n}", n),
      onChanged: () => this.renderAll(),
    });
    this.surfaces = [this.referenceSurface, this.practiceSurface];
    this.activeSurface = this.referenceSurface;
    // 保证任何时刻每个画面至少有一个可用图层
    for (const surface of this.surfaces) {
      surface.resetRuntime();
    }

    this.activeStroke = null;
    this.lastPoint = null;
    this.isStrokeActive = false;
    this.redrawFrame = null;
    this.stripHideTimer = null;
    this.openPopoutName = "";
  }

  // ---- 生命周期（由 AppController 委托调用） ----

  bindEvents() {
    if (!this.canvas || !this.drawModeToggle) {
      return;
    }

    this.drawModeToggle.addEventListener("click", () => this.setDrawModeEnabled(!this.isDrawModeEnabled));
    this.toolButtons.exit.addEventListener("click", () => this.setDrawModeEnabled(false));
    this.toolButtons.copy.addEventListener("click", () => this.setCopyModeEnabled(!this.isCopyModeEnabled));
    this.toolButtons.hideReference.addEventListener("click", () => this.setReferenceHidden(!this.referenceHidden));
    this.toolButtons.mirror.addEventListener("click", () => this.host.toggleMirrorEffect());
    this.toolButtons.pen.addEventListener("click", () => this.selectPenTool());
    this.toolButtons.eraser.addEventListener("click", () => this.selectEraserTool());
    this.toolButtons.bucket.addEventListener("click", () => this.selectBucketTool());
    this.toolButtons.undo.addEventListener("click", () => this.activeSurface.undo());
    this.toolButtons.clear.addEventListener("click", () => this.activeSurface.clearActiveLayer());
    this.toolButtons.layer.addEventListener("click", () => this.togglePopout("layer"));
    this.toolButtons.color.addEventListener("click", () => this.togglePopout("color"));
    this.toolButtons.size.addEventListener("click", () => this.togglePopout("size"));

    this.colorPopout.addEventListener("click", (event) => {
      const swatch = event.target.closest(".annotation-color-swatch");
      if (!swatch) {
        return;
      }
      this.tool.color = swatch.dataset.color || this.tool.color;
      this.colorIndicator.style.background = this.tool.color;
      this.colorPopout.querySelectorAll(".annotation-color-swatch").forEach((item) => {
        item.classList.toggle("active", item === swatch);
      });
      this.syncColorEditors();
      this.selectPenTool({ keepPopout: true });
      // 保持面板打开，方便基于预设色继续用 HSL 滑条微调
    });

    for (const slider of [this.colorHueSlider, this.colorSatSlider, this.colorLightSlider]) {
      slider.addEventListener("input", () => this.applyHslFromSliders());
    }

    this.sizeSlider.addEventListener("input", (event) => this.applySize(event.target.value));

    this.layerAddButton.addEventListener("click", () => {
      this.activeSurface.addLayer();
      this.renderLayerPanel();
    });
    this.layerDeleteButton.addEventListener("click", () => {
      this.activeSurface.deleteActiveLayer();
      this.renderLayerPanel();
    });
    this.layerUpButton.addEventListener("click", () => {
      this.activeSurface.moveActiveLayer(1);
      this.renderLayerPanel();
    });
    this.layerDownButton.addEventListener("click", () => {
      this.activeSurface.moveActiveLayer(-1);
      this.renderLayerPanel();
    });

    // 图层列表：点行选中；拖滑条调透明度（事件委托，行内容由 JS 重建）
    this.layerList.addEventListener("click", (event) => {
      const row = event.target.closest(".layer-row");
      if (!row || row.classList.contains("locked")) {
        return;
      }
      const id = Number(row.dataset.layerId);
      if (!id || !this.activeSurface.layers.some((layer) => layer.id === id)) {
        return;
      }
      this.activeSurface.activeLayerId = id;
      this.syncHistoryButtons();
      this.renderLayerPanel();
    });
    this.layerList.addEventListener("input", (event) => {
      const input = event.target;
      if (!input.classList.contains("layer-opacity")) {
        return;
      }
      if (input.dataset.kind === "reference") {
        this.setReferenceOpacity(input.value);
        return;
      }
      const id = Number(input.dataset.layerId);
      const layer = this.activeSurface.layers.find((item) => item.id === id);
      if (!layer) {
        return;
      }
      layer.opacity = Math.min(1, Math.max(0, (Number(input.value) || 0) / 100));
      this.activeSurface.onChanged();
      this.activeSurface.scheduleSave();
    });

    for (const surface of this.surfaces) {
      if (!surface.canvas) {
        continue;
      }
      surface.canvas.addEventListener("pointerdown", (event) => this.handlePointerDown(surface, event));
      surface.canvas.addEventListener("pointermove", (event) => this.handlePointerMove(surface, event));
      surface.canvas.addEventListener("pointerup", (event) => this.handlePointerUp(surface, event));
      surface.canvas.addEventListener("pointercancel", (event) => this.handlePointerUp(surface, event));
    }

    // 竖条自动隐显：靠近右缘出现，移开后延迟隐藏（与原菜单的 hover 行为一致）
    elements.imageDisplayArea.addEventListener("pointermove", (event) => this.handleStripReveal(event));
    elements.imageDisplayArea.addEventListener("pointermove", (event) => this.updateBrushCursor(event));
    elements.imageDisplayArea.addEventListener("pointerleave", () => {
      this.scheduleStripHide();
      this.hideBrushCursor();
    });
    this.strip.addEventListener("pointerenter", () => this.showStrip());
    this.strip.addEventListener("pointerleave", () => this.scheduleStripHide());

    this.stripToggle.addEventListener("click", () => this.setStripCollapsed(!this.stripCollapsed));

    this.layerSurfaceReference.addEventListener("click", () => this.setActiveSurface(this.referenceSurface));
    this.layerSurfacePractice.addEventListener("click", () => this.setActiveSurface(this.practiceSurface));

    document.addEventListener("pointerdown", (event) => this.handleOutsidePointerDown(event));
    window.addEventListener("resize", () => this.scheduleRedraw());

    // 右键拖动用于临时橡皮，屏蔽画布上的右键菜单
    for (const surface of this.surfaces) {
      surface.canvas?.addEventListener("contextmenu", (event) => event.preventDefault());
    }

    listen("pen-state", (event) => {
      const payload = event.payload || {};
      const pressure = Number(payload.pressure);
      if (Number.isFinite(pressure)) {
        this.pressureSamples.push({ at: Date.now(), pressure });
        if (this.pressureSamples.length > 64) {
          this.pressureSamples.splice(0, this.pressureSamples.length - 64);
        }
      }
      // Wacom"橡皮擦"动作会让系统把笔报告为 Eraser 设备，Rust 桥原样转发。
      // 只影响实际擦除与光标形态，竖条按钮高亮保持用户选中的工具不变
      const eraserHeld = payload.eraser === true;
      if (eraserHeld !== this.penEraserHeld) {
        this.penEraserHeld = eraserHeld;
        this.syncBucketCursorClass();
      }
    }).catch((error) => {
      console.warn("Pen state bridge unavailable:", error);
    });

    this.syncColorEditors();
  }

  /** 撤销/重做/工具切换等画笔快捷键；返回 true 表示事件已消费 */
  handleGlobalKeyDown(event) {
    if (!this.host.isPlaybackVisible()) {
      return false;
    }
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) {
      return false;
    }

    const key = shortcutKey(event);

    if ((event.metaKey || event.ctrlKey) && key === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        this.activeSurface.redo();
      } else {
        this.activeSurface.undo();
      }
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && key === "y") {
      event.preventDefault();
      this.activeSurface.redo();
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return false;
    }
    // [ ] 支持按住连发实现连续调粗细，其余单键忽略自动重复
    const isSizeKey = key === "[" || key === "]";
    if (event.repeat && !isSizeKey) {
      return false;
    }

    switch (key) {
      case "b":
        this.setDrawModeEnabled(true);
        this.selectPenTool();
        return true;
      case "e":
        this.setDrawModeEnabled(true);
        this.selectEraserTool();
        return true;
      case "h":
        if (this.isDrawModeEnabled) {
          this.host.toggleMirrorEffect();
          return true;
        }
        return false;
      case "[":
        if (this.isDrawModeEnabled) {
          this.adjustSize(-1);
        }
        return this.isDrawModeEnabled;
      case "]":
        if (this.isDrawModeEnabled) {
          this.adjustSize(1);
        }
        return this.isDrawModeEnabled;
      case "escape":
        if (this.isDrawModeEnabled) {
          this.setDrawModeEnabled(false);
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** 会话开始 / 返回菜单时调用：还原透明度与工具状态 */
  resetSessionState() {
    this.setDrawModeEnabled(false);
    this.setCopyModeEnabled(false);
    this.stripCollapsed = false;
    this.stripToggle.textContent = "▴";
    this.stripToggle.setAttribute("data-tooltip", t("collapseMenu"));
    this.stripToggle.classList.remove("visible");
    this.setReferenceOpacity(100);
    for (const surface of this.surfaces) {
      surface.resetRuntime();
    }
  }

  /** 涂鸦模式会话开始时调用：参考图降到 35% 方便描形 */
  applyDoodleDefaults() {
    this.setReferenceOpacity(35);
    this.setDrawModeEnabled(true);
  }

  /** 图片切换加载完成后调用：载入参考面与临摹面的笔记 */
  reloadForCurrentImage() {
    // 换图后参考恢复可见：先看图再默写
    this.setReferenceHidden(false);
    for (const surface of this.surfaces) {
      surface.load();
    }
  }

  handleImageLoadError() {
    for (const surface of this.surfaces) {
      surface.invalidate();
    }
  }

  onMirrorChanged() {
    // 竖条镜像按钮与菜单/悬浮按钮共用同一个镜像状态
    this.toolButtons.mirror.classList.toggle("active", this.host.state.isMirrorEnabled);
    this.scheduleRedraw();
  }

  onResize() {
    this.scheduleRedraw();
  }

  /** 宿主网格开关/参数变化时同步临摹面网格 */
  onGridChanged() {
    this.scheduleRedraw();
  }

  // ---- 渲染总入口 ----

  scheduleRedraw() {
    if (this.redrawFrame !== null) {
      cancelAnimationFrame(this.redrawFrame);
    }

    this.redrawFrame = window.requestAnimationFrame(() => {
      this.redrawFrame = null;
      this.renderAll();
    });
  }

  /** 临摹画布是否当前可见（临摹模式，或普通画笔下切换到临摹画布） */
  isPracticeVisible() {
    return this.isCopyModeEnabled || this.referenceHidden;
  }

  renderAll() {
    // 注意顺序：临摹面布局（stage 尺寸）会改变 flex 里参考图的位置，
    // 必须先渲染临摹面、再渲染参考面，白幕垫/注释画布才能按最终位置对齐，
    // 否则参考图右缘会露出一条平均色背景（降不透明度时可见）
    if (this.isPracticeVisible()) {
      this.practiceSurface.render();
      this.renderPracticeGrid();
    }
    this.referenceSurface.render();
    this.syncHistoryButtons();
  }

  syncHistoryButtons() {
    this.toolButtons.undo.disabled = this.activeSurface.undoStack.length === 0;
  }

  // ---- 画面布局 ----

  imageNaturalResolution() {
    const image = elements.currentImage;
    if (!image.naturalWidth || !image.naturalHeight) {
      return null;
    }
    // 分辨率跟随原图（封顶 2560），保证窗口缩放时笔迹清晰且内存可控
    const width = Math.min(image.naturalWidth, ANNOTATION_OFFSCREEN_MAX_WIDTH);
    const height = Math.max(1, Math.round(width * (image.naturalHeight / image.naturalWidth)));
    return { width, height };
  }

  layoutReferenceCanvas() {
    if (elements.imageDisplayArea.classList.contains("hidden")) {
      return null;
    }
    const rect = elements.currentImage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const containerRect = elements.imageDisplayArea.getBoundingClientRect();
    const left = rect.left - containerRect.left;
    const top = rect.top - containerRect.top;
    const dpr = window.devicePixelRatio || 1;

    if (this.backdrop) {
      this.backdrop.style.left = `${left}px`;
      this.backdrop.style.top = `${top}px`;
      this.backdrop.style.width = `${rect.width}px`;
      this.backdrop.style.height = `${rect.height}px`;
    }

    return { left, top, width: rect.width, height: rect.height, dpr };
  }

  layoutPracticeCanvas() {
    if (!this.isPracticeVisible() || elements.imageDisplayArea.classList.contains("hidden")) {
      return null;
    }
    if (!this.practiceStage) {
      return null;
    }
    // 隐藏参考（默写）时按原图宽高比在展示区内完整铺开，其余情况与参考图完全一致
    if (this.referenceHidden) {
      const natural = this.imageNaturalResolution();
      if (!natural) {
        return null;
      }
      const containerRect = elements.imageDisplayArea.getBoundingClientRect();
      const scale = Math.min(containerRect.width / natural.width, containerRect.height / natural.height);
      if (!(scale > 0)) {
        return null;
      }
      this.practiceStage.style.width = `${natural.width * scale}px`;
      this.practiceStage.style.height = `${natural.height * scale}px`;
    } else {
      const rect = elements.currentImage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      // 临摹画布尺寸与参考图完全一致
      this.practiceStage.style.width = `${rect.width}px`;
      this.practiceStage.style.height = `${rect.height}px`;
    }
    const stageRect = this.practiceStage.getBoundingClientRect();
    if (stageRect.width <= 0 || stageRect.height <= 0) {
      return null;
    }
    const dpr = window.devicePixelRatio || 1;
    return { left: 0, top: 0, width: stageRect.width, height: stageRect.height, dpr };
  }

  renderPracticeGrid() {
    if (!this.practiceGridCanvas || !this.practiceStage) {
      return;
    }
    const rect = this.practiceStage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    // CSS 显示尺寸与内部像素尺寸都要设置，否则画布按原始像素渲染会错位
    if (this.practiceGridCanvas.style.width !== `${rect.width}px`) {
      this.practiceGridCanvas.style.width = `${rect.width}px`;
    }
    if (this.practiceGridCanvas.style.height !== `${rect.height}px`) {
      this.practiceGridCanvas.style.height = `${rect.height}px`;
    }
    if (this.practiceGridCanvas.width !== Math.round(rect.width * dpr)) {
      this.practiceGridCanvas.width = Math.round(rect.width * dpr);
    }
    if (this.practiceGridCanvas.height !== Math.round(rect.height * dpr)) {
      this.practiceGridCanvas.height = Math.round(rect.height * dpr);
    }
    const ctx = this.practiceGridCanvas.getContext("2d");
    if (!this.host.state.isGridEnabled) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      return;
    }
    this.host.paintGridLines(ctx, rect.width, rect.height, dpr);
  }

  // ---- 画笔模式开关与菜单显隐 ----

  setDrawModeEnabled(enabled) {
    if (this.isDrawModeEnabled === enabled) {
      return;
    }
    this.isDrawModeEnabled = enabled;
    elements.imageDisplayArea.classList.toggle("draw-mode", enabled);
    this.canvas.classList.toggle("active", enabled);
    byId("practice-canvas").classList.toggle("active", enabled);
    this.drawModeToggle.classList.toggle("active", enabled);
    this.closePopouts();
    // 画笔模式退出时恢复参考可见，下次进入从参考开始
    if (!enabled) {
      this.setReferenceHidden(false);
      this.activeStroke = null;
      this.isStrokeActive = false;
      this.hideBrushCursor();
      this.strip.classList.remove("visible");
      this.stripToggle.classList.remove("visible");
      clearTimeout(this.stripHideTimer);
      this.stripHideTimer = null;
    } else {
      // 镜像可能在菜单里已开启，进入画笔时同步竖条按钮高亮
      this.toolButtons.mirror.classList.toggle("active", this.host.state.isMirrorEnabled);
      this.scheduleRedraw();
      this.showStrip();
      this.scheduleStripHide(2000);
    }
  }

  /** 图层面板里切换编辑参考面 / 临摹面 */
  setActiveSurface(surface) {
    if (this.activeSurface === surface) {
      return;
    }
    this.activeSurface = surface;
    this.syncHistoryButtons();
    this.renderLayerPanel();
  }

  setCopyModeEnabled(enabled) {
    if (this.isCopyModeEnabled === enabled) {
      return;
    }
    this.isCopyModeEnabled = enabled;
    elements.imageDisplayArea.classList.toggle("copy-mode", enabled);
    this.toolButtons.copy.classList.toggle("active", enabled);
    // 参考图移位/缩放后，宿主网格画布的位置必须跟随重算
    this.host.scheduleGridRedraw();
    // 退出临摹模式：编辑焦点回到参考面，面板中的临摹图层随之隐藏，参考恢复可见
    if (!enabled) {
      this.setReferenceHidden(false);
      if (this.activeSurface === this.practiceSurface) {
        this.setActiveSurface(this.referenceSurface);
      }
    }
    this.scheduleRedraw();
  }

  /** 默写/切换画布：临摹模式下隐藏参考做默写；普通画笔模式下与参考画布互斥切换 */
  setReferenceHidden(hidden) {
    if (this.referenceHidden === hidden) {
      return;
    }
    if (hidden && !this.isDrawModeEnabled) {
      return;
    }
    this.referenceHidden = hidden;
    elements.imageDisplayArea.classList.toggle("reference-hidden", hidden);
    this.syncHideReferenceButton();
    // 编辑焦点跟随可见面：隐藏参考 → 临摹面；普通画笔恢复参考 → 参考面
    if (hidden && this.activeSurface === this.referenceSurface) {
      this.setActiveSurface(this.practiceSurface);
    }
    if (!hidden && !this.isCopyModeEnabled && this.activeSurface === this.practiceSurface) {
      this.setActiveSurface(this.referenceSurface);
    }
    this.host.scheduleGridRedraw();
    this.renderLayerPanel();
    this.scheduleRedraw();
  }

  /** 竖条「隐藏参考」按钮：图标与提示随状态切换 */
  syncHideReferenceButton() {
    const button = this.toolButtons.hideReference;
    if (!button) {
      return;
    }
    button.classList.toggle("active", this.referenceHidden);
    const label = t(this.referenceHidden ? "showReference" : "hideReference");
    button.title = label;
    button.setAttribute("data-tooltip", label);
  }

  handleStripReveal(event) {
    if (!this.isDrawModeEnabled || this.isStrokeActive) {
      return;
    }
    if (event.clientX >= window.innerWidth - STRIP_REVEAL_EDGE_PX) {
      // 靠近右缘：展开态弹出整个菜单，收起态只弹出控制按钮
      this.showStrip();
      return;
    }
    if (!this.strip.matches(":hover") && !this.openPopoutName) {
      this.scheduleStripHide();
    }
  }

  /** 收起/展开竖条：收起后完全隐藏，靠右缘仅弹出控制按钮 */
  setStripCollapsed(collapsed) {
    if (this.stripCollapsed === collapsed) {
      return;
    }
    this.stripCollapsed = collapsed;
    this.stripToggle.textContent = collapsed ? "▾" : "▴";
    this.stripToggle.setAttribute("data-tooltip", t(collapsed ? "expandMenu" : "collapseMenu"));
    this.closePopouts();
    if (collapsed) {
      this.strip.classList.remove("visible");
      clearTimeout(this.stripHideTimer);
      this.stripHideTimer = null;
    } else {
      this.showStrip();
      this.scheduleStripHide(1200);
    }
  }

  showStrip() {
    if (this.stripHideTimer !== null) {
      clearTimeout(this.stripHideTimer);
      this.stripHideTimer = null;
    }
    this.stripToggle.classList.add("visible");
    if (!this.stripCollapsed) {
      this.strip.classList.add("visible");
    }
  }

  scheduleStripHide(delay = STRIP_HIDE_DELAY_MS) {
    if (!this.isDrawModeEnabled || this.openPopoutName) {
      return;
    }
    if (this.stripHideTimer !== null) {
      clearTimeout(this.stripHideTimer);
    }
    this.stripHideTimer = window.setTimeout(() => {
      this.stripHideTimer = null;
      this.strip.classList.remove("visible");
      this.stripToggle.classList.remove("visible");
    }, delay);
  }

  // ---- 子面板 ----

  togglePopout(name) {
    const next = this.openPopoutName === name ? "" : name;
    this.closePopouts();
    if (next) {
      this.openPopoutName = next;
      this.popoutHosts.get(next).classList.add("open");
      if (next === "size") {
        this.applySize(this.tool.size);
      }
      if (next === "layer") {
        this.renderLayerPanel();
      }
      this.showStrip();
    }
  }

  closePopouts() {
    this.openPopoutName = "";
    for (const slot of this.popoutHosts.values()) {
      slot.classList.remove("open");
    }
  }

  handleOutsidePointerDown(event) {
    if (!this.openPopoutName || !(event.target instanceof Node)) {
      return;
    }
    const slot = this.popoutHosts.get(this.openPopoutName);
    if (slot && !slot.contains(event.target)) {
      this.closePopouts();
    }
  }

  /** 竖条按钮高亮只反映选中的工具（按住笔键的临时橡皮不改变高亮） */
  syncToolButtonsVisual() {
    if (!this.toolButtons.pen) {
      return;
    }
    const eraseActive = this.tool.eraser;
    const bucketActive = this.tool.bucket;
    const penActive = !bucketActive && !eraseActive;
    this.toolButtons.pen.classList.toggle("active", penActive);
    this.toolButtons.eraser.classList.toggle("active", eraseActive);
    this.toolButtons.bucket.classList.toggle("active", bucketActive);
  }

  /** 画笔/橡皮用圆环光标（cursor:none），油漆桶用自定义图标光标 */
  syncBucketCursorClass() {
    const isBucket = this.tool.bucket && this.penEraserHeld !== true;
    this.canvas.classList.toggle("tool-bucket", isBucket);
    byId("practice-canvas")?.classList.toggle("tool-bucket", isBucket);
  }

  selectPenTool({ keepPopout = false } = {}) {
    this.tool.bucket = false;
    this.tool.eraser = false;
    this.syncBucketCursorClass();
    this.syncToolButtonsVisual();
    if (!keepPopout) {
      this.closePopouts();
    }
  }

  selectEraserTool() {
    this.tool.bucket = false;
    this.tool.eraser = true;
    this.syncBucketCursorClass();
    this.syncToolButtonsVisual();
    this.closePopouts();
  }

  selectBucketTool() {
    this.tool.bucket = true;
    this.tool.eraser = false;
    this.syncBucketCursorClass();
    this.syncToolButtonsVisual();
    this.closePopouts();
  }

  // ---- 颜色（HSL 选色器） ----

  syncColorEditors() {
    const { h, s, l } = hexToHsl(this.tool.color);
    this.colorHueSlider.value = `${h}`;
    this.colorSatSlider.value = `${s}`;
    this.colorLightSlider.value = `${l}`;
    this.colorPreview.style.background = this.tool.color;
    this.colorHex.textContent = this.tool.color.toUpperCase();
    this.colorSatSlider.style.background = `linear-gradient(to right, hsl(${h}, 0%, ${l}%), hsl(${h}, 100%, ${l}%))`;
    this.colorLightSlider.style.background = "linear-gradient(to right, #000000, #808080, #ffffff)";
  }

  applyHslFromSliders() {
    this.tool.color = hslToHex(
      Number(this.colorHueSlider.value),
      Number(this.colorSatSlider.value),
      Number(this.colorLightSlider.value),
    );
    this.colorIndicator.style.background = this.tool.color;
    this.syncColorEditors();
    this.colorPopout.querySelectorAll(".annotation-color-swatch").forEach((item) => {
      item.classList.toggle("active", (item.dataset.color || "").toUpperCase() === this.tool.color);
    });
  }

  // ---- 笔刷大小 ----

  updateSizeIndicator() {
    const dotSize = Math.max(3, Math.min(20, Math.round(this.tool.size)));
    this.sizeIndicatorDot.style.width = `${dotSize}px`;
    this.sizeIndicatorDot.style.height = `${dotSize}px`;
    if (this.brushCursor) {
      const ringSize = Math.max(2, Math.round(this.tool.size));
      this.brushCursor.style.width = `${ringSize}px`;
      this.brushCursor.style.height = `${ringSize}px`;
    }
  }

  updateBrushCursor(event) {
    if (!this.brushCursor) {
      return;
    }
    if (!this.isDrawModeEnabled) {
      this.hideBrushCursor();
      return;
    }
    if (this.tool.bucket && this.penEraserHeld !== true) {
      // 油漆桶使用自定义图标光标，无需圆环
      this.hideBrushCursor();
      return;
    }
    if (event.target instanceof Element && event.target.closest("#drawing-controls")) {
      this.hideBrushCursor();
      return;
    }
    const ringSize = Math.max(2, Math.round(this.tool.size));
    this.brushCursor.style.width = `${ringSize}px`;
    this.brushCursor.style.height = `${ringSize}px`;
    this.brushCursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px) translate(-50%, -50%)`;
    this.brushCursor.classList.add("visible");
  }

  hideBrushCursor() {
    if (this.brushCursor) {
      this.brushCursor.classList.remove("visible");
    }
  }

  applySize(value) {
    const size = Math.min(ANNOTATION_SIZE_MAX, Math.max(ANNOTATION_SIZE_MIN, Math.round(Number(value) || 4)));
    this.tool.size = size;
    this.updateSizeIndicator();
    if (this.sizeSlider.value !== `${size}`) {
      this.sizeSlider.value = `${size}`;
    }
    this.sizeValue.textContent = `${size}`;
  }

  adjustSize(step) {
    // 快捷键调节灵敏度随笔刷大小提高：小笔刷每次 ±1 细调，大笔刷最高 ±5 粗调
    const magnitude = Math.max(1, Math.round((Math.abs(step) * this.tool.size) / 6));
    this.applySize(this.tool.size + Math.sign(step) * magnitude);
    // 键盘调节时短暂亮出竖条，让指示圆点的变化可见
    if (this.isDrawModeEnabled) {
      this.showStrip();
      this.scheduleStripHide(1200);
    }
  }

  /** 参考图（参考面的最底层）不透明度 */
  setReferenceOpacity(value) {
    const percent = Math.min(100, Math.max(10, Number(value) || 100));
    this.previewImageOpacity = percent / 100;
    elements.currentImage.style.opacity = `${this.previewImageOpacity}`;
  }

  // ---- 图层面板 ----

  renderLayerPanel() {
    if (!this.layerList) {
      return;
    }
    // 仅临摹模式下显示参考/临摹切换行；隐藏参考（默写）时只看临摹图层
    const copyMode = this.isCopyModeEnabled;
    if (this.layerSurfaceToggle) {
      this.layerSurfaceToggle.style.display = copyMode && !this.referenceHidden ? "flex" : "none";
    }
    const surface = copyMode || this.referenceHidden ? this.activeSurface : this.referenceSurface;
    const isReference = surface === this.referenceSurface;
    this.layerSurfaceReference.classList.toggle("active", isReference);
    this.layerSurfacePractice.classList.toggle("active", !isReference);
    const rows = [];
    for (let i = surface.layers.length - 1; i >= 0; i -= 1) {
      const layer = surface.layers[i];
      const active = layer.id === surface.activeLayerId;
      rows.push(`
        <div class="layer-row${active ? " active" : ""}" data-layer-id="${layer.id}">
            <span class="layer-name">${escapeHtml(layer.name)}</span>
            <input type="range" class="layer-opacity" min="0" max="100" value="${Math.round(layer.opacity * 100)}" data-layer-id="${layer.id}">
        </div>`);
    }
    if (surface === this.referenceSurface) {
      rows.push(`
        <div class="layer-row locked">
            <span class="layer-name">${escapeHtml(t("referenceLayer"))}</span>
            <input type="range" class="layer-opacity" min="10" max="100" value="${Math.round(this.previewImageOpacity * 100)}" data-kind="reference">
        </div>`);
    } else {
      rows.push(`
        <div class="layer-row locked">
            <span class="layer-name">${escapeHtml(t("whiteLayer"))}</span>
            <span class="layer-locked-hint">—</span>
        </div>`);
    }
    this.layerList.innerHTML = rows.join("");

    const layerIds = surface.layers.map((layer) => layer.id);
    this.layerDeleteButton.disabled = surface.layers.length <= 1;
    this.layerUpButton.disabled = surface.activeLayerId === layerIds[layerIds.length - 1];
    this.layerDownButton.disabled = surface.activeLayerId === layerIds[0];
  }

  // ---- 笔画绘制（两个画面共用） ----

  currentImagePath() {
    const file = this.host.state.imageFiles[this.host.state.currentImageIndex];
    if (!file) {
      return "";
    }
    return file.originalPath || file.path || "";
  }

  pointFromEvent(event, surface) {
    const rect = surface.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    let nx = (event.clientX - rect.left) / rect.width;
    let ny = (event.clientY - rect.top) / rect.height;
    nx = Math.min(1, Math.max(0, nx));
    ny = Math.min(1, Math.max(0, ny));
    if (this.host.state.isMirrorEnabled && surface === this.referenceSurface) {
      nx = 1 - nx;
    }
    return [nx, ny];
  }

  /**
   * 数位笔橡皮擦判定：
   * - Pointer Events buttons 掩码第 32 位（WebView 原生透传时，如 Windows Ink）
   * - Rust 桥转发的 Eraser 设备标志（macOS Wacom"橡皮擦"动作）
   */
  isEraseButtonHeld(event) {
    if ((Number(event.buttons ?? 0) & 32) !== 0) {
      return true;
    }
    return this.penEraserHeld === true;
  }

  currentEraserWidthNorm(surface) {
    const rect = surface.canvas.getBoundingClientRect();
    if (rect.width <= 0) {
      return 0.02;
    }
    // 与光标圆环 1:1：橡皮涂抹直径 = 笔刷大小
    return this.tool.size / rect.width;
  }

  /**
   * 解析当前笔点压感：
   * - 数位板笔（pointerType === "pen"）且事件自带 pressure（Windows/WebView2 原生）优先
   * - 否则用 Rust 桥推送的最新样本（macOS NSEvent TabletPoint，事件队列顺序对应当前笔点）
   * - 无压感数据（普通鼠标）返回 1，线宽恒定
   */
  pressureFromEvent(event) {
    const native = Number(event.pressure ?? 0);
    if (event.pointerType === "pen" && native > 0) {
      return native;
    }

    if (this.pressureSamples.length > 0) {
      const now = Date.now();
      for (let i = this.pressureSamples.length - 1; i >= 0; i -= 1) {
        const sample = this.pressureSamples[i];
        if (sample.at <= now + 12) {
          return sample.pressure;
        }
      }
      return this.pressureSamples[this.pressureSamples.length - 1].pressure;
    }
    return 1;
  }

  drawLiveSegment(surface, layer, from, to, stroke, isErase) {
    const resolution = surface.resolutionFn();
    if (!resolution || !from || !to) {
      return;
    }
    const bitmap = surface.layerBitmap(layer, resolution);
    const ctx = bitmap.getContext("2d");
    const scaleX = bitmap.width;
    const scaleY = bitmap.height;
    const pressureMid = ((from[2] ?? 1) + (to[2] ?? 1)) / 2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (isErase) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "#000000";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = stroke.color || "#FF4D4F";
    }
    ctx.lineWidth = Math.max(1, stroke.width * pressureMid * scaleX);
    ctx.beginPath();
    ctx.moveTo(from[0] * scaleX, from[1] * scaleY);
    ctx.lineTo(to[0] * scaleX, to[1] * scaleY);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    surface.replay();
    surface.blit();
  }

  drawLiveDot(surface, layer, point, stroke, isErase) {
    const resolution = surface.resolutionFn();
    if (!resolution || !point) {
      return;
    }
    const bitmap = surface.layerBitmap(layer, resolution);
    const ctx = bitmap.getContext("2d");
    const scaleX = bitmap.width;
    const scaleY = bitmap.height;
    const radius = Math.max(1, stroke.width * (point[2] ?? 1) * scaleX) / 2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (isErase) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "#000000";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = stroke.color || "#FF4D4F";
    }
    ctx.beginPath();
    ctx.arc(point[0] * scaleX, point[1] * scaleY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    surface.replay();
    surface.blit();
  }

  handlePointerDown(surface, event) {
    // 左键 = 当前工具；中键/右键 = 临时橡皮
    if (!this.isDrawModeEnabled || ![0, 1, 2].includes(event.button)) {
      return;
    }
    const point = this.pointFromEvent(event, surface);
    if (!point) {
      return;
    }

    event.preventDefault();
    this.closePopouts();

    // 右键 / 中键按下 = 临时橡皮（兼容 Wacom 等驱动把侧键映射为鼠标中/右键的方案）
    const eraseByPointerButton = event.button === 1 || event.button === 2;
    // 数位笔橡皮键（含 Wacom 橡皮擦动作桥接）= 临时橡皮，优先于任何工具（含油漆桶）
    const eraseByPenButton = this.isEraseButtonHeld(event);

    if (this.tool.bucket && !eraseByPointerButton && !eraseByPenButton) {
      const layer = surface.activeLayer();
      if (!layer) {
        return;
      }
      const action = { type: "fill", point: [point[0], point[1]], color: this.tool.color };
      const resolution = surface.resolutionFn();
      const bitmap = surface.layerBitmap(layer, resolution);
      applyAction(bitmap.getContext("2d"), action, bitmap.width, bitmap.height);
      surface.recordAction(action, layer);
      this.renderAll();
      surface.scheduleSave();
      return;
    }

    try {
      surface.canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      console.warn("Failed to capture pointer for annotation:", error);
    }

    const rect = surface.canvas.getBoundingClientRect();
    const layer = surface.activeLayer();
    if (!layer) {
      return;
    }
    // 橡皮模式 = 选中橡皮工具、按住数位笔的橡皮键（buttons 第 32 位）、或右键/中键拖动
    const isErase = this.tool.eraser || eraseByPointerButton || eraseByPenButton;
    const pressure = isErase ? 1 : this.pressureFromEvent(event);
    this.pressureSmoothed = pressure;
    this.isStrokeActive = true;
    this.activeSurface = surface;
    this.syncHistoryButtons();
    if (this.openPopoutName === "layer") {
      this.renderLayerPanel();
    }
    this.activeStroke = {
      layer,
      // 分段记录：一笔中途切换画/擦（如笔上橡皮键）时拆为多段，回放与撤销都正确
      segments: [{ erase: isErase, points: [[point[0], point[1], pressure]] }],
      color: this.tool.color,
      width: this.tool.size / rect.width,
    };
    const firstSegment = this.activeStroke.segments[0];
    this.lastPoint = firstSegment.points[0];
    this.drawLiveDot(surface, layer, firstSegment.points[0], this.activeStroke, isErase);
  }

  handlePointerMove(surface, event) {
    if (!this.isStrokeActive || surface !== this.activeSurface) {
      return;
    }
    const point = this.pointFromEvent(event, surface);
    if (!point) {
      return;
    }

    const stroke = this.activeStroke;
    if (!stroke) {
      return;
    }

    // 橡皮模式：橡皮工具、按住数位笔的橡皮键、或右键/中键拖动（可在一笔中途切换）
    const eraseMode = this.tool.eraser
      || this.isEraseButtonHeld(event)
      || (Number(event.buttons ?? 0) & (2 | 4)) !== 0;
    let segment = stroke.segments[stroke.segments.length - 1];
    if (segment.erase !== eraseMode) {
      segment = { erase: eraseMode, points: [this.lastPoint] };
      stroke.segments.push(segment);
    }

    const rawPressure = segment.erase ? 1 : this.pressureFromEvent(event);
    // 压感指数平滑，抑制回报抖动
    this.pressureSmoothed = this.pressureSmoothed * 0.6 + rawPressure * 0.4;
    segment.points.push([point[0], point[1], this.pressureSmoothed]);
    this.drawLiveSegment(surface, stroke.layer, this.lastPoint, segment.points[segment.points.length - 1], stroke, segment.erase);
    this.lastPoint = segment.points[segment.points.length - 1];
  }

  handlePointerUp(surface, event) {
    if (!this.isStrokeActive || surface !== this.activeSurface) {
      return;
    }

    try {
      if (surface.canvas.hasPointerCapture(event.pointerId)) {
        surface.canvas.releasePointerCapture(event.pointerId);
      }
    } catch (error) {
      console.warn("Failed to release pointer capture:", error);
    }

    const stroke = this.activeStroke;
    this.isStrokeActive = false;
    this.activeStroke = null;
    this.lastPoint = null;
    if (!stroke) {
      return;
    }

    // 每段一个动作（画/擦分开记录，回放顺序与真实绘制一致）
    for (const segment of stroke.segments) {
      if (segment.points.length === 0) {
        continue;
      }
      surface.recordAction({
        type: segment.erase ? "erase" : "draw",
        stroke: {
          points: segment.points,
          color: stroke.color,
          width: stroke.width,
        },
      }, stroke.layer);
    }
    this.renderAll();
    surface.scheduleSave();
  }
}
