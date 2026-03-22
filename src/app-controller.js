import {
  AVERAGE_COLOR_SAMPLE_SIZE,
  DEFAULT_MAIN_MENU_BACKGROUND_LABEL,
  DEFAULT_MAIN_MENU_BACKGROUND_URL,
  DEFAULTS,
  GRID_ALPHA,
  GRID_COUNT_OPTIONS,
  ITEMS_PER_PAGE,
} from "./constants.js";
import { elements, groups } from "./dom.js";
import { desktop, toFileUrl } from "./api/desktop.js";
import { createEmptyHistory, formatTimeForHint, getParentPath, hexToRgba, naturalSort, shuffleArray } from "./utils.js";
import { setLanguage, t, getLanguage, SUPPORTED_LANGUAGES, updatePageI18n } from "./i18n.js";

export class AppController {
  constructor() {
    this.ctx = elements.gridCanvas.getContext("2d");
    this.hiddenImageCtx = elements.hiddenImageCanvas.getContext("2d", { willReadFrequently: true });
    this.presetTimeButtons = [
      elements.preset30sButton,
      elements.preset60sButton,
      elements.preset120sButton,
      elements.preset300sButton,
      elements.preset600sButton,
      elements.presetInfiniteTimeButton,
    ];
    this.eligibleImagesCache = {
      imageFilesRef: null,
      imageMarksRef: null,
      isFilterMarkedEnabled: null,
      value: [],
    };
    this.gridRedrawFrame = null;
    this.lastGridRenderSignature = "";
    this.lastGridStepSignature = "";
    this.lastGridStep = null;
    this.folderCompletionCache = new Map();
    this.latestMarkCache = new Map();
    this.cachedImageMarksRef = null;
    this.defaultPreviewBackgroundColor = "";
    this.averageColorCache = {
      src: "",
      naturalWidth: 0,
      naturalHeight: 0,
      color: "rgb(0,0,0)",
    };
    this.platform = "";

    this.state = {
      imageFiles: [],
      imageUrls: [],
      currentImageIndex: -1,
      displayTime: 60,
      countdownTimer: null,
      remainingTime: 60,
      isPlaying: false,
      isPaused: false,
      currentDefaultImageFolderPath: "",
      currentLoadedFolderPath: "",
      mainMenuSelectedFolderPath: "",
      isMirrorEnabled: false,
      isGrayscaleEnabled: false,
      isGridEnabled: false,
      isAlwaysOnTop: false,
      isRandomPlayback: true,
      isFilterMarkedEnabled: true,
      isLibraryFilterMarkedEnabled: false,
      isCountdownHidden: false,
      isLightThemeEnabled: false,
      previewBackgroundChoice: "solidColor",
      mainMenuBackgroundChoice: "solidColor",
      startupMode: "lastUsedPath",
      imageMarks: {},
      currentMainMenuBackgroundPath: "",
      currentPreviewBackgroundPath: "",
      currentGridColorHex: DEFAULTS.gridColor,
      currentGridSize: DEFAULTS.gridSize,
      currentTimeFormat: DEFAULTS.timeFormat,
      currentTrafficLightVisibility: null,
      currentFolderItems: [],
      currentPage: 0,
      currentLanguage: "zh-CN",
      ...createEmptyHistory(),
    };
  }

  async init() {
    this.platform = await desktop.getPlatform();
    this.bindEvents();
    await this.loadSettings();
    await this.bootstrapInitialView();
    this.syncToggleButtons();
    this.updatePresetTimeButtons(this.state.displayTime);
    this.refreshMainMenuEligibilityState();
  }

  bindEvents() {
    elements.sketchFolderInputDisplay.addEventListener("click", () => this.handleSketchFolderClick());
    elements.startButton.addEventListener("click", () => this.initiateSketchSession());
    elements.settingsButton.addEventListener("click", () => elements.settingsModalOverlay.classList.add("active"));
    elements.closeSettingsModalButton.addEventListener("click", () => elements.settingsModalOverlay.classList.remove("active"));
    elements.randomPlaybackToggle.addEventListener("click", () => this.toggleRandomPlayback());
    elements.filterMarkedToggle.addEventListener("click", () => this.togglePlaybackFilter());
    elements.settingsModalThemeToggle.addEventListener("click", () => this.applyTheme(!this.state.isLightThemeEnabled));
    elements.selectMainMenuImageButton.addEventListener("click", () => this.selectMainMenuBackgroundImage());
    elements.clearMainMenuImageButton.addEventListener("click", () => this.clearMainMenuBackgroundImage());
    elements.selectStaticImageButton.addEventListener("click", () => this.selectPreviewBackgroundImage());
    elements.clearStaticImageButton.addEventListener("click", () => this.clearPreviewBackgroundImage());
    elements.setDefaultImageFolderButton.addEventListener("click", () => this.setDefaultFolder());
    elements.clearDefaultImageFolderButton.addEventListener("click", () => this.clearDefaultFolder());
    elements.gridColorPicker.addEventListener("input", (event) => this.setGridColor(event.target.value));
    elements.gridSizeInput.addEventListener("change", (event) => this.handleGridSizeInput(event.target.value));
    elements.resetGridSettingsButton.addEventListener("click", () => this.resetGridSettings());
    elements.displayTimeInput.addEventListener("input", (event) => this.handleDisplayTimeInput(event.target.value));
    elements.mirrorToggle.addEventListener("click", () => this.toggleMirrorEffect());
    elements.overlayMirrorToggle.addEventListener("click", () => this.toggleMirrorEffect());
    elements.grayscaleToggle.addEventListener("click", () => this.toggleGrayscaleEffect());
    elements.overlayGrayscaleToggle.addEventListener("click", () => this.toggleGrayscaleEffect());
    elements.gridToggle.addEventListener("click", () => this.toggleGridEffect());
    elements.overlayGridToggle.addEventListener("click", () => this.toggleGridEffect());
    elements.toggleAlwaysOnTopButton.addEventListener("click", () => this.toggleAlwaysOnTop());
    elements.mainMenuAlwaysOnTopToggle.addEventListener("click", () => this.toggleAlwaysOnTop());
    elements.openInFinderButton.addEventListener("click", () => this.openCurrentFileInFinder());
    elements.markStarButton.addEventListener("click", () => this.toggleCurrentImageMark());
    elements.prevImageButton.addEventListener("click", () => this.showPreviousImage());
    elements.nextImageButton.addEventListener("click", () => this.advanceImage());
    elements.pausePlayButton.addEventListener("click", () => this.togglePausePlay());
    elements.backToMenuButton.addEventListener("click", () => this.stopGame());
    elements.selectFolderForSketchAndReturnToMenuButton.addEventListener("click", () => this.selectCurrentBrowserFolder());
    elements.selectNewFolderFromBrowserButton.addEventListener("click", () => this.selectNewFolderFromBrowser());
    elements.goUpFolderButton.addEventListener("click", () => this.goUpFolder());
    elements.closeFolderBrowserButton.addEventListener("click", () => this.showMainMenu());
    elements.prevPageButton.addEventListener("click", () => this.showPreviousPageOfThumbnails());
    elements.nextPageButton.addEventListener("click", () => this.showNextPageOfThumbnails());
    elements.libraryFilterMarkedToggle.addEventListener("click", () => this.toggleLibraryFilter());
    window.addEventListener("resize", () => {
      if (this.state.isGridEnabled && !elements.imageDisplayArea.classList.contains("hidden")) {
        this.scheduleGridRedraw();
      }
    });

    [
      [elements.preset30sButton, 30],
      [elements.preset60sButton, 60],
      [elements.preset120sButton, 120],
      [elements.preset300sButton, 300],
      [elements.preset600sButton, 600],
      [elements.presetInfiniteTimeButton, Infinity],
    ].forEach(([button, value]) => {
      button.addEventListener("click", () => this.setPresetTime(value, button));
    });

    groups.mainMenuBackgroundChoiceRadios.forEach((radio) => {
      radio.addEventListener("change", async (event) => {
        this.state.mainMenuBackgroundChoice = event.target.value;
        await desktop.saveSetting("mainMenuBackgroundChoice", this.state.mainMenuBackgroundChoice);
        elements.mainMenuStaticImagePathRow.style.display = this.state.mainMenuBackgroundChoice === "staticImage" ? "flex" : "none";
        if (!this.isPlaybackVisible()) {
          this.updateMainMenuBackground();
        }
      });
    });

    groups.previewBackgroundChoiceRadios.forEach((radio) => {
      radio.addEventListener("change", async (event) => {
        this.state.previewBackgroundChoice = event.target.value;
        await desktop.saveSetting("previewBackgroundChoice", this.state.previewBackgroundChoice);
        elements.staticImagePathRow.style.display = this.state.previewBackgroundChoice === "staticImage" ? "flex" : "none";
        if (this.isPlaybackVisible()) {
          this.refreshPreviewAppearance();
        }
      });
    });

    groups.timeFormatRadios.forEach((radio) => {
      radio.addEventListener("change", (event) => this.setTimeFormat(event.target.value));
    });

    groups.countdownVisibilityRadios.forEach((radio) => {
      radio.addEventListener("change", async (event) => {
        this.state.isCountdownHidden = event.target.value === "hide";
        await desktop.saveSetting("isCountdownHidden", this.state.isCountdownHidden);
        this.updateCountdownDisplay();
      });
    });

    groups.startupModeChoiceRadios.forEach((radio) => {
      radio.addEventListener("change", async (event) => {
        this.state.startupMode = event.target.value;
        await desktop.saveSetting("startupMode", this.state.startupMode);
      });
    });

    elements.languageSelector.addEventListener("change", (event) => {
      this.setLanguage(event.target.value);
    });
  }

