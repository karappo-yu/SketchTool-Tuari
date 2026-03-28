import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const command = (cmd, args = {}) => invoke(cmd, args);

export const toFileUrl = (filePath) => convertFileSrc(filePath);

export const desktop = {
  async saveSetting(key, value) {
    return command("save_setting", { key, value });
  },

  async loadSetting(key) {
    return command("load_setting", { key });
  },

  async loadSettings(keys) {
    return command("load_settings", { keys });
  },

  async openFileDialog() {
    return command("open_file_dialog");
  },

  async openFolderDialog(currentPath) {
    return command("open_folder_dialog", { currentPath: currentPath ?? null });
  },

  async loadSketchFolderData(folderPath, filterMarked) {
    const response = await command("load_sketch_folder_data", { folderPath, filterMarked });
    return {
      ...response,
      files: (response?.files || []).map((item) =>
        item.type === "file"
          ? {
            ...item,
            originalPath: item.originalPath ?? item.path,
            path: toFileUrl(item.originalPath ?? item.path),
          }
          : item
      ),
    };
  },

  async getFolderBrowserItems(folderPath, filterMarked) {
    const items = await command("get_folder_browser_items", { folderPath, filterMarked });
    return (items?.items || []).map((item) =>
      item.type === "file"
        ? {
          ...item,
          originalPath: item.originalPath ?? item.path,
          path: toFileUrl(item.originalPath ?? item.path),
        }
        : item
    );
  },

  async getLatestMarksForPaths(filePaths) {
    return command("get_latest_marks_for_paths", { filePaths });
  },

  async buildPlaybackPlan(imagePaths, filterMarked, isRandom, imageCount = null) {
    return command("build_playback_plan", {
      imagePaths,
      filterMarked,
      isRandom,
      imageCount,
    });
  },

  async startSession(imagePaths, filterMarked, isRandom, imageCount = null, displayTime = null) {
    return command("start_session", {
      imagePaths,
      filterMarked,
      isRandom,
      imageCount,
      displayTime,
    });
  },

  async sessionNext() {
    return command("session_next");
  },

  async sessionPrev() {
    return command("session_prev");
  },

  async sessionTogglePause() {
    return command("session_toggle_pause");
  },

  async sessionTick() {
    return command("session_tick");
  },

  async endSession() {
    return command("end_session");
  },

  async isDirectory(path) {
    return command("is_directory", { path });
  },

  async getParentPath(path) {
    return command("get_parent_path", { path });
  },

  async openFileInFinder(filePath) {
    return command("open_file_in_finder", { filePath });
  },

  async openFileInDefaultApp(filePath) {
    return command("open_file_in_default_app", { filePath });
  },

  async clearImageMarksForPath(filePath) {
    return command("clear_image_marks_for_path", { filePath });
  },

  async toggleImageMark(filePath, duration) {
    return command("toggle_image_mark", { filePath, duration });
  },

  async setAlwaysOnTop(alwaysOnTop) {
    return command("set_always_on_top", { alwaysOnTop });
  },

  async setTrafficLightVisibility(visible) {
    return command("set_traffic_light_visibility", { visible });
  },

  async setDecorations(decorations) {
    return command("set_decorations", { decorations });
  },

  async getPlatform() {
    return command("get_platform");
  },

  async openExternalLink(url) {
    return command("open_external_link", { url });
  },
};
