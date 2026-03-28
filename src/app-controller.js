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
    this.gridRedrawFrame = null;
    this.lastGridRenderSignature = "";
    this.lastGridStepSignature = "";
    this.lastGridStep = null;
    this.thumbnailRenderVersion = 0;
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
      imageCount: Infinity,
      countdownTimer: null,
      countdownAdvanceTimeout: null,
      lowTimeAlertTimeout: null,
      hasLowTimeAlertShown: false,
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
      latestMarksByPath: {},
      currentMainMenuBackgroundPath: "",
      currentPreviewBackgroundPath: "",
      currentGridColorHex: DEFAULTS.gridColor,
      currentGridSize: DEFAULTS.gridSize,
      currentTimeFormat: DEFAULTS.timeFormat,
      currentCountdownStyle: DEFAULTS.countdownStyle,
      currentCountdownDisplayStyle: "hms",
      currentTrafficLightVisibility: null,
      currentFolderItems: [],
      currentPage: 0,
      currentLanguage: "zh-CN",
      eligibleImageRawIndexes: [],
      ...createEmptyHistory(),
    };
  }

  async init() {
    this.platform = await desktop.getPlatform();
    this.bindEvents();
    await this.loadSettings();
    await this.bootstrapInitialView();
    this.syncToggleButtons();
    this.syncDisplayTimeInput();
    this.syncImageCountInput();
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
    elements.displayTimeInput.addEventListener("focus", () => this.openDisplayTimeDropdown());
    elements.displayTimeInput.addEventListener("click", () => this.openDisplayTimeDropdown());
    elements.displayTimeInput.addEventListener("change", (event) => this.handleDisplayTimeCommit(event.target.value));
    elements.displayTimeInput.addEventListener("blur", (event) => this.handleDisplayTimeCommit(event.target.value));
    elements.imageCountInput.addEventListener("input", (event) => this.handleImageCountInput(event.target.value));
    elements.imageCountInput.addEventListener("focus", () => this.openImageCountDropdown());
    elements.imageCountInput.addEventListener("click", () => this.openImageCountDropdown());
    elements.imageCountInput.addEventListener("change", (event) => this.handleImageCountCommit(event.target.value));
    elements.imageCountInput.addEventListener("blur", (event) => this.handleImageCountCommit(event.target.value));
    groups.imageCountDropdownOptions.forEach((option) => {
      option.addEventListener("mousedown", (event) => this.handleImageCountDropdownSelect(event));
    });
    groups.displayTimeDropdownOptions.forEach((option) => {
      option.addEventListener("mousedown", (event) => this.handleDisplayTimeDropdownSelect(event));
    });
    document.addEventListener("pointerdown", (event) => this.handleGlobalPointerDown(event), true);
    document.addEventListener("keydown", (event) => this.handleGlobalKeyDown(event));
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

    groups.countdownVisibilityRadios.forEach((radio) => {
      radio.addEventListener("change", async (event) => {
        this.state.isCountdownHidden = event.target.value === "hide";
        await desktop.saveSetting("isCountdownHidden", this.state.isCountdownHidden);
        this.updateCountdownDisplay();
      });
    });

    groups.countdownDisplayStyleRadios.forEach((radio) => {
      radio.addEventListener("change", async (event) => {
        await this.applyCountdownDisplayStyle(event.target.value, true);
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
      "countdownStyle",
      "countdownDisplayStyle",
      "isCountdownHidden",
      "defaultImageFolderPath",
      "mainMenuSelectedFolderPath",
      "isRandomPlayback",
      "isFilterMarkedEnabled",
      "isLibraryFilterMarkedEnabled",
      "isAlwaysOnTop",
      "startupMode",
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
    this.state.isCountdownHidden = values.isCountdownHidden ?? DEFAULTS.isCountdownHidden;
    this.state.currentDefaultImageFolderPath = values.defaultImageFolderPath || DEFAULTS.defaultImageFolderPath;
    this.state.mainMenuSelectedFolderPath = values.mainMenuSelectedFolderPath || DEFAULTS.mainMenuSelectedFolderPath;
    this.state.isRandomPlayback = values.isRandomPlayback ?? DEFAULTS.isRandomPlayback;
    this.state.isFilterMarkedEnabled = values.isFilterMarkedEnabled ?? DEFAULTS.isFilterMarkedEnabled;
    this.state.isLibraryFilterMarkedEnabled = values.isLibraryFilterMarkedEnabled ?? DEFAULTS.isLibraryFilterMarkedEnabled;
    this.state.isAlwaysOnTop = values.isAlwaysOnTop ?? DEFAULTS.isAlwaysOnTop;
    this.state.startupMode = values.startupMode ?? DEFAULTS.startupMode;
    this.state.currentLanguage = values.language || DEFAULTS.language;

    this.applyLanguage(this.state.currentLanguage);
    this.applyTheme(this.state.isLightThemeEnabled, false);
    this.setGridColor(this.state.currentGridColorHex, false);
    this.setGridSize(this.state.currentGridSize, false);

    const normalizedLegacyTimeFormat = values.timeFormat === "minutes:seconds" ? DEFAULTS.timeFormat : (values.timeFormat || DEFAULTS.timeFormat);
    const normalizedLegacyCountdownStyle = values.countdownStyle === "progressBar" ? "progressBar" : DEFAULTS.countdownStyle;
    const countdownDisplayStyle = values.countdownDisplayStyle
      || (normalizedLegacyCountdownStyle === "progressBar"
        ? "progressBar"
        : (normalizedLegacyTimeFormat === "seconds" ? "seconds" : "hms"));
    await this.applyCountdownDisplayStyle(countdownDisplayStyle, false);

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
    groups.countdownVisibilityRadios.forEach((radio) => {
      radio.checked = (radio.value === "hide") === this.state.isCountdownHidden;
    });
    groups.countdownDisplayStyleRadios.forEach((radio) => {
      radio.checked = radio.value === this.state.currentCountdownDisplayStyle;
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

  clearCountdownAdvanceTimeout() {
    if (this.state.countdownAdvanceTimeout !== null) {
      clearTimeout(this.state.countdownAdvanceTimeout);
      this.state.countdownAdvanceTimeout = null;
    }
  }

  clearLowTimeAlert() {
    if (this.state.lowTimeAlertTimeout !== null) {
      clearTimeout(this.state.lowTimeAlertTimeout);
      this.state.lowTimeAlertTimeout = null;
    }
    elements.countdownElement.classList.remove("low-alert");
    elements.countdownProgressTrack.classList.remove("low-alert");
  }

  triggerLowTimeAlert() {
    this.clearLowTimeAlert();
    elements.countdownElement.classList.add("low-alert");
    elements.countdownProgressTrack.classList.add("low-alert");
    this.state.lowTimeAlertTimeout = window.setTimeout(() => {
      elements.countdownElement.classList.remove("low-alert");
      elements.countdownProgressTrack.classList.remove("low-alert");
      this.state.lowTimeAlertTimeout = null;
    }, 1300);
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
    this.syncDisplayTimeInput();
    this.syncImageCountInput();
    const allOption = elements.imageCountDropdown?.querySelector('[data-count-value="all"]');
    if (allOption) {
      allOption.textContent = t("allOption");
    }

    this.refreshMainMenuEligibilityState();
    this.updateMarkingUI();
  }

  syncImageCountInput() {
    this.setValueIfChanged(elements.imageCountInput, this.state.imageCount === Infinity ? t("allOption") : this.state.imageCount);
  }

  syncDisplayTimeInput() {
    this.setValueIfChanged(elements.displayTimeInput, this.state.displayTime === Infinity ? t("infiniteTime") : this.state.displayTime);
  }

  openDisplayTimeDropdown() {
    this.closeImageCountDropdown();
    elements.displayTimeDropdown?.classList.remove("hidden");
  }

  closeDisplayTimeDropdown() {
    elements.displayTimeDropdown?.classList.add("hidden");
  }

  toggleDisplayTimeDropdown() {
    if (elements.displayTimeDropdown?.classList.contains("hidden")) {
      this.openDisplayTimeDropdown();
      return;
    }
    this.closeDisplayTimeDropdown();
  }

  openImageCountDropdown() {
    this.closeDisplayTimeDropdown();
    elements.imageCountDropdown?.classList.remove("hidden");
  }

  closeImageCountDropdown() {
    elements.imageCountDropdown?.classList.add("hidden");
  }

  toggleImageCountDropdown() {
    if (elements.imageCountDropdown?.classList.contains("hidden")) {
      this.openImageCountDropdown();
      return;
    }
    this.closeImageCountDropdown();
  }

  handleImageCountDropdownSelect(event) {
    event.preventDefault();
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const value = target.dataset.countValue;
    if (value === "all") {
      this.state.imageCount = Infinity;
      this.syncImageCountInput();
      this.updateMainMenuHintText();
      this.closeImageCountDropdown();
      return;
    }

    this.setValueIfChanged(elements.imageCountInput, value || "");
    this.handleImageCountInput(value || "");
    this.handleImageCountCommit(value || "");
    this.closeImageCountDropdown();
  }

  handleDisplayTimeDropdownSelect(event) {
    event.preventDefault();
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const value = target.dataset.timeValue;
    if (!value) {
      return;
    }

    if (value === "infinite") {
      this.state.displayTime = Infinity;
      this.syncDisplayTimeInput();
      this.updateMainMenuHintText();
      this.closeDisplayTimeDropdown();
      return;
    }

    this.setValueIfChanged(elements.displayTimeInput, value);
    this.handleDisplayTimeInput(value);
    this.handleDisplayTimeCommit(value);
    this.closeDisplayTimeDropdown();
  }

  handleGlobalPointerDown(event) {
    if (!(event.target instanceof Node)) {
      return;
    }

    const displayWrapper = elements.displayTimeInputWrapper;
    if (displayWrapper && displayWrapper.contains(event.target)) {
      return;
    }

    const countWrapper = elements.imageCountInputWrapper;
    if (countWrapper && countWrapper.contains(event.target)) {
      return;
    }

    this.handleDisplayTimeCommit(elements.displayTimeInput.value);
    this.closeDisplayTimeDropdown();
    this.handleImageCountCommit(elements.imageCountInput.value);
    this.closeImageCountDropdown();
  }

  handleGlobalKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }
    this.closeDisplayTimeDropdown();
    this.closeImageCountDropdown();
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

  async handleDroppedPaths(paths) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return;
    }

    let folderPath = "";
    for (const path of paths) {
      if (await desktop.isDirectory(path)) {
        folderPath = path;
        break;
      }
    }

    if (!folderPath) {
      this.showAlert("请拖入文件夹。", "提示");
      return;
    }

    try {
      this.state.mainMenuSelectedFolderPath = folderPath;
      await desktop.saveSetting("mainMenuSelectedFolderPath", folderPath);
      await this.loadImagesForSketchFolder(folderPath);
      await this.showFolderBrowserView(folderPath);
    } catch (error) {
      console.error(error);
      this.showAlert("拖入的文件夹无法读取，请检查权限后重试。", "加载错误");
    }
  }

  async loadImagesForSketchFolder(folderPath) {
    const items = await desktop.readFolderImages(folderPath);
    const imageFiles = items.filter((item) => item.type === "file").sort(naturalSort);
    this.state.imageFiles = imageFiles.map((file) => ({ name: file.name, path: file.originalPath }));
    this.state.imageUrls = imageFiles.map((file) => file.path);
    await this.recalculateEligibilityFromBackend();
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
        this.state.eligibleImageRawIndexes = [];
        this.state.mainMenuSelectedFolderPath = "";
        this.setTextContentIfChanged(elements.sketchFolderInputDisplay, "无法加载，请重新选择...");
        this.showAlert("无法加载当前文件夹。请重新选择。", "错误");
      }
    } else {
      this.state.imageFiles = [];
      this.state.imageUrls = [];
      this.state.eligibleImageRawIndexes = [];
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

  async recalculateEligibilityFromBackend() {
    if (!Array.isArray(this.state.imageFiles) || this.state.imageFiles.length === 0) {
      this.state.eligibleImageRawIndexes = [];
      this.refreshMainMenuEligibilityState();
      return;
    }

    try {
      const result = await desktop.buildPlaybackPlan(
        this.state.imageFiles.map((file) => file.path),
        this.state.isFilterMarkedEnabled,
        false,
        null,
      );
      this.state.eligibleImageRawIndexes = Array.isArray(result?.eligibleIndexes)
        ? result.eligibleIndexes
        : [];
    } catch (error) {
      console.error("Failed to recalculate eligible images via Rust backend:", error);
      this.state.eligibleImageRawIndexes = [];
    }

    this.refreshMainMenuEligibilityState();
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

  mergeLatestMarks(latestMarks) {
    if (!latestMarks || typeof latestMarks !== "object") {
      return;
    }
    this.state.latestMarksByPath = {
      ...this.state.latestMarksByPath,
      ...latestMarks,
    };
  }

  cacheLatestMarksForPaths(paths, latestMarks) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return;
    }
    const next = { ...this.state.latestMarksByPath };
    for (const path of paths) {
      next[path] = latestMarks?.[path] ?? null;
    }
    this.state.latestMarksByPath = next;
  }

  async renderCurrentPageThumbnails() {
    const renderVersion = ++this.thumbnailRenderVersion;
    elements.thumbnailsGridContainer.innerHTML = "";
    elements.folderBrowserInfoMessage.classList.add("hidden");
    const fragment = document.createDocumentFragment();

    const startIndex = this.state.currentPage * ITEMS_PER_PAGE;
    const itemsToDisplay = this.state.currentFolderItems.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    const directoryThumbnailByPath = new Map();
    const fileThumbnailByPath = new Map();

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
        directoryThumbnailByPath.set(item.path, thumbnailItem);
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

        fileThumbnailByPath.set(item.originalPath, { item, thumbnailItem });

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

    if (directoryThumbnailByPath.size === 0 && fileThumbnailByPath.size === 0) {
      return;
    }

    const directoryPaths = [...directoryThumbnailByPath.keys()];
    const filePaths = [...fileThumbnailByPath.keys()];
    const [folderCompletionStates, latestMarks] = await Promise.all([
      directoryPaths.length > 0 ? desktop.getFolderCompletionStates(directoryPaths) : Promise.resolve({}),
      filePaths.length > 0 ? desktop.getLatestMarksForPaths(filePaths) : Promise.resolve({}),
    ]);
    this.cacheLatestMarksForPaths(filePaths, latestMarks);

    if (renderVersion !== this.thumbnailRenderVersion) {
      return;
    }

    for (const [folderPath, thumbnailItem] of directoryThumbnailByPath.entries()) {
      if (!folderCompletionStates.get(folderPath)) {
        continue;
      }
      if (thumbnailItem.querySelector(".thumbnail-folder-completed-info")) {
        continue;
      }
      const completedInfo = document.createElement("div");
      completedInfo.classList.add("thumbnail-folder-completed-info");
      completedInfo.textContent = "已完成";
      thumbnailItem.appendChild(completedInfo);
    }

    for (const [filePath, { item, thumbnailItem }] of fileThumbnailByPath.entries()) {
      const latestMark = latestMarks[filePath];
      if (!latestMark) {
        continue;
      }

      const info = this.createThumbnailMarkInfo(item, latestMark);
      thumbnailItem.appendChild(info);
      info.querySelector(".delete-mark-button").addEventListener("click", async (event) => {
        event.stopPropagation();
        const path = event.target.dataset.path;
        await desktop.clearImageMarksForPath(path);
        this.cacheLatestMarksForPaths([path], {});
        await this.recalculateEligibilityFromBackend();
        info.remove();
        this.updateMarkingUI();
      });
    }
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
      const filePaths = files.map((file) => file.originalPath);
      const latestMarks = filePaths.length > 0
        ? await desktop.getLatestMarksForPaths(filePaths)
        : {};
      this.cacheLatestMarksForPaths(filePaths, latestMarks);

      if (this.state.isLibraryFilterMarkedEnabled) {
        files = files.filter((file) => !latestMarks[file.originalPath]);
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
    return this.state.eligibleImageRawIndexes;
  }

  getEligibleImageCount() {
    return this.getEligibleImageRawIndexes().length;
  }

  getTargetSketchCount(eligibleCount = this.getEligibleImageCount()) {
    if (this.state.imageCount === Infinity) {
      return eligibleCount;
    }
    if (Number.isNaN(this.state.imageCount) || this.state.imageCount <= 0) {
      return NaN;
    }
    return Math.min(eligibleCount, this.state.imageCount);
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
    const targetCount = this.getTargetSketchCount(eligibleCount);

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

    if (Number.isNaN(targetCount) || targetCount <= 0) {
      this.setTextContentIfChanged(elements.mainMenuHintText, `${t("totalImagesSelected")}${eligibleCount}${t("imagesPleaseSelectCount")}`);
      return;
    }

    if (this.state.displayTime === Infinity) {
      this.setTextContentIfChanged(elements.mainMenuHintText, `${t("totalImagesSelected")}${targetCount}${t("imagesTimeSetToUnlimited")}`);
      return;
    }

    if (Number.isNaN(this.state.displayTime) || this.state.displayTime <= 0) {
      this.setTextContentIfChanged(elements.mainMenuHintText, `${t("totalImagesSelected")}${targetCount}${t("imagesPleaseSelectTime")}`);
      return;
    }

    const estimated = formatTimeForHint(targetCount * this.state.displayTime);
    this.setTextContentIfChanged(elements.mainMenuHintText, `${t("estimatedTime")}${targetCount}${t("estimated")}${estimated}`);
  }

  async initiateSketchSession() {
    if (elements.startButton.disabled) {
      return;
    }

    if (this.state.displayTime !== Infinity && (Number.isNaN(this.state.displayTime) || this.state.displayTime <= 0)) {
      this.showAlert(t("pleaseSetValidDisplayTime"), t("timeSettingError"));
      return;
    }

    if (this.state.imageCount !== Infinity && (Number.isNaN(this.state.imageCount) || this.state.imageCount <= 0)) {
      this.showAlert(t("pleaseSetValidImageCount"), t("countSettingError"));
      return;
    }

    const eligibleIndexes = this.getEligibleImageRawIndexes();
    if (eligibleIndexes.length === 0) {
      return;
    }

    const imageCount = Number.isFinite(this.state.imageCount) ? this.state.imageCount : null;
    try {
      const result = await desktop.buildPlaybackPlan(
        this.state.imageFiles.map((file) => file.path),
        this.state.isFilterMarkedEnabled,
        this.state.isRandomPlayback,
        imageCount,
      );

      this.state.eligibleImageRawIndexes = Array.isArray(result?.eligibleIndexes)
        ? result.eligibleIndexes
        : eligibleIndexes;
      this.state.currentSessionPlaybackQueue = Array.isArray(result?.playbackQueue)
        ? result.playbackQueue
        : [];
    } catch (error) {
      console.error("Failed to build playback queue via Rust backend:", error);
      const queue = this.state.isRandomPlayback ? shuffleArray(eligibleIndexes) : [...eligibleIndexes];
      const targetCount = this.getTargetSketchCount(eligibleIndexes.length);
      this.state.currentSessionPlaybackQueue = queue.slice(0, targetCount);
    }

    if (this.state.currentSessionPlaybackQueue.length === 0) {
      return;
    }

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
    this.clearCountdownAdvanceTimeout();
    this.clearLowTimeAlert();
    this.state.hasLowTimeAlertShown = false;

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
    this.clearCountdownAdvanceTimeout();
    this.clearLowTimeAlert();
    this.state.isPlaying = false;
    this.state.isPaused = true;
    this.state.remainingTime = 0;
    elements.pausePlayButton.textContent = "▶";
    if (this.state.currentCountdownStyle === "text") {
      elements.countdownElement.textContent = "已经没有下一张";
    }
    this.updateCountdownDisplay();
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
    this.clearCountdownAdvanceTimeout();
    this.clearLowTimeAlert();
    this.state.hasLowTimeAlertShown = false;
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
      this.clearCountdownAdvanceTimeout();
      this.clearLowTimeAlert();
    } else {
      this.startCountdown();
    }
    this.updateNavigationButtons();
  }

  startCountdown() {
    clearInterval(this.state.countdownTimer);
    this.clearCountdownAdvanceTimeout();
    this.clearLowTimeAlert();
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
      const imageIndexAtZero = this.state.currentImageIndex;
      const shouldWaitProgressFinish = !this.state.isCountdownHidden && this.state.currentCountdownStyle === "progressBar";
      const finalizeAndAdvance = async () => {
        if (!this.state.isPlaying || this.state.currentImageIndex !== imageIndexAtZero) {
          return;
        }
        const currentFile = this.state.imageFiles[this.state.currentImageIndex];
        if (currentFile) {
          await desktop.saveImageMark(currentFile.path, this.state.displayTime);
          const latestMark = await desktop.getLatestMarksForPaths([currentFile.path]);
          this.cacheLatestMarksForPaths([currentFile.path], latestMark);
          await this.recalculateEligibilityFromBackend();
        }
        await this.advanceImage();
      };

      if (!shouldWaitProgressFinish) {
        await finalizeAndAdvance();
        return;
      }

      this.state.countdownAdvanceTimeout = window.setTimeout(() => {
        this.state.countdownAdvanceTimeout = null;
        finalizeAndAdvance().catch((error) => {
          console.error("Failed to advance after countdown progress completion:", error);
        });
      }, 1000);
    }, 1000);
  }

  updateCountdownDisplay() {
    const canCountdown = !this.state.isCountdownHidden && this.state.displayTime !== Infinity;
    const showProgressBar = canCountdown && this.state.currentCountdownStyle === "progressBar";
    const showText = canCountdown && !showProgressBar;

    elements.countdownElement.style.display = showText ? "block" : "none";
    elements.countdownProgressTrack.style.display = showProgressBar ? "block" : "none";

    if (showText) {
      let nextText = "";
      if (this.state.currentTimeFormat === "hours:minutes:seconds" && this.state.remainingTime >= 60) {
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
    } else if (elements.countdownElement.textContent) {
      elements.countdownElement.textContent = "";
    }

    if (!canCountdown) {
      elements.countdownElement.classList.remove("low-time");
    }

    const ratio = canCountdown
      ? Math.max(0, Math.min(1, this.state.remainingTime / this.state.displayTime))
      : 1;
    elements.countdownElement.classList.toggle("low-time", showText && ratio <= 0.2);
    if (canCountdown && ratio <= 0.2 && !this.state.hasLowTimeAlertShown) {
      this.triggerLowTimeAlert();
      this.state.hasLowTimeAlertShown = true;
    } else if (!canCountdown || ratio > 0.2) {
      this.state.hasLowTimeAlertShown = false;
    }

    if (!showProgressBar) {
      elements.countdownProgressFill.style.width = "0%";
      elements.countdownProgressFill.classList.remove("low-time");
      return;
    }

    elements.countdownProgressFill.classList.toggle("low-time", ratio <= 0.2);
    const isSessionStartOfImage = this.state.remainingTime === this.state.displayTime;
    if (isSessionStartOfImage) {
      elements.countdownProgressFill.classList.add("instant");
      elements.countdownProgressFill.style.width = `${ratio * 100}%`;
      void elements.countdownProgressFill.offsetWidth;
      elements.countdownProgressFill.classList.remove("instant");
      return;
    }

    elements.countdownProgressFill.style.width = `${ratio * 100}%`;
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
      this.state.currentSessionPlaybackQueue.length === 0 || !this.state.isPlaying,
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
    const targetCanvasWidth = Math.round(rect.width * dpr);
    const targetCanvasHeight = Math.round(rect.height * dpr);

    const renderSignature = [
      Math.round(rect.width),
      Math.round(rect.height),
      Math.round(left),
      Math.round(top),
      this.state.currentGridColorHex,
      dpr,
      this.state.currentGridSize,
      this.state.isGridEnabled,
    ].join(":");

    if (this.lastGridRenderSignature === renderSignature) {
      return;
    }

    if (elements.gridCanvas.style.left !== `${left}px`) {
      elements.gridCanvas.style.left = `${left}px`;
    }
    if (elements.gridCanvas.style.top !== `${top}px`) {
      elements.gridCanvas.style.top = `${top}px`;
    }
    if (elements.gridCanvas.style.width !== `${rect.width}px`) {
      elements.gridCanvas.style.width = `${rect.width}px`;
    }
    if (elements.gridCanvas.style.height !== `${rect.height}px`) {
      elements.gridCanvas.style.height = `${rect.height}px`;
    }
    if (elements.gridCanvas.width !== targetCanvasWidth) {
      elements.gridCanvas.width = targetCanvasWidth;
    }
    if (elements.gridCanvas.height !== targetCanvasHeight) {
      elements.gridCanvas.height = targetCanvasHeight;
    }

    if (!this.state.isGridEnabled) {
      this.lastGridRenderSignature = renderSignature;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.clearRect(0, 0, rect.width, rect.height);
      return;
    }

    const gridStep = this.getAdaptiveGridStep(rect.width, rect.height);
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
    this.clearCountdownAdvanceTimeout();
    this.clearLowTimeAlert();
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

  handleDisplayTimeInput(value) {
    const normalized = `${value ?? ""}`.trim();
    const lowered = normalized.toLowerCase?.() ?? normalized;
    const infiniteKeywords = new Set([t("infiniteTime"), "∞", "♾️", "infinite", "unlimited"]);

    if (infiniteKeywords.has(normalized) || infiniteKeywords.has(lowered)) {
      this.state.displayTime = Infinity;
      this.updateMainMenuHintText();
      return;
    }

    if (normalized === "") {
      this.state.displayTime = NaN;
      this.updateMainMenuHintText();
      return;
    }

    const nextValue = parseInt(normalized, 10);
    this.state.displayTime = Number.isNaN(nextValue) ? NaN : nextValue;
    this.updateMainMenuHintText();
  }

  handleDisplayTimeCommit(value) {
    const normalized = `${value ?? ""}`.trim();
    if (normalized === "") {
      return;
    }

    if (this.state.displayTime === Infinity) {
      this.syncDisplayTimeInput();
      return;
    }

    if (Number.isNaN(this.state.displayTime) || this.state.displayTime <= 0) {
      return;
    }

    this.syncDisplayTimeInput();
  }

  handleImageCountInput(value) {
    const normalized = `${value ?? ""}`.trim();
    const allKeywords = new Set([t("allOption"), "全部", "all", "すべて"]);

    if (allKeywords.has(normalized.toLowerCase?.() ? normalized.toLowerCase() : normalized) || allKeywords.has(normalized)) {
      this.state.imageCount = Infinity;
      this.updateMainMenuHintText();
      return;
    }

    if (normalized === "") {
      this.state.imageCount = NaN;
      this.updateMainMenuHintText();
      return;
    }

    const nextValue = parseInt(normalized, 10);
    this.state.imageCount = Number.isNaN(nextValue) ? NaN : nextValue;
    this.updateMainMenuHintText();
  }

  handleImageCountCommit(value) {
    const normalized = `${value ?? ""}`.trim();
    if (normalized === "") {
      this.state.imageCount = Infinity;
      this.syncImageCountInput();
      this.updateMainMenuHintText();
      return;
    }

    if (this.state.imageCount === Infinity) {
      this.syncImageCountInput();
    }
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
    await this.recalculateEligibilityFromBackend();

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

  async applyCountdownDisplayStyle(style, persist = true) {
    const normalizedStyle = style === "seconds" || style === "progressBar" ? style : "hms";
    this.state.currentCountdownDisplayStyle = normalizedStyle;
    this.state.currentCountdownStyle = normalizedStyle === "progressBar" ? "progressBar" : "text";
    this.state.currentTimeFormat = normalizedStyle === "seconds" ? "seconds" : "hours:minutes:seconds";

    if (persist) {
      await desktop.saveSetting("countdownDisplayStyle", normalizedStyle);
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

    const latestMarkMap = await desktop.getLatestMarksForPaths([file.path]);
    if (latestMarkMap[file.path]) {
      await desktop.clearImageMarksForPath(file.path);
      this.cacheLatestMarksForPaths([file.path], {});
    } else {
      await desktop.saveImageMark(file.path, this.state.displayTime === Infinity ? 0 : this.state.displayTime);
      const refreshedLatest = await desktop.getLatestMarksForPaths([file.path]);
      this.cacheLatestMarksForPaths([file.path], refreshedLatest);
    }

    this.updateMarkingUI();
    await this.recalculateEligibilityFromBackend();

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

    if (!(file.path in this.state.latestMarksByPath)) {
      desktop.getLatestMarksForPaths([file.path]).then((latestMarkMap) => {
        this.cacheLatestMarksForPaths([file.path], latestMarkMap);
        const currentFile = this.state.imageFiles[this.state.currentImageIndex];
        if (currentFile?.path === file.path) {
          this.updateMarkingUI();
        }
      }).catch((error) => {
        console.error("Failed to load latest mark for current image:", error);
      });
      elements.markStarButton.classList.remove("active");
      elements.markStarButton.setAttribute("data-tooltip", t("unmarked"));
      return;
    }

    const latestMark = this.state.latestMarksByPath[file.path];
    if (!latestMark) {
      elements.markStarButton.classList.remove("active");
      elements.markStarButton.setAttribute("data-tooltip", t("unmarked"));
      return;
    }
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