  async loadSettings() {
    const keys = [
      "mainMenuBackgroundChoice",
      "mainMenuBackgroundPath",
      "previewBackgroundChoice",
      "previewBackgroundPath",
      "gridColor",
      "gridSize",
      "timeFormat",
      "isCountdownHidden",
      "defaultImageFolderPath",
      "mainMenuSelectedFolderPath",
      "isRandomPlayback",
      "isFilterMarkedEnabled",
      "isLibraryFilterMarkedEnabled",
      "isAlwaysOnTop",
      "startupMode",
      "imageMarks",
      "isLightThemeEnabled",
      "language",
    ];

    const values = await desktop.loadSettings(keys);

    this.state.isLightThemeEnabled = values.isLightThemeEnabled ?? DEFAULTS.isLightThemeEnabled;
    this.state.mainMenuBackgroundChoice = values.mainMenuBackgroundChoice ?? DEFAULTS.mainMenuBackgroundChoice;
    this.state.currentMainMenuBackgroundPath = values.mainMenuBackgroundPath || DEFAULTS.mainMenuBackgroundPath;
    this.state.previewBackgroundChoice = values.previewBackgroundChoice ?? DEFAULTS.previewBackgroundChoice;
    this.state.currentPreviewBackgroundPath = values.previewBackgroundPath || DEFAULTS.previewBackgroundPath;
    this.state.currentGridColorHex = values.gridColor || DEFAULTS.gridColor;
    this.state.currentGridSize = this.normalizeGridCount(values.gridSize ?? DEFAULTS.gridSize);
    this.state.currentTimeFormat = values.timeFormat === "minutes:seconds" ? DEFAULTS.timeFormat : (values.timeFormat || DEFAULTS.timeFormat);
    this.state.isCountdownHidden = values.isCountdownHidden ?? DEFAULTS.isCountdownHidden;
    this.state.currentDefaultImageFolderPath = values.defaultImageFolderPath || DEFAULTS.defaultImageFolderPath;
    this.state.mainMenuSelectedFolderPath = values.mainMenuSelectedFolderPath || DEFAULTS.mainMenuSelectedFolderPath;
    this.state.isRandomPlayback = values.isRandomPlayback ?? DEFAULTS.isRandomPlayback;
    this.state.isFilterMarkedEnabled = values.isFilterMarkedEnabled ?? DEFAULTS.isFilterMarkedEnabled;
    this.state.isLibraryFilterMarkedEnabled = values.isLibraryFilterMarkedEnabled ?? DEFAULTS.isLibraryFilterMarkedEnabled;
    this.state.isAlwaysOnTop = values.isAlwaysOnTop ?? DEFAULTS.isAlwaysOnTop;
    this.state.startupMode = values.startupMode ?? DEFAULTS.startupMode;
    this.state.imageMarks = values.imageMarks || DEFAULTS.imageMarks;
    this.state.currentLanguage = values.language || DEFAULTS.language;

    this.applyLanguage(this.state.currentLanguage);
    this.applyTheme(this.state.isLightThemeEnabled, false);
    this.setGridColor(this.state.currentGridColorHex, false);
    this.setGridSize(this.state.currentGridSize, false);
    this.setTimeFormat(this.state.currentTimeFormat, false);

    elements.mainMenuStaticImagePathRow.style.display = this.state.mainMenuBackgroundChoice === "staticImage" ? "flex" : "none";
    this.setValueIfChanged(elements.mainMenuBackgroundPathDisplay, this.state.currentMainMenuBackgroundPath || t("defaultBackgroundImage"));
    elements.staticImagePathRow.style.display = this.state.previewBackgroundChoice === "staticImage" ? "flex" : "none";
    this.setValueIfChanged(elements.previewBackgroundPathDisplay, this.state.currentPreviewBackgroundPath || t("notSelectedStaticImage"));
    this.setValueIfChanged(elements.defaultImageFolderPathDisplay, this.state.currentDefaultImageFolderPath || t("notSetDefaultPath"));
    elements.gridColorPicker.value = this.state.currentGridColorHex;
    this.setValueIfChanged(elements.gridSizeInput, this.state.currentGridSize);

    groups.mainMenuBackgroundChoiceRadios.forEach((radio) => {
      radio.checked = radio.value === this.state.mainMenuBackgroundChoice;
    });
    groups.previewBackgroundChoiceRadios.forEach((radio) => {
      radio.checked = radio.value === this.state.previewBackgroundChoice;
    });
    groups.timeFormatRadios.forEach((radio) => {
      radio.checked = radio.value === this.state.currentTimeFormat;
    });
    groups.countdownVisibilityRadios.forEach((radio) => {
      radio.checked = (radio.value === "hide") === this.state.isCountdownHidden;
    });
    groups.startupModeChoiceRadios.forEach((radio) => {
      radio.checked = radio.value === this.state.startupMode;
    });

    if (this.state.isAlwaysOnTop) {
      await desktop.setAlwaysOnTop(true);
    }
  }

  async bootstrapInitialView() {
    const initialPath = this.state.startupMode === "defaultPath"
      ? this.state.currentDefaultImageFolderPath
      : this.state.mainMenuSelectedFolderPath;

    if (!initialPath) {
      await this.showMainMenu();
      return;
    }

    try {
      this.state.mainMenuSelectedFolderPath = initialPath;
      await this.loadImagesForSketchFolder(initialPath);
      await this.showFolderBrowserView(initialPath);
    } catch (error) {
      console.error(error);
      this.state.mainMenuSelectedFolderPath = "";
      this.showAlert("启动时无法加载上次路径或默认路径，请重新选择文件夹。", "加载错误");
      await this.showMainMenu();
    }
  }

  syncToggleButtons() {
    elements.randomPlaybackToggle.classList.toggle("active", this.state.isRandomPlayback);
    elements.filterMarkedToggle.classList.toggle("active", this.state.isFilterMarkedEnabled);
    elements.libraryFilterMarkedToggle.classList.toggle("active", this.state.isLibraryFilterMarkedEnabled);
    elements.mainMenuAlwaysOnTopToggle.classList.toggle("active", this.state.isAlwaysOnTop);
    elements.toggleAlwaysOnTopButton.classList.toggle("active", this.state.isAlwaysOnTop);
    elements.mirrorToggle.classList.toggle("active", this.state.isMirrorEnabled);
    elements.overlayMirrorToggle.classList.toggle("active", this.state.isMirrorEnabled);
    elements.grayscaleToggle.classList.toggle("active", this.state.isGrayscaleEnabled);
    elements.overlayGrayscaleToggle.classList.toggle("active", this.state.isGrayscaleEnabled);
    elements.gridToggle.classList.toggle("active", this.state.isGridEnabled);
    elements.overlayGridToggle.classList.toggle("active", this.state.isGridEnabled);
  }

