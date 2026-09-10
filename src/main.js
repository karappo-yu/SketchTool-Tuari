import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppController } from "./app-controller.js";

document.addEventListener("DOMContentLoaded", async () => {
  const appWindow = getCurrentWindow();
  let windowHasFocus = document.hasFocus();
  let activationDragDeadline = windowHasFocus ? 0 : Number.POSITIVE_INFINITY;
  let pendingActivationDrag = null;

  const clearPendingActivationDrag = () => {
    pendingActivationDrag = null;
  };

  window.addEventListener("focus", () => {
    if (!windowHasFocus) {
      activationDragDeadline = performance.now() + 250;
    }
    windowHasFocus = true;
  });

  window.addEventListener("blur", () => {
    windowHasFocus = false;
    activationDragDeadline = 0;
    clearPendingActivationDrag();
  });

  window.addEventListener("mouseup", (event) => {
    if (event.button === 0) {
      clearPendingActivationDrag();
    }
  }, true);

  window.addEventListener("mousemove", (event) => {
    if (!pendingActivationDrag || (event.buttons & 1) === 0) {
      if ((event.buttons & 1) === 0) {
        clearPendingActivationDrag();
      }
      return;
    }

    const deltaX = event.clientX - pendingActivationDrag.startX;
    const deltaY = event.clientY - pendingActivationDrag.startY;
    if (Math.hypot(deltaX, deltaY) < 4) {
      return;
    }

    clearPendingActivationDrag();
    appWindow.startDragging().catch((error) => {
      console.error("Failed to start dragging window:", error);
    });
  }, true);

  const isDragRegionTarget = (target) => {
    if (!(target instanceof Element)) {
      return false;
    }

    if (!target.closest("[data-tauri-drag-region]")) {
      return false;
    }

    return !target.closest("[data-no-drag], button, input, textarea, select, label, a, .glassmorphism");
  };

  // A click-through event can reach Tauri before the window has finished activating.
  // Defer the first native drag until the pointer actually moves, so a plain click
  // only focuses the window while a click-and-drag still works in one gesture.
  document.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }

    const isActivationDrag = !windowHasFocus || performance.now() < activationDragDeadline;
    activationDragDeadline = 0;

    if (!isDragRegionTarget(event.target) || !isActivationDrag) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    windowHasFocus = true;
    pendingActivationDrag = {
      startX: event.clientX,
      startY: event.clientY,
    };
  }, true);

  document.addEventListener("mousedown", async (event) => {
    if (event.button !== 0) {
      return;
    }

    if (!isDragRegionTarget(event.target)) {
      return;
    }

    event.preventDefault();

    try {
      await appWindow.startDragging();
    } catch (error) {
      console.error("Failed to start dragging window:", error);
    }
  });

  const controller = new AppController();
  await controller.init();

  await appWindow.onDragDropEvent(async (event) => {
    const payload = event?.payload;
    if (payload?.type !== "drop" || !Array.isArray(payload.paths) || payload.paths.length === 0) {
      return;
    }

    await controller.handleDroppedPaths(payload.paths);
  });
});
