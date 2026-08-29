import { desktop } from "./api/desktop.js";
import { elements } from "./dom.js";
import { listen } from "@tauri-apps/api/event";
import { t } from "./i18n.js";

const ANNOTATION_OFFSCREEN_MAX_WIDTH = 2560;
const ANNOTATION_SIZE_MIN = 1;
const ANNOTATION_SIZE_MAX = 30;
const STRIP_HIDE_DELAY_MS = 500;
const STRIP_REVEAL_EDGE_PX = 90;

const byId = (id) => document.getElementById(id);

/**
 * 笔画动作数据格式（v2，按图片路径持久化于 SQLite）：
 *   { version: 2, actions: [
 *       { type: "draw"|"erase", stroke: { points: [[x, y, pressure?], ...], color, width } }
 *   ] }
 * 点坐标为 0..1 归一化值，pressure 可省略（旧数据，按恒定线宽渲染）。
 */
function normalizeAnnotationActions(payload) {
  let actions = [];
  if (Array.isArray(payload)) {
    // v1 旧格式：纯笔画数组，迁移为 draw 动作
    actions = payload.map((stroke) => ({ type: "draw", stroke }));
  } else if (Array.isArray(payload?.actions)) {
    actions = payload.actions;
  } else if (Array.isArray(payload?.strokes)) {
    actions = payload.strokes.map((stroke) => ({ type: "draw", stroke }));
  }

  return actions.filter((action) => {
    if (!action || (action.type !== "draw" && action.type !== "erase")) {
      return false;
    }
    const stroke = action.stroke;
    return stroke && Array.isArray(stroke.points) && stroke.points.length > 0;
  });
}