  isPlaybackVisible() {
    return !elements.imageDisplayArea.classList.contains("hidden");
  }

  normalizeGridCount(value) {
    const count = parseInt(value, 10);
    if (Number.isNaN(count)) {
      return DEFAULTS.gridSize;
    }
    if (count > GRID_COUNT_OPTIONS[GRID_COUNT_OPTIONS.length - 1]) {
      return DEFAULTS.gridSize;
    }

    const clampedCount = Math.min(
      GRID_COUNT_OPTIONS[GRID_COUNT_OPTIONS.length - 1],
      Math.max(GRID_COUNT_OPTIONS[0], count),
    );

    return GRID_COUNT_OPTIONS.reduce((closest, option) => {
      const closestDelta = Math.abs(closest - clampedCount);
      const optionDelta = Math.abs(option - clampedCount);
      if (optionDelta < closestDelta) {
        return option;
      }
      if (optionDelta === closestDelta && option > closest) {
        return option;
      }
      return closest;
    }, GRID_COUNT_OPTIONS[0]);
  }

  showAlert(message, title = "提示") {
    const existingAlert = document.getElementById("custom-alert-box");
    if (existingAlert) {
      existingAlert.remove();
    }

    const alertBox = document.createElement("div");
    alertBox.id = "custom-alert-box";
    alertBox.innerHTML = `
      <h3 style="margin-bottom: 15px; font-size: 1.3em;">${title}</h3>
      <p style="margin-bottom: 20px; font-size: 1em; line-height: 1.5;">${message}</p>
      <button id="alertCloseButton" style="padding: 10px 20px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">确定</button>
    `;

    document.body.appendChild(alertBox);
    document.getElementById("alertCloseButton").addEventListener("click", () => alertBox.remove());
  }

  resetGridRenderState(clearCanvas = false) {
    this.lastGridRenderSignature = "";
    this.lastGridStepSignature = "";
    this.lastGridStep = null;

    if (this.gridRedrawFrame !== null) {
      cancelAnimationFrame(this.gridRedrawFrame);
      this.gridRedrawFrame = null;
    }

    if (clearCanvas) {
      this.ctx.clearRect(0, 0, elements.gridCanvas.width, elements.gridCanvas.height);
    }
  }

  setTextContentIfChanged(element, nextText) {
    if (element.textContent !== nextText) {
      element.textContent = nextText;
    }
  }

  setDisabledIfChanged(element, disabled) {
    if (element.disabled !== disabled) {
      element.disabled = disabled;
    }
  }

  setValueIfChanged(element, nextValue) {
    const normalizedValue = `${nextValue ?? ""}`;
    if (element.value !== normalizedValue) {
      element.value = normalizedValue;
    }
  }

  applyTheme(isLight, persist = true) {
    this.state.isLightThemeEnabled = isLight;
    document.body.classList.toggle("light-theme", isLight);
    this.defaultPreviewBackgroundColor = "";
    elements.settingsModalThemeToggle.classList.toggle("active", isLight);
    if (persist) {
      desktop.saveSetting("isLightThemeEnabled", isLight);
    }
    if (this.isPlaybackVisible()) {
      this.refreshPreviewAppearance();
    } else {
      this.updateMainMenuBackground();
    }
    if (this.state.isGridEnabled && this.isPlaybackVisible()) {
      this.drawGrid();
    }
  }

  applyLanguage(lang, persist = true) {
    if (!SUPPORTED_LANGUAGES.includes(lang)) {
      lang = "zh-CN";
    }
    this.state.currentLanguage = lang;
    setLanguage(lang);
    if (persist) {
      desktop.saveSetting("language", lang);
    }
    updatePageI18n();
    this.updateUITexts();
  }

  setLanguage(lang) {
    this.applyLanguage(lang, true);
  }

  updateUITexts() {
    const lang = this.state.currentLanguage;

    if (elements.languageSelector) {
      elements.languageSelector.value = lang;
    }

    updatePageI18n();

    this.setValueIfChanged(
      elements.mainMenuBackgroundPathDisplay,
      this.state.currentMainMenuBackgroundPath || t("defaultBackgroundImage")
    );
    this.setValueIfChanged(
      elements.previewBackgroundPathDisplay,
      this.state.currentPreviewBackgroundPath || t("notSelectedStaticImage")
    );
    this.setValueIfChanged(
      elements.defaultImageFolderPathDisplay,
      this.state.currentDefaultImageFolderPath || t("notSetDefaultPath")
    );

    this.refreshMainMenuEligibilityState();
    this.updateMarkingUI();
  }

  getDefaultPreviewBackgroundColor() {
    if (!this.defaultPreviewBackgroundColor) {
      this.defaultPreviewBackgroundColor = getComputedStyle(document.body).getPropertyValue("--default-preview-bg").trim();
    }
    return this.defaultPreviewBackgroundColor;
  }

  applyBackground(targetElement, backgroundType, source = "") {
    targetElement.style.backgroundImage = "";
    targetElement.style.backgroundColor = "";
    targetElement.style.backgroundSize = "";
    targetElement.style.backgroundPosition = "";
    targetElement.style.backgroundRepeat = "";
    targetElement.style.backgroundAttachment = "";

    if (backgroundType === "menuGradient") {
      targetElement.style.backgroundImage = "linear-gradient(135deg, var(--bg-gradient-start), var(--bg-gradient-mid), var(--bg-gradient-end))";
      return;
    }

    if (backgroundType === "previewSolid") {
      targetElement.style.backgroundColor = this.getDefaultPreviewBackgroundColor();
      return;
    }

    if (backgroundType === "staticImage" && source) {
      targetElement.style.backgroundImage = `url('${source}')`;
      targetElement.style.backgroundSize = "cover";
      targetElement.style.backgroundPosition = "center center";
      targetElement.style.backgroundRepeat = "no-repeat";
      targetElement.style.backgroundAttachment = "fixed";
      return;
    }

    if (backgroundType === "averageColor" && source) {
      targetElement.style.backgroundColor = source;
      return;
    }

    targetElement.style.backgroundColor = this.getDefaultPreviewBackgroundColor();
  }

  getAverageColor(imgElement) {
    if (!imgElement.complete) {
      return "rgb(0,0,0)";
    }

    const currentSrc = imgElement.currentSrc || imgElement.src || "";
    const naturalWidth = imgElement.naturalWidth || imgElement.offsetWidth || 0;
    const naturalHeight = imgElement.naturalHeight || imgElement.offsetHeight || 0;

    if (
      this.averageColorCache.src === currentSrc
      && this.averageColorCache.naturalWidth === naturalWidth
      && this.averageColorCache.naturalHeight === naturalHeight
    ) {
      return this.averageColorCache.color;
    }

    const sourceWidth = Math.max(1, imgElement.naturalWidth || imgElement.offsetWidth);
    const sourceHeight = Math.max(1, imgElement.naturalHeight || imgElement.offsetHeight);
    const longestSide = Math.max(sourceWidth, sourceHeight);
    const scale = Math.min(1, AVERAGE_COLOR_SAMPLE_SIZE / longestSide);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    elements.hiddenImageCanvas.width = width;
    elements.hiddenImageCanvas.height = height;

    if (width === 0 || height === 0) {
      return "rgb(0,0,0)";
    }

    this.hiddenImageCtx.clearRect(0, 0, width, height);
    this.hiddenImageCtx.drawImage(imgElement, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);

    const imageData = this.hiddenImageCtx.getImageData(0, 0, width, height).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (let i = 0; i < imageData.length; i += 4) {
      r += imageData[i];
      g += imageData[i + 1];
      b += imageData[i + 2];
      count += 1;
    }

    if (count === 0) {
      return "rgb(0,0,0)";
    }

    const color = `rgb(${Math.floor(r / count)},${Math.floor(g / count)},${Math.floor(b / count)})`;
    this.averageColorCache = {
      src: currentSrc,
      naturalWidth,
      naturalHeight,
      color,
    };

    return color;
  }

