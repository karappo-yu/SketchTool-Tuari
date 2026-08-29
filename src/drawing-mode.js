import { desktop } from "./api/desktop.js";
import { elements } from "./dom.js";
import { listen } from "@tauri-apps/api/event";

const ANNOTATION_SIZE_MIN = 1;
const ANNOTATION_SIZE_MAX = 30;
const STRIP_HIDE_DELAY_MS = 500;
const STRIP_REVEAL_EDGE_PX = 90;

const byId = (id) => document.getElementById(id);

/**
 * 画笔模式控制器：参考图上的笔记画板（画笔 / 像素橡皮 / 撤销重做 / 持久化）
 * 以及画笔模式专属的竖条工具菜单（自动隐显 + 子面板）。
 *
 * host 为 AppController，模块通过它访问共享状态：
 * - host.state: isMirrorEnabled / isPlaying / imageFiles / currentImageIndex 等
 * - host.isPlaybackVisible(): 轮播界面是否可见
 */
export class DrawingModeController {
  constructor(host) {
    this.host = host;

    this.canvas = byId("annotation-canvas");
    this.ctx = this.canvas ? this.canvas.getContext("2d") : null;
    this.drawModeToggle = byId("drawModeToggle");
    this.backdrop = byId("image-backdrop");
    this.brushCursor = byId("brush-cursor");

    this.strip = byId("drawing-controls");
    this.toolButtons = {
      pen: byId("drawPenTool"),
      eraser: byId("drawEraserTool"),
      color: byId("drawColorTool"),
      size: byId("drawSizeTool"),
      undo: byId("drawUndoTool"),
      clear: byId("drawClearTool"),
      opacity: byId("drawOpacityTool"),
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
    this.previewImageOpacity = 1;

    this.actions = [];
    this.undoStack = [];
    this.redoStack = [];
    this.offscreen = null;
    this.loadToken = 0;
    this.saveTimer = null;
    this.activeStroke = null;
    this.lastPoint = null;
    this.isStrokeActive = false;
    this.redrawFrame = null;
    this.stripHideTimer = null;
    this.openPopoutName = "";

    // 数位板笔压：Rust 桥（macOS）推送的样本流；Windows 走 PointerEvent 原生 pressure
    this.pressureSamples = [];
    this.pressureSmoothed = 1;
  }

  // ---- 生命周期（由 AppController 委托调用） ----

  bindEvents() {
    if (!this.canvas || !this.drawModeToggle) {
      return;
    }

    this.drawModeToggle.addEventListener("click", () => this.setDrawModeEnabled(!this.isDrawModeEnabled));
    this.toolButtons.exit.addEventListener("click", () => this.setDrawModeEnabled(false));
    this.toolButtons.pen.addEventListener("click", () => this.selectPenTool());
    this.toolButtons.eraser.addEventListener("click", () => this.selectEraserTool());
    this.toolButtons.undo.addEventListener("click", () => this.undo());
    this.toolButtons.clear.addEventListener("click", () => this.clearAll());
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

    this.canvas.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.handlePointerUp(event));
    this.canvas.addEventListener("pointercancel", (event) => this.handlePointerUp(event));

    // 竖条自动隐显：靠近右缘出现，移开后延迟隐藏（与原菜单的 hover 行为一致）
    elements.imageDisplayArea.addEventListener("pointermove", (event) => this.handleStripReveal(event));
    elements.imageDisplayArea.addEventListener("pointermove", (event) => this.updateBrushCursor(event));
    elements.imageDisplayArea.addEventListener("pointerleave", () => {
      this.scheduleStripHide();
      this.hideBrushCursor();
    });
    this.strip.addEventListener("pointerenter", () => this.showStrip());
    this.strip.addEventListener("pointerleave", () => this.scheduleStripHide());

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
        this.redo();
      } else {
        this.undo();
      }
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && key === "y") {
      event.preventDefault();
      this.redo();
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
    this.previewImageOpacity = 1;
    elements.currentImage.style.opacity = "";
    this.opacitySlider.value = "100";
    this.opacityValue.textContent = "100%";
    this.loadToken += 1;
    this.resetRuntime();
  }

  /** 涂鸦模式会话开始时调用 */
  applyDoodleDefaults() {
    this.applyOpacity(35);
    this.setDrawModeEnabled(true);
  }

  /** 图片切换加载完成后调用：载入该图的笔记 */
  reloadForCurrentImage() {
    this.loadForCurrentImage();
  }

  handleImageLoadError() {
    this.loadToken += 1;
    this.resetRuntime();
  }

  onMirrorChanged() {
    this.scheduleRedraw();
  }

  onResize() {
    this.scheduleRedraw();
  }

  // ---- 画笔模式开关与菜单显隐 ----

  setDrawModeEnabled(enabled) {
    if (this.isDrawModeEnabled === enabled) {
      return;
    }
    this.isDrawModeEnabled = enabled;
    elements.imageDisplayArea.classList.toggle("draw-mode", enabled);
    this.canvas.classList.toggle("active", enabled);
    this.drawModeToggle.classList.toggle("active", enabled);
    this.closePopouts();
    if (!enabled) {
      this.activeStroke = null;
      this.isStrokeActive = false;
      this.hideBrushCursor();
      this.strip.classList.remove("visible");
      clearTimeout(this.stripHideTimer);
      this.stripHideTimer = null;
    } else {
      this.scheduleRedraw();
      this.showStrip();
      this.scheduleStripHide(2000);
    }
  }

  handleStripReveal(event) {
    if (!this.isDrawModeEnabled) {
      return;
    }
    if (this.isStrokeActive) {
      return;
    }
    if (event.clientX >= window.innerWidth - STRIP_REVEAL_EDGE_PX) {
      this.showStrip();
      return;
    }
    if (!this.strip.matches(":hover") && !this.openPopoutName) {
      this.scheduleStripHide();
    }
  }

  showStrip() {
    if (this.stripHideTimer !== null) {
      clearTimeout(this.stripHideTimer);
      this.stripHideTimer = null;
    }
    this.strip.classList.add("visible");
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

  // ---- 渲染（离屏回放 + 镜像贴图） ----

  scheduleRedraw() {
    if (this.redrawFrame !== null) {
      cancelAnimationFrame(this.redrawFrame);
    }

    this.redrawFrame = window.requestAnimationFrame(() => {
      this.redrawFrame = null;
      this.render();
    });
  }

  syncCanvasLayout() {
    if (!this.ctx || elements.imageDisplayArea.classList.contains("hidden")) {
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

    this.canvas.style.left = `${left}px`;
    this.canvas.style.top = `${top}px`;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    if (this.canvas.width !== Math.round(rect.width * dpr)) {
      this.canvas.width = Math.round(rect.width * dpr);
    }
    if (this.canvas.height !== Math.round(rect.height * dpr)) {
      this.canvas.height = Math.round(rect.height * dpr);
    }

    return { rect, dpr };
  }

  ensureOffscreen() {
    const image = elements.currentImage;
    if (!image.naturalWidth || !image.naturalHeight) {
      return null;
    }

    // 分辨率跟随原图（封顶 2560），保证窗口缩放时笔迹清晰且内存可控
    const targetWidth = Math.min(image.naturalWidth, 2560);
    const targetHeight = Math.max(1, Math.round(targetWidth * (image.naturalHeight / image.naturalWidth)));
    if (!this.offscreen || this.offscreen.width !== targetWidth || this.offscreen.height !== targetHeight) {
      this.offscreen = document.createElement("canvas");
      this.offscreen.width = targetWidth;
      this.offscreen.height = targetHeight;
    }
    return this.offscreen;
  }

  applyAction(ctx, action, scaleX, scaleY) {
    const stroke = action.stroke || {};
    const points = stroke.points || [];
    if (points.length === 0) {
      return;
    }
    const baseWidth = Math.max(1, (stroke.width ?? 0.01) * scaleX);
    // 笔压：第三位缺省（旧数据）按 1 处理，即恒定线宽
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

  replay() {
    const offscreen = this.ensureOffscreen();
    if (!offscreen) {
      return;
    }
    const ctx = offscreen.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, offscreen.width, offscreen.height);
    for (const action of this.actions) {
      this.applyAction(ctx, action, offscreen.width, offscreen.height);
    }
  }

  blit() {
    if (!this.ctx || !this.offscreen) {
      return;
    }
    if (!this.syncCanvasLayout()) {
      return;
    }

    const rect = elements.currentImage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.save();
    if (this.host.state.isMirrorEnabled) {
      ctx.translate(rect.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.offscreen, 0, 0, rect.width, rect.height);
    ctx.restore();
  }

  render() {
    if (!this.ctx) {
      return;
    }

    if (this.ensureOffscreen()) {
      this.replay();
      this.blit();
    } else if (this.syncCanvasLayout()) {
      const rect = elements.currentImage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.clearRect(0, 0, rect.width, rect.height);
    }

    this.toolButtons.undo.disabled = this.undoStack.length === 0;
  }

  // ---- 笔画绘制 ----

  currentImagePath() {
    const file = this.host.state.imageFiles[this.host.state.currentImageIndex];
    if (!file) {
      return "";
    }
    return file.originalPath || file.path || "";
  }

  pointFromEvent(event) {
    const rect = elements.currentImage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    let nx = (event.clientX - rect.left) / rect.width;
    let ny = (event.clientY - rect.top) / rect.height;
    nx = Math.min(1, Math.max(0, nx));
    ny = Math.min(1, Math.max(0, ny));
    if (this.host.state.isMirrorEnabled) {
      nx = 1 - nx;
    }
    return [nx, ny];
  }

  currentEraserWidthNorm() {
    const rect = elements.currentImage.getBoundingClientRect();
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

  drawLiveSegment(from, to, stroke, isErase) {
    const offscreen = this.ensureOffscreen();
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
    this.blit();
  }

  drawLiveDot(point, stroke, isErase) {
    const offscreen = this.ensureOffscreen();
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
    this.blit();
  }

  handlePointerDown(event) {
    if (!this.isDrawModeEnabled || event.button !== 0) {
      return;
    }
    const point = this.pointFromEvent(event);
    if (!point) {
      return;
    }

    event.preventDefault();
    this.closePopouts();
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch (error) {
      console.warn("Failed to capture pointer for annotation:", error);
    }

    const rect = elements.currentImage.getBoundingClientRect();
    const isErase = this.tool.eraser;
    const pressure = isErase ? 1 : this.pressureFromEvent(event);
    this.pressureSmoothed = pressure;
    this.isStrokeActive = true;
    this.activeStroke = {
      points: [[point[0], point[1], pressure]],
      color: isErase ? "" : this.tool.color,
      width: isErase ? this.currentEraserWidthNorm() : this.tool.size / rect.width,
      erase: isErase,
    };
    this.lastPoint = this.activeStroke.points[0];
    this.drawLiveDot(this.activeStroke.points[0], this.activeStroke, isErase);
  }

  handlePointerMove(event) {
    if (!this.isStrokeActive) {
      return;
    }
    const point = this.pointFromEvent(event);
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
    this.drawLiveSegment(this.lastPoint, stroke.points[stroke.points.length - 1], stroke, stroke.erase);
    this.lastPoint = stroke.points[stroke.points.length - 1];
  }

  handlePointerUp(event) {
    if (!this.isStrokeActive) {
      return;
    }

    try {
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
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

    this.recordAction({
      type: stroke.erase ? "erase" : "draw",
      stroke: {
        points: stroke.points,
        color: stroke.color,
        width: stroke.width,
      },
    });
    this.render();
    this.scheduleSave();
  }

  // ---- 撤销 / 重做 / 清空 / 持久化 ----

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
    this.render();
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
    this.render();
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
    this.render();
    this.scheduleSave();
  }

  scheduleSave() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }

    const path = this.currentImagePath();
    const actionsSnapshot = this.actions;
    if (!path) {
      return;
    }

    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      desktop.saveImageAnnotations(path, { version: 2, actions: actionsSnapshot }).catch((error) => {
        console.error("Failed to save image annotations:", error);
      });
    }, 500);
  }

  normalizePayload(payload) {
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

  async loadForCurrentImage() {
    const token = this.loadToken + 1;
    this.loadToken = token;
    this.resetRuntime();

    const path = this.currentImagePath();
    if (!path || elements.imageDisplayArea.classList.contains("hidden")) {
      return;
    }

    try {
      const payload = await desktop.loadImageAnnotations(path);
      if (this.loadToken !== token) {
        return;
      }
      this.actions = this.normalizePayload(payload);
      this.render();
    } catch (error) {
      console.error("Failed to load image annotations:", error);
    }
  }

  resetRuntime() {
    this.actions = [];
    this.undoStack = [];
    this.redoStack = [];
    this.activeStroke = null;
    this.isStrokeActive = false;
    this.offscreen = null;
    if (this.ctx) {
      const rect = elements.currentImage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.clearRect(0, 0, rect.width, rect.height);
    }
  }
}