function applyAction(ctx, action, scaleX, scaleY) {
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
 * 一个可作画的注释画面：离屏缓冲 + 动作回放渲染 + 独立的撤销/重做与持久化。
 * 临摹模式下存在两个实例：参考图注释面（reference）与白色临摹画布面（practice）。
 * layout/mirror/resolution/saveKey 由控制器注入。
 */
class AnnotationSurface {
  constructor({ canvas, layout, mirror, resolution, saveKey, onChanged }) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext("2d") : null;
    this.layoutFn = layout;
    this.mirrorFn = mirror;
    this.resolutionFn = resolution;
    this.saveKeyFn = saveKey;
    this.onChanged = onChanged;
    this.actions = [];
    this.undoStack = [];
    this.redoStack = [];
    this.offscreen = null;
    this.loadToken = 0;
    this.saveTimer = null;
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

  replay() {
    const offscreen = this.ensureOffscreen();
    if (!offscreen) {
      return;
    }
    const ctx = offscreen.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, offscreen.width, offscreen.height);
    for (const action of this.actions) {
      applyAction(ctx, action, offscreen.width, offscreen.height);
    }
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
    this.actions = [];
    this.undoStack = [];
    this.redoStack = [];
    this.offscreen = null;
    this.clearVisible();
  }

  invalidate() {
    this.loadToken += 1;
    this.resetRuntime();
  }

  scheduleSave() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }

    const saveKey = this.saveKeyFn();
    const actionsSnapshot = this.actions;
    if (!saveKey) {
      return;
    }

    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      desktop.saveImageAnnotations(saveKey, { version: 2, actions: actionsSnapshot }).catch((error) => {
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
      this.actions = normalizeAnnotationActions(payload);
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

  recordAction(action) {
    this.actions.push(action);
    this.pushHistory({
      undo: () => {
        const index = this.actions.indexOf(action);
        if (index >= 0) {
          this.actions.splice(index, 1);
        }
      },
      redo: () => {
        if (!this.actions.includes(action)) {
          this.actions.push(action);
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

  clearAll() {
    if (this.actions.length === 0) {
      return;
    }
    const previousActions = this.actions;
    this.actions = [];
    this.pushHistory({
      undo: () => {
        this.actions = previousActions;
      },
      redo: () => {
        this.actions = [];
      },
    });
    this.onChanged();
    this.scheduleSave();
  }
}

/**
 * 画笔模式控制器：参考图上的笔记画板（画笔 / 像素橡皮 / 撤销重做 / 持久化）、
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
      color: byId("drawColorTool"),
      size: byId("drawSizeTool"),
      undo: byId("drawUndoTool"),
      clear: byId("drawClearTool"),
      opacity: byId("drawOpacityTool"),
      copy: byId("drawCopyTool"),
      exit: byId("drawExitTool"),
    };
    this.colorIndicator = byId("drawColorIndicator");
    this.colorPopout = byId("drawColorPopout");
    this.sizeIndicatorDot = byId("drawSizeIndicatorDot");
    this.sizePopout = byId("drawSizePopout");
    this.sizeSlider = byId("drawSizeSlider");
    this.sizeValue = byId("drawSizeValue");
    this.opacityPopout = byId("drawOpacityPopout");
    this.opacitySlider = byId("drawOpacitySlider");
    this.opacityValue = byId("drawOpacityValue");
    this.popoutHosts = new Map([
      ["color", byId("drawColorSlot")],
      ["size", byId("drawSizeSlot")],
      ["opacity", byId("drawOpacitySlot")],
    ]);

    this.tool = {
      color: "#FF4D4F",
      size: 4,
      eraser: false,
    };
    this.isDrawModeEnabled = false;
    this.isCopyModeEnabled = false;
    this.previewImageOpacity = 1;

    // 数位板笔压：Rust 桥（macOS）推送的样本流；Windows 走 PointerEvent 原生 pressure
    this.pressureSamples = [];
    this.pressureSmoothed = 1;

    this.referenceSurface = new AnnotationSurface({
      canvas: byId("annotation-canvas"),
      layout: () => this.layoutReferenceCanvas(),
      mirror: () => this.host.state.isMirrorEnabled,
      resolution: () => this.imageNaturalResolution(),
      saveKey: () => this.currentImagePath(),
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
      onChanged: () => this.renderAll(),
    });
    this.surfaces = [this.referenceSurface, this.practiceSurface];
    this.activeSurface = this.referenceSurface;

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
    this.toolButtons.pen.addEventListener("click", () => this.selectPenTool());
    this.toolButtons.eraser.addEventListener("click", () => this.selectEraserTool());
    this.toolButtons.undo.addEventListener("click", () => this.activeSurface.undo());
    this.toolButtons.clear.addEventListener("click", () => this.activeSurface.clearAll());
    this.toolButtons.color.addEventListener("click", () => this.togglePopout("color"));
    this.toolButtons.size.addEventListener("click", () => this.togglePopout("size"));
    this.toolButtons.opacity.addEventListener("click", () => this.togglePopout("opacity"));

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
      this.selectPenTool({ keepPopout: true });
      this.closePopouts();
    });

    this.sizeSlider.addEventListener("input", (event) => this.applySize(event.target.value));

    this.opacitySlider.addEventListener("input", (event) => this.applyOpacity(event.target.value));

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

    document.addEventListener("pointerdown", (event) => this.handleOutsidePointerDown(event));
    window.addEventListener("resize", () => this.scheduleRedraw());

    listen("pen-pressure", (event) => {
      const pressure = Number(event.payload);
      if (!Number.isFinite(pressure)) {
        return;
      }
      this.pressureSamples.push({ at: Date.now(), pressure });
      if (this.pressureSamples.length > 64) {
        this.pressureSamples.splice(0, this.pressureSamples.length - 64);
      }
    }).catch((error) => {
      console.warn("Pen pressure bridge unavailable:", error);
    });
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

    const key = typeof event.key === "string" ? event.key.toLowerCase() : "";

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
    const isSizeKey = event.key === "[" || event.key === "]";
    if (event.repeat && !isSizeKey) {
      return false;
    }

    switch (event.key) {
      case "b":
      case "B":
        this.setDrawModeEnabled(true);
        this.selectPenTool();
        return true;
      case "e":
      case "E":
        this.setDrawModeEnabled(true);
        this.selectEraserTool();
        return true;
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
      case "Escape":
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
    this.previewImageOpacity = 1;
    elements.currentImage.style.opacity = "";
    this.opacitySlider.value = "100";
    this.opacityValue.textContent = "100%";
    for (const surface of this.surfaces) {
      surface.resetRuntime();
    }
  }

  /** 涂鸦模式会话开始时调用 */
  applyDoodleDefaults() {
    this.applyOpacity(35);
    this.setDrawModeEnabled(true);
  }

  /** 图片切换加载完成后调用：载入参考面与临摹面的笔记 */
  reloadForCurrentImage() {
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

  renderAll() {
    this.referenceSurface.render();
    if (this.isCopyModeEnabled) {
      this.practiceSurface.render();
      this.renderPracticeGrid();
    }
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
    if (!this.isCopyModeEnabled || elements.imageDisplayArea.classList.contains("hidden")) {
      return null;
    }
    const rect = elements.currentImage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || !this.practiceStage) {
      return null;
    }
    // 临摹画布尺寸与参考图完全一致
    this.practiceStage.style.width = `${rect.width}px`;
    this.practiceStage.style.height = `${rect.height}px`;
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
    if (!enabled) {
      this.activeStroke = null;
      this.isStrokeActive = false;
      this.hideBrushCursor();
      this.strip.classList.remove("visible");
      this.stripToggle.classList.remove("visible");
      clearTimeout(this.stripHideTimer);
      this.stripHideTimer = null;
    } else {
      this.scheduleRedraw();
      this.showStrip();
      this.scheduleStripHide(2000);
    }
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
    this.scheduleRedraw();
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

  selectPenTool({ keepPopout = false } = {}) {
    this.tool.eraser = false;
    this.toolButtons.pen.classList.add("active");
    this.toolButtons.eraser.classList.remove("active");
    if (!keepPopout) {
      this.closePopouts();
    }
  }

  selectEraserTool() {
    this.tool.eraser = true;
    this.toolButtons.eraser.classList.add("active");
    this.toolButtons.pen.classList.remove("active");
    this.closePopouts();
  }

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
    if (event.target instanceof Element && event.target.closest("#drawing-controls")) {
      this.hideBrushCursor();
      return;
    }
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
    this.applySize(this.tool.size + step);
    // 键盘调节时短暂亮出竖条，让指示圆点的变化可见
    if (this.isDrawModeEnabled) {
      this.showStrip();
      this.scheduleStripHide(1200);
    }
  }

  applyOpacity(value) {
    const percent = Math.min(100, Math.max(10, Number(value) || 100));
    this.previewImageOpacity = percent / 100;
    elements.currentImage.style.opacity = `${this.previewImageOpacity}`;
    this.opacitySlider.value = `${percent}`;
    this.opacityValue.textContent = `${percent}%`;
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

  currentEraserWidthNorm(surface) {
    const rect = surface.canvas.getBoundingClientRect();
    if (rect.width <= 0) {
      return 0.02;
    }
    return (this.tool.size * 2) / rect.width;
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

  drawLiveSegment(surface, from, to, stroke, isErase) {
    const offscreen = surface.ensureOffscreen();
    if (!offscreen || !from || !to) {
      return;
    }
    const ctx = offscreen.getContext("2d");
    const scaleX = offscreen.width;
    const scaleY = offscreen.height;
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
    surface.blit();
  }

  drawLiveDot(surface, point, stroke, isErase) {
    const offscreen = surface.ensureOffscreen();
    if (!offscreen || !point) {
      return;
    }
    const ctx = offscreen.getContext("2d");
    const scaleX = offscreen.width;
    const scaleY = offscreen.height;
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
    surface.blit();
  }

  handlePointerDown(surface, event) {
    if (!this.isDrawModeEnabled || event.button !== 0) {
      return;
    }
    const point = this.pointFromEvent(event, surface);
    if (!point) {
      return;
    }

    event.preventDefault();
    this.closePopouts();
    try {
      surface.canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      console.warn("Failed to capture pointer for annotation:", error);
    }

    const rect = surface.canvas.getBoundingClientRect();
    const isErase = this.tool.eraser;
    const pressure = isErase ? 1 : this.pressureFromEvent(event);
    this.pressureSmoothed = pressure;
    this.isStrokeActive = true;
    this.activeSurface = surface;
    this.syncHistoryButtons();
    this.activeStroke = {
      points: [[point[0], point[1], pressure]],
      color: isErase ? "" : this.tool.color,
      width: isErase ? this.currentEraserWidthNorm(surface) : this.tool.size / rect.width,
      erase: isErase,
    };
    this.lastPoint = this.activeStroke.points[0];
    this.drawLiveDot(surface, this.activeStroke.points[0], this.activeStroke, isErase);
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

    const rawPressure = stroke.erase ? 1 : this.pressureFromEvent(event);
    // 压感指数平滑，抑制回报抖动
    this.pressureSmoothed = this.pressureSmoothed * 0.6 + rawPressure * 0.4;
    stroke.points.push([point[0], point[1], this.pressureSmoothed]);
    this.drawLiveSegment(surface, this.lastPoint, stroke.points[stroke.points.length - 1], stroke, stroke.erase);
    this.lastPoint = stroke.points[stroke.points.length - 1];
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

    surface.recordAction({
      type: stroke.erase ? "erase" : "draw",
      stroke: {
        points: stroke.points,
        color: stroke.color,
        width: stroke.width,
      },
    });
    this.renderAll();
    surface.scheduleSave();
  }
}