  updateMainMenuBackground() {
    elements.dynamicBackgroundLayer.style.backgroundImage = "none";
    elements.dynamicBackgroundLayer.style.backgroundColor = "transparent";
    elements.dynamicBackgroundLayer.classList.remove("grayscale-active-bg");

    if (this.state.mainMenuBackgroundChoice === "staticImage") {
      const source = this.state.currentMainMenuBackgroundPath
        ? toFileUrl(this.state.currentMainMenuBackgroundPath)
        : DEFAULT_MAIN_MENU_BACKGROUND_URL;
      this.applyBackground(document.body, "staticImage", source);
      return;
    }

    this.applyBackground(document.body, "menuGradient");
  }

  updatePreviewBackground() {
    document.body.style.backgroundColor = "transparent";
    document.body.style.backgroundImage = "none";
    elements.appContainer.style.backgroundColor = "transparent";
    elements.appContainer.style.backgroundImage = "none";

    if (this.state.previewBackgroundChoice === "averageColor") {
      if (elements.currentImage.complete && elements.currentImage.naturalWidth > 0) {
        const avgColor = this.getAverageColor(elements.currentImage);
        this.applyBackground(elements.dynamicBackgroundLayer, "averageColor", avgColor);
      } else {
        this.applyBackground(elements.dynamicBackgroundLayer, "previewSolid");
      }
      return;
    }

    if (this.state.previewBackgroundChoice === "staticImage" && this.state.currentPreviewBackgroundPath) {
      this.applyBackground(elements.dynamicBackgroundLayer, "staticImage", toFileUrl(this.state.currentPreviewBackgroundPath));
      return;
    }

    this.applyBackground(elements.dynamicBackgroundLayer, "previewSolid");
  }

  updatePreviewBackgroundGrayscaleEffect() {
    const shouldGray = this.state.isGrayscaleEnabled
      && (this.state.previewBackgroundChoice === "averageColor" || this.state.previewBackgroundChoice === "solidColor");
    elements.dynamicBackgroundLayer.classList.toggle("grayscale-active-bg", shouldGray);
  }

  refreshPreviewAppearance() {
    this.updatePreviewBackground();
    this.updatePreviewBackgroundGrayscaleEffect();
  }

  async setTrafficLightVisibility(visible) {
    if (this.state.currentTrafficLightVisibility === visible) {
      return;
    }

    await desktop.setTrafficLightVisibility(visible);
    this.state.currentTrafficLightVisibility = visible;
  }

  async handleSketchFolderClick() {
    if (this.state.mainMenuSelectedFolderPath) {
      await this.showFolderBrowserView(this.state.mainMenuSelectedFolderPath);
      return;
    }

    const folderPath = await desktop.openFolderDialog(this.state.currentDefaultImageFolderPath || undefined);
    if (!folderPath) {
      return;
    }

    this.state.mainMenuSelectedFolderPath = folderPath;
    await desktop.saveSetting("mainMenuSelectedFolderPath", folderPath);
    await this.loadImagesForSketchFolder(folderPath);
    await this.showFolderBrowserView(folderPath);
  }

  async loadImagesForSketchFolder(folderPath) {
    const items = await desktop.readFolderImages(folderPath);
    const imageFiles = items.filter((item) => item.type === "file").sort(naturalSort);
    this.state.imageFiles = imageFiles.map((file) => ({ name: file.name, path: file.originalPath }));
    this.state.imageUrls = imageFiles.map((file) => file.path);
    this.setTextContentIfChanged(elements.sketchFolderInputDisplay, folderPath || "点击选择速写文件夹...");
  }

  async showMainMenu(folderPathToSetAsSelected = null) {
    elements.controlsMenu.classList.remove("hidden");
    elements.folderBrowserView.classList.add("hidden");
    elements.imageDisplayArea.classList.add("hidden");
    elements.topRightMenuButtons.classList.remove("hidden");
    if (this.platform === "windows") {
      desktop.setDecorations(true);
    }

    let targetFolder = this.state.mainMenuSelectedFolderPath;
    if (folderPathToSetAsSelected) {
      targetFolder = folderPathToSetAsSelected;
      this.state.mainMenuSelectedFolderPath = folderPathToSetAsSelected;
    } else if (!targetFolder && this.state.startupMode === "defaultPath" && this.state.currentDefaultImageFolderPath) {
      targetFolder = this.state.currentDefaultImageFolderPath;
      this.state.mainMenuSelectedFolderPath = targetFolder;
    }

    if (targetFolder) {
      try {
        await this.loadImagesForSketchFolder(targetFolder);
      } catch (error) {
        console.error(error);
        this.state.imageFiles = [];
        this.state.imageUrls = [];
        this.state.mainMenuSelectedFolderPath = "";
        this.setTextContentIfChanged(elements.sketchFolderInputDisplay, "无法加载，请重新选择...");
        this.showAlert("无法加载当前文件夹。请重新选择。", "错误");
      }
    } else {
      this.state.imageFiles = [];
      this.state.imageUrls = [];
      this.setTextContentIfChanged(elements.sketchFolderInputDisplay, "点击选择速写文件夹...");
    }

    this.updateMainMenuBackground();
    this.updateNavigationButtons();
    this.refreshMainMenuEligibilityState();
    this.updateMarkingUI();
    this.resetGridRenderState(true);
    elements.gridCanvas.classList.toggle("active", this.state.isGridEnabled);
    await this.setTrafficLightVisibility(true);
  }

  async isFolderCompleted(folderPath) {
    this.syncMarkCaches();

    const cached = this.folderCompletionCache.get(folderPath);
    if (cached && cached.imageMarksRef === this.state.imageMarks) {
      return cached.value;
    }

    const items = await desktop.readFolderImages(folderPath);
    const directImages = items.filter((item) => item.type === "file");
    if (directImages.length === 0) {
      this.folderCompletionCache.set(folderPath, {
        imageMarksRef: this.state.imageMarks,
        value: false,
      });
      return false;
    }

    const isCompleted = directImages.every((image) => {
      const marks = this.state.imageMarks[image.originalPath];
      return Array.isArray(marks) && marks.length > 0;
    });

    this.folderCompletionCache.set(folderPath, {
      imageMarksRef: this.state.imageMarks,
      value: isCompleted,
    });

    return isCompleted;
  }

  async getFolderCompletionStates(items) {
    const directories = items.filter((item) => item.type === "directory");
    if (directories.length === 0) {
      return new Map();
    }

    const completionEntries = await Promise.all(
      directories.map(async (directory) => [directory.path, await this.isFolderCompleted(directory.path)]),
    );
    return new Map(completionEntries);
  }

  getLatestMark(marks) {
    this.syncMarkCaches();

    if (!Array.isArray(marks) || marks.length === 0) {
      return null;
    }

    const cached = this.latestMarkCache.get(marks);
    if (cached) {
      return cached;
    }

    let latestMark = marks[0];
    for (let index = 1; index < marks.length; index += 1) {
      if (marks[index].timestamp > latestMark.timestamp) {
        latestMark = marks[index];
      }
    }

    this.latestMarkCache.set(marks, latestMark);
    return latestMark;
  }

  createThumbnailMarkInfo(item, latestMark) {
    const date = new Date(latestMark.timestamp);
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    const duration = latestMark.duration === 0 ? "∞" : `${latestMark.duration}s`;
    const info = document.createElement("div");
    info.classList.add("thumbnail-mark-info");
    info.innerHTML = `${month}/${day} (${duration}) <span class="delete-mark-button" data-path="${item.originalPath}">&times;</span>`;
    return info;
  }

  syncMarkCaches() {
    if (this.cachedImageMarksRef === this.state.imageMarks) {
      return;
    }

    this.cachedImageMarksRef = this.state.imageMarks;
    this.folderCompletionCache.clear();
    this.latestMarkCache.clear();
  }

