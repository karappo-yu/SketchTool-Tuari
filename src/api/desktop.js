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

  async readFolderImages(folderPath) {
    const items = await command("read_folder_images", { folderPath });
    return items.map((item) =>
      item.type === "file"
        ? {
          ...item,
          originalPath: item.originalPath ?? item.path,
          path: toFileUrl(item.originalPath ?? item.path),
        }
        : item,
    );
  },

  async getFolderCompletionStates(folderPaths) {
    return command("get_folder_completion_states", { folderPaths });
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

  async isDirectory(path) {
    return command("is_directory", { path });
  },

  async openFileInFinder(filePath) {
    return command("open_file_in_finder", { filePath });
  },

  async openFileInDefaultApp(filePath) {
    return command("open_file_in_default_app", { filePath });
  },

  async saveImageMark(filePath, duration) {
    return command("save_image_mark", { filePath, duration });
  },

  async getImageMarks() {
    return command("get_image_marks");
  },

  async clearImageMarksForPath(filePath) {
    return command("clear_image_marks_for_path", { filePath });
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
