import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppController } from "./app-controller.js";

document.addEventListener("DOMContentLoaded", async () => {
  const appWindow = getCurrentWindow();

  document.addEventListener("mousedown", async (event) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (!target.closest("[data-tauri-drag-region]")) {
      return;
    }

    if (target.closest("[data-no-drag], button, input, textarea, select, label, a, .glassmorphism")) {
      return;
    }

    try {
      await appWindow.startDragging();
    } catch (error) {
      console.error("Failed to start dragging window:", error);
    }
  });

  const controller = new AppController();
  await controller.init();
});