  async renderCurrentPageThumbnails() {
    elements.thumbnailsGridContainer.innerHTML = "";
    elements.folderBrowserInfoMessage.classList.add("hidden");
    const fragment = document.createDocumentFragment();

    const startIndex = this.state.currentPage * ITEMS_PER_PAGE;
    const itemsToDisplay = this.state.currentFolderItems.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    const folderCompletionStates = await this.getFolderCompletionStates(itemsToDisplay);

    if (this.state.currentFolderItems.length === 0) {
      this.setTextContentIfChanged(elements.folderBrowserInfoMessage, "当前文件夹为空。");
      elements.folderBrowserInfoMessage.classList.remove("hidden");
    }

    for (const item of itemsToDisplay) {
      const thumbnailItem = document.createElement("div");
      thumbnailItem.classList.add("thumbnail-item");

      if (item.type === "directory") {
        thumbnailItem.innerHTML = `
          <span class="folder-icon">📁</span>
          <div class="thumbnail-label">${item.name}</div>
        `;
        thumbnailItem.addEventListener("click", () => this.showFolderBrowserView(item.path));

        if (folderCompletionStates.get(item.path)) {
          const completedInfo = document.createElement("div");
          completedInfo.classList.add("thumbnail-folder-completed-info");
          completedInfo.textContent = "已完成";
          thumbnailItem.appendChild(completedInfo);
        }
      } else {
        const img = document.createElement("img");
        img.src = item.path;
        img.alt = item.name;
        img.loading = "lazy";
        img.decoding = "async";

        const label = document.createElement("div");
        label.classList.add("thumbnail-label");
        label.textContent = item.name;

        thumbnailItem.appendChild(img);
        thumbnailItem.appendChild(label);

        const marks = this.state.imageMarks[item.originalPath];
        if (Array.isArray(marks) && marks.length > 0) {
          const latestMark = this.getLatestMark(marks);
          const info = this.createThumbnailMarkInfo(item, latestMark);
          thumbnailItem.appendChild(info);

          info.querySelector(".delete-mark-button").addEventListener("click", async (event) => {
            event.stopPropagation();
            await desktop.clearImageMarksForPath(event.target.dataset.path);
            this.state.imageMarks = await desktop.getImageMarks();
            info.remove();
            this.refreshMainMenuEligibilityState();
          });
        }

        thumbnailItem.addEventListener("dblclick", async () => {
          const result = await desktop.openFileInDefaultApp(item.originalPath);
          if (!result.success) {
            this.showAlert(result.message || "无法打开文件。", "错误");
          }
        });
      }

      fragment.appendChild(thumbnailItem);
    }

    elements.thumbnailsGridContainer.appendChild(fragment);

    const totalPages = this.getTotalFolderPages();
    this.setTextContentIfChanged(elements.pageInfoDisplay, `第 ${this.state.currentPage + 1} 页 / 共 ${totalPages} 页`);
    this.setDisabledIfChanged(elements.prevPageButton, this.state.currentPage === 0);
    this.setDisabledIfChanged(
      elements.nextPageButton,
      this.state.currentPage >= totalPages - 1 || this.state.currentFolderItems.length === 0,
    );
  }

  async showFolderBrowserView(folderPath) {
    if (!folderPath) {
      const nextFolder = await desktop.openFolderDialog(this.state.mainMenuSelectedFolderPath || this.state.currentDefaultImageFolderPath || undefined);
      if (!nextFolder) {
        await this.showMainMenu();
        return;
      }
      folderPath = nextFolder;
    }

    elements.controlsMenu.classList.add("hidden");
    elements.imageDisplayArea.classList.add("hidden");
    elements.folderBrowserView.classList.remove("hidden");
    elements.topRightMenuButtons.classList.remove("hidden");

    this.state.currentLoadedFolderPath = folderPath;
    const pathParts = folderPath.split(/[/\\]/);
    elements.currentLibraryPathDisplay.textContent = `当前文件夹: ${pathParts[pathParts.length - 1]}`;
    elements.currentLibraryPathDisplay.title = folderPath;
    elements.folderBrowserInfoMessage.textContent = "加载中...";
    elements.folderBrowserInfoMessage.classList.remove("hidden");

    this.updateMainMenuBackground();
    this.state.currentFolderItems = [];
    elements.selectFolderForSketchAndReturnToMenuButton.disabled = true;
    elements.goUpFolderButton.classList.toggle("hidden", !getParentPath(folderPath));
    elements.libraryFilterMarkedToggle.classList.toggle("active", this.state.isLibraryFilterMarkedEnabled);

    try {
      const items = await desktop.readFolderImages(folderPath);
      const directories = items.filter((item) => item.type === "directory");
      let files = items.filter((item) => item.type === "file");

      if (this.state.isLibraryFilterMarkedEnabled) {
        files = files.filter((file) => {
          const marks = this.state.imageMarks[file.originalPath];
          return !Array.isArray(marks) || marks.length === 0;
        });
      }

      this.state.currentFolderItems = [...directories, ...files].sort((a, b) => {
        if (a.type === "directory" && b.type === "file") {
          return -1;
        }
        if (a.type === "file" && b.type === "directory") {
          return 1;
        }
        return naturalSort(a, b);
      });
      this.state.currentPage = 0;
      await this.renderCurrentPageThumbnails();
      elements.selectFolderForSketchAndReturnToMenuButton.disabled = files.length === 0;
    } catch (error) {
      console.error(error);
      elements.folderBrowserInfoMessage.textContent = `加载图片库失败：${error.message || "未知错误"}`;
      elements.folderBrowserInfoMessage.classList.remove("hidden");
    }

    await this.setTrafficLightVisibility(true);
  }

  showPreviousPageOfThumbnails() {
    if (this.state.currentPage > 0) {
      this.state.currentPage -= 1;
      this.renderCurrentPageThumbnails();
    }
  }

  showNextPageOfThumbnails() {
    const totalPages = this.getTotalFolderPages();
    if (this.state.currentPage < totalPages - 1) {
      this.state.currentPage += 1;
      this.renderCurrentPageThumbnails();
    }
  }

  getEligibleImageRawIndexes() {
    if (
      this.eligibleImagesCache.imageFilesRef === this.state.imageFiles
      && this.eligibleImagesCache.imageMarksRef === this.state.imageMarks
      && this.eligibleImagesCache.isFilterMarkedEnabled === this.state.isFilterMarkedEnabled
    ) {
      return this.eligibleImagesCache.value;
    }

    const eligibleIndexes = this.state.imageFiles
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => {
        const marks = this.state.imageMarks[file.path];
        return !(this.state.isFilterMarkedEnabled && Array.isArray(marks) && marks.length > 0);
      })
      .map(({ index }) => index);

    this.eligibleImagesCache = {
      imageFilesRef: this.state.imageFiles,
      imageMarksRef: this.state.imageMarks,
      isFilterMarkedEnabled: this.state.isFilterMarkedEnabled,
      value: eligibleIndexes,
    };

