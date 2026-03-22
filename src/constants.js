export const DEFAULT_MAIN_MENU_BACKGROUND_URL = new URL("../src-tauri/icons/Default background.jpeg", import.meta.url).href;
export const DEFAULT_MAIN_MENU_BACKGROUND_LABEL = "默认背景图片";

export const DEFAULTS = {
  windowBounds: { width: 1000, height: 700, x: null, y: null },
  defaultImageFolderPath: "",
  mainMenuBackgroundPath: "",
  mainMenuBackgroundChoice: "staticImage",
  previewBackgroundPath: "",
  previewBackgroundChoice: "solidColor",
  gridColor: "#FFFFFF",
  gridSize: 8,
  timeFormat: "hours:minutes:seconds",
  isRandomPlayback: true,
  isAlwaysOnTop: false,
  isLibraryFilterMarkedEnabled: false,
  isFilterMarkedEnabled: true,
  isLightThemeEnabled: false,
  isCountdownHidden: false,
  imageMarks: {},
  startupMode: "lastUsedPath",
  mainMenuSelectedFolderPath: "",
  language: "zh-CN",
};

export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "svg"];

export const GRID_ALPHA = 0.3;
export const ITEMS_PER_PAGE = 30;
export const PRESET_TIMES = [30, 60, 120, 300, 600, Infinity];
export const AVERAGE_COLOR_SAMPLE_SIZE = 64;
export const GRID_COUNT_OPTIONS = [2, 4, 8, 16, 32];