    return eligibleIndexes;
  }

  getEligibleImageCount() {
    return this.getEligibleImageRawIndexes().length;
  }

  refreshMainMenuEligibilityState() {
    this.updateStartButtonState();
    this.updateMainMenuHintText();
  }

  updateStartButtonState() {
    const eligibleCount = this.getEligibleImageCount();
    this.setDisabledIfChanged(elements.startButton, eligibleCount === 0);

    if (eligibleCount > 0) {
      elements.startButton.setAttribute("data-tooltip", "开始速写");
      return;
    }

    if (this.state.mainMenuSelectedFolderPath && this.state.imageUrls.length > 0 && this.state.isFilterMarkedEnabled) {
      elements.startButton.setAttribute("data-tooltip", "该文件夹下图片已全部标记");
      return;
    }

    if (this.state.mainMenuSelectedFolderPath && this.state.imageUrls.length > 0) {
      elements.startButton.setAttribute("data-tooltip", "没有可播放的图片");
      return;
    }

    elements.startButton.setAttribute("data-tooltip", "请选择速写文件夹");
  }

  updateMainMenuHintText() {
    const eligibleCount = this.getEligibleImageCount();

    if (!this.state.mainMenuSelectedFolderPath) {
      this.setTextContentIfChanged(elements.mainMenuHintText, t("selectFolderHint"));
      return;
    }

    if (eligibleCount === 0 && this.state.imageUrls.length > 0 && this.state.isFilterMarkedEnabled) {
      this.setTextContentIfChanged(elements.mainMenuHintText, t("allMarkedAdjustFilter"));
      return;
    }

    if (this.state.imageUrls.length === 0) {
      this.setTextContentIfChanged(elements.mainMenuHintText, t("noSketchImages"));
      return;
    }

    if (this.state.displayTime === Infinity) {
      this.setTextContentIfChanged(elements.mainMenuHintText, `${t("totalImagesSelected")}${eligibleCount}${t("imagesTimeSetToUnlimited")}`);
      return;
    }

    if (Number.isNaN(this.state.displayTime) || this.state.displayTime <= 0) {
      this.setTextContentIfChanged(elements.mainMenuHintText, `${t("totalImagesSelected")}${eligibleCount}${t("imagesPleaseSelectTime")}`);
      return;
    }

    const estimated = formatTimeForHint(eligibleCount * this.state.displayTime);
    this.setTextContentIfChanged(elements.mainMenuHintText, `${t("estimatedTime")}${eligibleCount}${t("estimated")}${estimated}`);
  }

  initiateSketchSession() {
    if (elements.startButton.disabled) {
      return;
    }

    if (this.state.displayTime !== Infinity && (Number.isNaN(this.state.displayTime) || this.state.displayTime <= 0)) {
      this.showAlert("请设置一个有效的图片显示时间。", "时间设置错误");
      return;
    }

    const eligibleIndexes = this.getEligibleImageRawIndexes();
    if (eligibleIndexes.length === 0) {
      return;
    }

    this.state.currentSessionPlaybackQueue = this.state.isRandomPlayback ? shuffleArray(eligibleIndexes) : [...eligibleIndexes];
    this.state.displayedImageHistory = [];
    this.state.historyPointer = -1;
    this.state.isPlaying = true;
    this.state.isPaused = false;

    elements.controlsMenu.classList.add("hidden");
    elements.folderBrowserView.classList.add("hidden");
    elements.imageDisplayArea.classList.remove("hidden");
    elements.topRightMenuButtons.classList.add("hidden");
    elements.pausePlayButton.textContent = "⏸";
    this.resetGridRenderState(true);
    elements.gridCanvas.classList.toggle("active", this.state.isGridEnabled);

    document.body.style.backgroundColor = "transparent";
    document.body.style.backgroundImage = "none";
    this.updatePreviewBackground();
    this.updatePreviewBackgroundGrayscaleEffect();
    this.setTrafficLightVisibility(false);
    if (this.platform === "windows") {
      desktop.setDecorations(false);
    }
    this.advanceImage(true).catch((error) => {
      console.error("Failed to start sketch session playback:", error);
    });
  }

  async advanceImage(isStartingNewSession = false) {
    if (this.state.currentSessionPlaybackQueue.length === 0) {
      this.stopGame();
      return;
    }

    let newIndex = -1;
    let foundNext = false;

    if (isStartingNewSession) {
      [newIndex] = this.state.currentSessionPlaybackQueue;
      foundNext = this.state.currentSessionPlaybackQueue.length > 0;
    } else {
      const currentQueueIndex = this.getCurrentQueueIndex();
      if (currentQueueIndex !== -1 && currentQueueIndex + 1 < this.state.currentSessionPlaybackQueue.length) {
        newIndex = this.state.currentSessionPlaybackQueue[currentQueueIndex + 1];
        foundNext = true;
      } else {
        this.finishPlayback();
        return;
      }
    }

    if (!foundNext) {
      this.finishPlayback();
      return;
    }

    if (this.state.historyPointer < this.state.displayedImageHistory.length - 1) {
      this.state.displayedImageHistory = this.state.displayedImageHistory.slice(0, this.state.historyPointer + 1);
    }

    this.state.displayedImageHistory.push(newIndex);
    this.state.historyPointer = this.state.displayedImageHistory.length - 1;
    this.state.currentImageIndex = newIndex;
    this.state.remainingTime = this.state.displayTime;

    this.updateImageDisplay(this.state.imageUrls[newIndex]);
    this.updateCountdownDisplay();
    this.updateNavigationButtons();
    this.updateMarkingUI();

    if (!this.state.isPaused) {
      this.startCountdown();
    }
  }

  finishPlayback() {
    clearInterval(this.state.countdownTimer);
    this.state.isPlaying = false;
    this.state.isPaused = true;
    elements.pausePlayButton.textContent = "▶";
    elements.countdownElement.textContent = "已经没有下一张";
    this.updateNavigationButtons();
    this.updateMarkingUI();
    this.refreshMainMenuEligibilityState();
  }

  showPreviousImage() {
    if (this.state.historyPointer <= 0) {
      this.showAlert("已是第一张图片。", "播放提示");
      return;
    }

    clearInterval(this.state.countdownTimer);
    this.state.historyPointer -= 1;
    this.state.currentImageIndex = this.state.displayedImageHistory[this.state.historyPointer];
    this.state.remainingTime = this.state.displayTime;
    this.updateImageDisplay(this.state.imageUrls[this.state.currentImageIndex]);
    this.updateCountdownDisplay();
    this.updateMarkingUI();

    if (!this.state.isPaused) {
      this.startCountdown();
    }

    this.updateNavigationButtons();
  }

  togglePausePlay() {
    this.state.isPaused = !this.state.isPaused;
    elements.pausePlayButton.textContent = this.state.isPaused ? "▶" : "⏸";
    if (this.state.isPaused) {
      clearInterval(this.state.countdownTimer);
    } else {
      this.startCountdown();
    }
    this.updateNavigationButtons();
  }

  startCountdown() {
    clearInterval(this.state.countdownTimer);
    if (this.state.displayTime === Infinity || this.state.isPaused) {
      return;
    }

    this.updateCountdownDisplay();
    this.state.countdownTimer = window.setInterval(async () => {
      this.state.remainingTime -= 1;
      this.updateCountdownDisplay();

      if (this.state.remainingTime > 0) {
        return;
      }

      clearInterval(this.state.countdownTimer);
      const currentFile = this.state.imageFiles[this.state.currentImageIndex];
      if (currentFile) {
        await desktop.saveImageMark(currentFile.path, this.state.displayTime);
        this.state.imageMarks = await desktop.getImageMarks();
      }
      await this.advanceImage();
    }, 1000);
  }

  updateCountdownDisplay() {
    let nextText = "";

    if (this.state.isCountdownHidden || this.state.displayTime === Infinity) {
      nextText = "";
    } else if (this.state.currentTimeFormat === "hours:minutes:seconds" && this.state.remainingTime >= 60) {
      const hours = Math.floor(this.state.remainingTime / 3600);
      const minutes = Math.floor((this.state.remainingTime % 3600) / 60);
      const seconds = this.state.remainingTime % 60;
      nextText = `${hours > 0 ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    } else {
      nextText = `${this.state.remainingTime}`;
    }

    if (elements.countdownElement.textContent !== nextText) {
      elements.countdownElement.textContent = nextText;
    }
  }

  applyImageEffects() {
    elements.currentImage.classList.toggle("mirror-effect", this.state.isMirrorEnabled);
    elements.currentImage.classList.toggle("grayscale-effect", this.state.isGrayscaleEnabled);
  }

  updateImageDisplay(nextSrc = null) {
    this.applyImageEffects();
    elements.currentImage.onload = null;
    elements.currentImage.onerror = null;

    elements.currentImage.onload = () => {
      if (this.state.isGridEnabled) {
        this.scheduleGridRedraw();
      }
      this.refreshPreviewAppearance();
    };

    elements.currentImage.onerror = () => {
      if (!this.state.isPlaying || !this.state.imageFiles[this.state.currentImageIndex]) {
        return;
      }
      this.showAlert(`无法加载图片：${this.state.imageFiles[this.state.currentImageIndex]?.name || "未知文件"}。已跳过。`, "图片加载错误");
      setTimeout(() => {
        this.advanceImage().catch((error) => {
          console.error("Failed to advance after image load error:", error);
        });
      }, 300);
    };

    if (nextSrc !== null && elements.currentImage.src !== nextSrc) {
      elements.currentImage.src = nextSrc;
      return;
    }

    if (elements.currentImage.complete && elements.currentImage.naturalWidth > 0) {
      elements.currentImage.onload();
    } else {
      this.refreshPreviewAppearance();
    }
  }

  updateNavigationButtons() {
    this.setDisabledIfChanged(elements.prevImageButton, this.state.historyPointer <= 0);
    const currentQueueIndex = this.getCurrentQueueIndex();
    const hasNextInQueue = currentQueueIndex !== -1 && currentQueueIndex + 1 < this.state.currentSessionPlaybackQueue.length;
    this.setDisabledIfChanged(elements.nextImageButton, !hasNextInQueue);
    this.setDisabledIfChanged(
      elements.pausePlayButton,
      this.state.currentSessionPlaybackQueue.length === 0 || (!this.state.isPlaying && elements.countdownElement.textContent === "已经没有下一张"),
    );
  }

  getCurrentQueueIndex() {
    return this.state.currentSessionPlaybackQueue.indexOf(this.state.currentImageIndex);
  }

  getAdaptiveGridStep(width, height) {
    const targetCount = this.normalizeGridCount(this.state.currentGridSize);
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    const gridStepSignature = `${Math.round(safeWidth)}:${Math.round(safeHeight)}:${targetCount}`;

    if (this.lastGridStepSignature === gridStepSignature && this.lastGridStep) {
      return this.lastGridStep;
    }

    const aspectRatio = safeWidth / safeHeight;
    let columns = Math.max(1, Math.round(Math.sqrt(targetCount * aspectRatio)));
    let rows = Math.max(1, Math.ceil(targetCount / columns));

    while ((columns - 1) > 0 && (columns - 1) * rows >= targetCount) {
      columns -= 1;
    }

    while (columns * rows < targetCount) {
      if ((columns / rows) < aspectRatio) {
        columns += 1;
      } else {
        rows += 1;
      }
    }

    const gridStep = {
      x: safeWidth / columns,
      y: safeHeight / rows,
      columns,
      rows,
    };

    this.lastGridStepSignature = gridStepSignature;
    this.lastGridStep = gridStep;

    return gridStep;
  }

  drawGrid() {
    const rect = elements.currentImage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const containerRect = elements.imageDisplayArea.getBoundingClientRect();
    const left = rect.left - containerRect.left;
    const top = rect.top - containerRect.top;
    const dpr = window.devicePixelRatio || 1;

    elements.gridCanvas.style.left = `${left}px`;
    elements.gridCanvas.style.top = `${top}px`;
    elements.gridCanvas.style.width = `${rect.width}px`;
    elements.gridCanvas.style.height = `${rect.height}px`;
    elements.gridCanvas.width = Math.round(rect.width * dpr);
    elements.gridCanvas.height = Math.round(rect.height * dpr);

    if (!this.state.isGridEnabled) {
      this.lastGridRenderSignature = "";
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.clearRect(0, 0, rect.width, rect.height);
      return;
    }

    const gridStep = this.getAdaptiveGridStep(rect.width, rect.height);
    const renderSignature = [
      Math.round(rect.width),
      Math.round(rect.height),
      Math.round(left),
      Math.round(top),
      gridStep.columns,
      gridStep.rows,
      this.state.currentGridColorHex,
      dpr,
    ].join(":");

    if (this.lastGridRenderSignature === renderSignature) {
      return;
    }

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    this.ctx.lineWidth = 1;
    this.ctx.strokeStyle = hexToRgba(this.state.currentGridColorHex, GRID_ALPHA);

    for (let column = 1; column < gridStep.columns; column += 1) {
      const x = gridStep.x * column;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, rect.height);
      this.ctx.stroke();
    }

    for (let row = 1; row < gridStep.rows; row += 1) {
      const y = gridStep.y * row;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(rect.width, y);
      this.ctx.stroke();
    }

    this.lastGridRenderSignature = renderSignature;
  }

  scheduleGridRedraw() {
    if (this.gridRedrawFrame !== null) {
      cancelAnimationFrame(this.gridRedrawFrame);
    }

    this.gridRedrawFrame = window.requestAnimationFrame(() => {
      this.gridRedrawFrame = null;
      this.drawGrid();
    });
  }

  async stopGame() {
    clearInterval(this.state.countdownTimer);
    this.state.isPlaying = false;
    this.state.isPaused = false;
    elements.pausePlayButton.textContent = "⏸";
    elements.currentImage.src = "";
    await this.showMainMenu();
  }

  async selectCurrentBrowserFolder() {
    this.state.mainMenuSelectedFolderPath = this.state.currentLoadedFolderPath;
    await desktop.saveSetting("mainMenuSelectedFolderPath", this.state.mainMenuSelectedFolderPath);
    await this.showMainMenu(this.state.currentLoadedFolderPath);
  }

  async selectNewFolderFromBrowser() {
    const folderPath = await desktop.openFolderDialog(this.state.currentLoadedFolderPath || undefined);
    if (folderPath) {
      await this.showFolderBrowserView(folderPath);
    }
  }

  async goUpFolder() {
    const parent = getParentPath(this.state.currentLoadedFolderPath);
    if (!parent) {
      this.showAlert("已是顶层文件夹。", "提示");
      return;
    }
    await this.showFolderBrowserView(parent);
  }

  setPresetTime(time, activeButton = null) {
    this.state.displayTime = time;
    elements.displayTimeInput.disabled = time === Infinity;
    this.setValueIfChanged(elements.displayTimeInput, time === Infinity ? "" : time);
    this.updatePresetTimeButtons(time, activeButton);
    this.updateMainMenuHintText();
  }

  updatePresetTimeButtons(currentDisplayTimeValue, clickedButton = null) {
    this.presetTimeButtons.forEach((button) => {
      button.classList.remove("active", "disabled-preset");
    });

    if (clickedButton) {
      clickedButton.classList.add("active");
    } else {
      this.presetTimeButtons.forEach((button) => {
        const value = button.id === "presetInfiniteTime" ? Infinity : parseInt(button.textContent, 10);
        button.classList.toggle("active", value === currentDisplayTimeValue);
      });
    }
  }

  handleDisplayTimeInput(value) {
    const nextValue = parseInt(value, 10);
    this.state.displayTime = Number.isNaN(nextValue) ? NaN : nextValue;
    this.updatePresetTimeButtons(this.state.displayTime);
    this.updateMainMenuHintText();
  }

  async toggleRandomPlayback() {
    this.state.isRandomPlayback = !this.state.isRandomPlayback;
    elements.randomPlaybackToggle.classList.toggle("active", this.state.isRandomPlayback);
    await desktop.saveSetting("isRandomPlayback", this.state.isRandomPlayback);
  }

  async togglePlaybackFilter() {
    this.state.isFilterMarkedEnabled = !this.state.isFilterMarkedEnabled;
    elements.filterMarkedToggle.classList.toggle("active", this.state.isFilterMarkedEnabled);
    await desktop.saveSetting("isFilterMarkedEnabled", this.state.isFilterMarkedEnabled);

    if (this.isPlaybackVisible()) {
      await this.stopGame();
    } else {
      await this.showMainMenu();
    }
  }

  async selectMainMenuBackgroundImage() {
    const filePath = await desktop.openFileDialog();
    if (!filePath) {
      return;
    }

    this.state.currentMainMenuBackgroundPath = filePath;
    this.setValueIfChanged(elements.mainMenuBackgroundPathDisplay, filePath);
    await desktop.saveSetting("mainMenuBackgroundPath", filePath);
    if (!this.isPlaybackVisible()) {
      this.updateMainMenuBackground();
    }
  }

  async clearMainMenuBackgroundImage() {
    this.state.currentMainMenuBackgroundPath = "";
    this.setValueIfChanged(elements.mainMenuBackgroundPathDisplay, t("defaultBackgroundImage"));
    await desktop.saveSetting("mainMenuBackgroundPath", "");
    if (!this.isPlaybackVisible()) {
      this.updateMainMenuBackground();
    }
  }

  async selectPreviewBackgroundImage() {
    const filePath = await desktop.openFileDialog();
    if (!filePath) {
      return;
    }

    this.state.currentPreviewBackgroundPath = filePath;
    this.setValueIfChanged(elements.previewBackgroundPathDisplay, filePath);
    await desktop.saveSetting("previewBackgroundPath", filePath);
    if (this.isPlaybackVisible() && this.state.previewBackgroundChoice === "staticImage") {
      this.refreshPreviewAppearance();
    }
  }

  async clearPreviewBackgroundImage() {
    this.state.currentPreviewBackgroundPath = "";
    this.setValueIfChanged(elements.previewBackgroundPathDisplay, "未选择静态图片");
    await desktop.saveSetting("previewBackgroundPath", "");
    if (this.isPlaybackVisible()) {
      this.refreshPreviewAppearance();
    }
  }

  async setDefaultFolder() {
    const folderPath = await desktop.openFolderDialog(this.state.currentDefaultImageFolderPath || undefined);
    if (!folderPath) {
      return;
    }

    this.state.currentDefaultImageFolderPath = folderPath;
    this.state.mainMenuSelectedFolderPath = folderPath;
    this.setValueIfChanged(elements.defaultImageFolderPathDisplay, folderPath);
    await desktop.saveSetting("defaultImageFolderPath", folderPath);
    await desktop.saveSetting("mainMenuSelectedFolderPath", folderPath);
    await this.showMainMenu();
  }

  async clearDefaultFolder() {
    const previousDefault = this.state.currentDefaultImageFolderPath;
    this.state.currentDefaultImageFolderPath = "";
    this.setValueIfChanged(elements.defaultImageFolderPathDisplay, t("notSetDefaultPath"));
    await desktop.saveSetting("defaultImageFolderPath", "");

    if (this.state.mainMenuSelectedFolderPath === previousDefault) {
      this.state.mainMenuSelectedFolderPath = "";
      await desktop.saveSetting("mainMenuSelectedFolderPath", "");
    }

    if (!elements.folderBrowserView.classList.contains("hidden")) {
      await this.showMainMenu();
    }
  }

  setGridColor(hexColor, persist = true) {
    if (this.state.currentGridColorHex === hexColor) {
      return;
    }
    this.state.currentGridColorHex = hexColor;
    this.ctx.strokeStyle = hexToRgba(hexColor, GRID_ALPHA);
    if (persist) {
      desktop.saveSetting("gridColor", hexColor);
    }
    if (this.state.isGridEnabled && this.isPlaybackVisible()) {
      this.scheduleGridRedraw();
    }
  }

  handleGridSizeInput(value) {
    this.setGridSize(value);
  }

  setGridSize(size, persist = true) {
    const normalizedSize = this.normalizeGridCount(size);
    if (this.state.currentGridSize === normalizedSize) {
      this.setValueIfChanged(elements.gridSizeInput, normalizedSize);
      return;
    }
    this.state.currentGridSize = normalizedSize;
    this.setValueIfChanged(elements.gridSizeInput, this.state.currentGridSize);
    if (persist) {
      desktop.saveSetting("gridSize", this.state.currentGridSize);
    }
    if (this.state.isGridEnabled && this.isPlaybackVisible()) {
      this.scheduleGridRedraw();
    }
  }

  resetGridSettings() {
    elements.gridColorPicker.value = DEFAULTS.gridColor;
    this.setValueIfChanged(elements.gridSizeInput, DEFAULTS.gridSize);
    this.setGridColor(DEFAULTS.gridColor);
    this.setGridSize(DEFAULTS.gridSize);
  }

  setTimeFormat(format, persist = true) {
    if (this.state.currentTimeFormat === format) {
      return;
    }
    this.state.currentTimeFormat = format;
    if (persist) {
      desktop.saveSetting("timeFormat", format);
    }
    this.updateCountdownDisplay();
  }

  toggleMirrorEffect() {
    this.state.isMirrorEnabled = !this.state.isMirrorEnabled;
    this.applyImageEffects();
    elements.mirrorToggle.classList.toggle("active", this.state.isMirrorEnabled);
    elements.overlayMirrorToggle.classList.toggle("active", this.state.isMirrorEnabled);
  }

  toggleGrayscaleEffect() {
    this.state.isGrayscaleEnabled = !this.state.isGrayscaleEnabled;
    this.applyImageEffects();
    elements.grayscaleToggle.classList.toggle("active", this.state.isGrayscaleEnabled);
    elements.overlayGrayscaleToggle.classList.toggle("active", this.state.isGrayscaleEnabled);
    this.updatePreviewBackgroundGrayscaleEffect();
  }

  toggleGridEffect() {
    this.state.isGridEnabled = !this.state.isGridEnabled;
    elements.gridCanvas.classList.toggle("active", this.state.isGridEnabled);
    elements.gridToggle.classList.toggle("active", this.state.isGridEnabled);
    elements.overlayGridToggle.classList.toggle("active", this.state.isGridEnabled);
    if (this.state.isGridEnabled) {
      this.scheduleGridRedraw();
    } else {
      this.lastGridRenderSignature = "";
      this.ctx.clearRect(0, 0, elements.gridCanvas.width, elements.gridCanvas.height);
    }
  }

  async toggleAlwaysOnTop() {
    this.state.isAlwaysOnTop = !this.state.isAlwaysOnTop;
    const result = await desktop.setAlwaysOnTop(this.state.isAlwaysOnTop);
    this.state.isAlwaysOnTop = result?.alwaysOnTop ?? this.state.isAlwaysOnTop;
    await desktop.saveSetting("isAlwaysOnTop", this.state.isAlwaysOnTop);
    elements.mainMenuAlwaysOnTopToggle.classList.toggle("active", this.state.isAlwaysOnTop);
    elements.toggleAlwaysOnTopButton.classList.toggle("active", this.state.isAlwaysOnTop);
  }

  async openCurrentFileInFinder() {
    const file = this.state.imageFiles[this.state.currentImageIndex];
    if (!file) {
      this.showAlert("当前没有可打开的图片。", "提示");
      return;
    }
    const result = await desktop.openFileInFinder(file.path);
    if (!result.success) {
      this.showAlert(result.message || "无法在文件夹中定位图片。", "错误");
    }
  }

  async toggleCurrentImageMark() {
    const file = this.state.imageFiles[this.state.currentImageIndex];
    if (!file) {
      this.showAlert("无法操作标记。请先开始速写。", "操作失败");
      return;
    }

    const marks = this.state.imageMarks[file.path];
    if (Array.isArray(marks) && marks.length > 0) {
      await desktop.clearImageMarksForPath(file.path);
    } else {
      await desktop.saveImageMark(file.path, this.state.displayTime === Infinity ? 0 : this.state.displayTime);
    }

    this.state.imageMarks = await desktop.getImageMarks();
    this.updateMarkingUI();
    this.refreshMainMenuEligibilityState();

    if (!elements.folderBrowserView.classList.contains("hidden")) {
      await this.showFolderBrowserView(this.state.currentLoadedFolderPath);
    }
  }

  updateMarkingUI() {
    const file = this.state.imageFiles[this.state.currentImageIndex];
    if (!file) {
      elements.markStarButton.classList.remove("active");
      elements.markStarButton.setAttribute("data-tooltip", t("unmarked"));
      return;
    }

    const marks = this.state.imageMarks[file.path];
    if (!Array.isArray(marks) || marks.length === 0) {
      elements.markStarButton.classList.remove("active");
      elements.markStarButton.setAttribute("data-tooltip", t("unmarked"));
      return;
    }

    const latestMark = this.getLatestMark(marks);
    const date = new Date(latestMark.timestamp);
    const month = `${date.getMonth() + 1}`.padStart(2, "0");
    const day = `${date.getDate()}`.padStart(2, "0");
    const duration = latestMark.duration === 0 ? "∞" : `${latestMark.duration}s`;
    elements.markStarButton.classList.add("active");
    elements.markStarButton.setAttribute("data-tooltip", `${month}/${day} (${duration})`);
  }

  getTotalFolderPages() {
    return Math.max(1, Math.ceil(this.state.currentFolderItems.length / ITEMS_PER_PAGE));
  }

  async toggleLibraryFilter() {
    this.state.isLibraryFilterMarkedEnabled = !this.state.isLibraryFilterMarkedEnabled;
    elements.libraryFilterMarkedToggle.classList.toggle("active", this.state.isLibraryFilterMarkedEnabled);
    await desktop.saveSetting("isLibraryFilterMarkedEnabled", this.state.isLibraryFilterMarkedEnabled);
    await this.showFolderBrowserView(this.state.currentLoadedFolderPath);
  }
}
