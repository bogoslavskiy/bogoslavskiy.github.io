import {
  LOGO_KEYBOARD_LARGE_STEP,
  LOGO_KEYBOARD_STEP,
  clampLogoCenterY,
  pointHitsLogo,
  pointerToCanvasPoint,
} from "./logo-drag.js";

const CONFIG_URL = "/data/menu-access-card-config.json";
const OUTPUT_ROOT = "/data/generated/menu-access-cards-v1";
const PIXELS_PER_METER_300_DPI = 11811;
const PREVIEW_SCALE = 0.8;
const FALLBACK_LOGO_POSITION = "bottom";
const LOGO_POSITION_STORAGE_PREFIX = "sigmela-menu-card-logo-position-v2:";
const LOGO_CENTER_Y_STORAGE_PREFIX = "sigmela-menu-card-logo-center-y-v1:";
const LOGO_POSITION_OPTIONS = [
  { value: "bottom", label: "Снизу" },
  { value: "center", label: "По центру" },
  { value: "under_headline", label: "Под «МЕНЮ»" },
];

const cardsList = document.querySelector("#cards-list");
const companySearch = document.querySelector("#company-search");
const searchResults = document.querySelector("#search-results");
const searchEmpty = document.querySelector("#search-empty");
const guidesToggle = document.querySelector("#guides-toggle");
const statusText = document.querySelector("#status-text");
const statusDot = document.querySelector("#status-dot");

let cardConfig;
let companies = [];
let renderVersion = 0;
const cardViews = new Map();

function setStatus(message, state = "loading") {
  statusText.textContent = message;
  statusDot.className = `status-dot ${state === "loading" ? "" : state}`;
}

function normalizeSearchValue(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[^a-zа-я0-9]+/gi, "");
}

function applyCompanySearch() {
  const query = normalizeSearchValue(companySearch.value);
  let visibleCompanies = 0;

  for (const company of companies) {
    const view = cardViews.get(company.shortname);
    const searchableName = normalizeSearchValue(
      `${company.name} ${company.shortname}`,
    );
    const isVisible = query.length === 0 || searchableName.includes(query);
    view.article.hidden = !isVisible;
    if (isVisible) visibleCompanies += 1;
  }

  searchResults.textContent = query
    ? `Найдено: ${visibleCompanies} из ${companies.length}`
    : `${companies.length} компаний`;
  searchEmpty.hidden = visibleCompanies !== 0;
}

function logoPositionStorageKey(company) {
  return `${LOGO_POSITION_STORAGE_PREFIX}${company.shortname}`;
}

function logoCenterYStorageKey(company) {
  return `${LOGO_CENTER_Y_STORAGE_PREFIX}${company.shortname}`;
}

function logoPositionLabel(position) {
  return (
    LOGO_POSITION_OPTIONS.find((option) => option.value === position)?.label ??
    LOGO_POSITION_OPTIONS.find(
      (option) => option.value === defaultLogoPosition(),
    ).label
  );
}

function logoPositionPresets() {
  const { layout } = cardConfig;
  return (
    layout.company_logo_positions ?? {
      bottom: {
        center_y:
          cardConfig.canvas.height -
          Math.max(
            layout.safe_margin,
            layout.company_logo_safe_margin,
          ) -
          layout.company_logo_box_size / 2,
        box_size: layout.company_logo_box_size,
      },
      center: {
        center_y: layout.company_logo_center_y,
        box_size: layout.company_logo_box_size,
      },
      under_headline: {
        center_y:
          layout.headline_top +
          cardConfig.typography.headline_size * 1.08 +
          layout.company_logo_box_size / 2 +
          20,
        box_size: layout.company_logo_box_size,
      },
    }
  );
}

function defaultLogoPosition() {
  const configuredPosition =
    cardConfig.layout.company_logo_default_position;
  return Object.hasOwn(logoPositionPresets(), configuredPosition)
    ? configuredPosition
    : FALLBACK_LOGO_POSITION;
}

function normalizeLogoPosition(position) {
  return Object.hasOwn(logoPositionPresets(), position)
    ? position
    : defaultLogoPosition();
}

function storedLogoPosition(company) {
  try {
    return normalizeLogoPosition(
      localStorage.getItem(logoPositionStorageKey(company)),
    );
  } catch {
    return defaultLogoPosition();
  }
}

function storedLogoCenterY(company, position) {
  const preset = logoPositionPresets()[normalizeLogoPosition(position)];
  try {
    const stored = Number.parseFloat(
      localStorage.getItem(logoCenterYStorageKey(company)),
    );
    return Number.isFinite(stored)
      ? clampLogoCenterY(
          stored,
          cardConfig.canvas.height,
          preset.box_size,
        )
      : preset.center_y;
  } catch {
    return preset.center_y;
  }
}

function saveLogoPosition(company, position) {
  try {
    localStorage.setItem(logoPositionStorageKey(company), position);
  } catch {
    // The selector still works for this session if storage is unavailable.
  }
}

function saveLogoCenterY(company, centerY) {
  try {
    localStorage.setItem(logoCenterYStorageKey(company), String(centerY));
  } catch {
    // Vertical dragging still works for this session without storage.
  }
}

function logoPlacement(position, centerY) {
  const normalizedPosition = normalizeLogoPosition(position);
  const preset = logoPositionPresets()[normalizedPosition];
  return {
    position: normalizedPosition,
    centerY: clampLogoCenterY(
      Number.isFinite(centerY) ? centerY : preset.center_y,
      cardConfig.canvas.height,
      preset.box_size,
    ),
    boxSize: preset.box_size,
  };
}

function logoPlacementLabelForView(view) {
  const preset = logoPlacement(view.logoPosition);
  return Math.abs(preset.centerY - view.logoCenterY) < 0.5
    ? logoPositionLabel(view.logoPosition)
    : `Вручную · Y ${Math.round(view.logoCenterY)}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    image.src = src;
  });
}

async function loadJson(src) {
  const response = await fetch(src, { cache: "no-store" });
  if (!response.ok) throw new Error(`${src}: HTTP ${response.status}`);
  return response.json();
}

function canvasFontFamily(value) {
  const genericFamilies = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
  ]);
  return value
    .split(",")
    .map((family) => {
      const trimmed = family.trim();
      if (
        genericFamilies.has(trimmed.toLowerCase()) ||
        trimmed.startsWith("\"") ||
        trimmed.startsWith("'") ||
        !/\s/.test(trimmed)
      ) {
        return trimmed;
      }
      return `"${trimmed.replaceAll("\"", "\\\"")}"`;
    })
    .join(", ");
}

function drawTrackedText({
  context,
  text,
  centerX,
  centerY,
  family,
  size,
  weight,
  letterSpacing,
  fill,
}) {
  context.save();
  context.font = `${weight} ${size}px ${canvasFontFamily(family)}`;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillStyle = fill;

  const characters = [...text];
  const widths = characters.map(
    (character) => context.measureText(character).width,
  );
  const totalWidth =
    widths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, characters.length - 1) * letterSpacing;
  let x = centerX - totalWidth / 2;

  characters.forEach((character, index) => {
    context.fillText(character, x, centerY);
    x += widths[index] + letterSpacing;
  });
  context.restore();
}

function roundedRectPath(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawCardBackground(context, background) {
  const { width, height, corner_radius: cornerRadius } = cardConfig.canvas;
  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  roundedRectPath(context, 0, 0, width, height, cornerRadius);
  context.clip();
  context.drawImage(background, 0, 0, width, height);
  context.restore();
}

function drawTypography(context, textColor) {
  const { width } = cardConfig.canvas;
  const { copy, layout, typography } = cardConfig;
  const headlineLineHeight = typography.headline_size * 1.08;

  drawTrackedText({
    context,
    text: copy.headline,
    centerX: width / 2,
    centerY: layout.headline_top + headlineLineHeight / 2,
    family: typography.font_family,
    size: typography.headline_size,
    weight: typography.headline_weight,
    letterSpacing: typography.headline_letter_spacing,
    fill: textColor,
  });

  const labels = [
    { centerX: layout.left_center_x, lines: copy.qr_label },
    { centerX: layout.right_center_x, lines: copy.nfc_label },
  ];
  for (const label of labels) {
    label.lines.forEach((line, index) => {
      drawTrackedText({
        context,
        text: line,
        centerX: label.centerX,
        centerY:
          layout.label_top +
          layout.label_line_height * index +
          layout.label_line_height / 2,
        family: typography.font_family,
        size: typography.label_size,
        weight: typography.label_weight,
        letterSpacing: typography.label_letter_spacing,
        fill: textColor,
      });
    });
  }
}

function drawTarget(context, centerX, targetStyle) {
  const { layout, tiles } = cardConfig;
  const left = centerX - layout.tile_size / 2;
  context.save();
  if (targetStyle === "soft_shadow") {
    context.shadowColor = tiles.soft_shadow.color;
    context.shadowBlur = tiles.soft_shadow.blur;
    context.shadowOffsetX = tiles.soft_shadow.offset_x;
    context.shadowOffsetY = tiles.soft_shadow.offset_y;
  }
  roundedRectPath(
    context,
    left + tiles.stroke_width / 2,
    layout.tile_top + tiles.stroke_width / 2,
    layout.tile_size - tiles.stroke_width,
    layout.tile_size - tiles.stroke_width,
    tiles.corner_radius,
  );
  context.fillStyle = tiles.background;
  context.fill();
  context.lineWidth = tiles.stroke_width;
  context.strokeStyle = tiles.stroke;
  context.stroke();
  context.restore();
}

function drawQr(context, qr) {
  const { layout, tiles } = cardConfig;
  context.drawImage(
    qr,
    layout.left_center_x - tiles.qr_size / 2,
    layout.tile_top + (layout.tile_size - tiles.qr_size) / 2,
    tiles.qr_size,
    tiles.qr_size,
  );
}

function drawNfc(context) {
  const { layout, tiles } = cardConfig;
  const iconSize = layout.tile_size * 0.74;
  const iconLeft = layout.right_center_x - iconSize / 2;
  const iconTop = layout.tile_top + (layout.tile_size - iconSize) / 2;
  const scale = iconSize / 650;

  context.save();
  context.translate(iconLeft, iconTop);
  context.scale(scale, scale);
  context.fillStyle = "transparent";
  context.strokeStyle = tiles.foreground;
  context.lineWidth = 44;
  context.lineCap = "round";

  context.beginPath();
  context.moveTo(205, 246);
  context.quadraticCurveTo(285, 325, 205, 404);
  context.stroke();

  context.beginPath();
  context.moveTo(285, 188);
  context.quadraticCurveTo(420, 325, 285, 462);
  context.stroke();

  context.beginPath();
  context.moveTo(370, 132);
  context.quadraticCurveTo(560, 325, 370, 518);
  context.stroke();
  context.restore();
}

function drawCompanyLogo(context, logo, position, centerY) {
  if (!logo) return;
  const { width } = cardConfig.canvas;
  const placement = logoPlacement(position, centerY);
  context.save();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    logo,
    width / 2 - placement.boxSize / 2,
    placement.centerY - placement.boxSize / 2,
    placement.boxSize,
    placement.boxSize,
  );
  context.restore();
}

function drawGuides(context, logoPosition, requestedLogoCenterY) {
  const { width, height } = cardConfig.canvas;
  const { layout, typography } = cardConfig;
  const tileLeft = layout.left_center_x - layout.tile_size / 2;
  const tileRight = layout.right_center_x - layout.tile_size / 2;
  const { centerY: logoCenterY, boxSize: logoBoxSize } =
    logoPlacement(logoPosition, requestedLogoCenterY);

  context.save();
  context.setLineDash([18, 14]);
  context.lineWidth = 4;

  context.strokeStyle = "#00A3FF";
  context.strokeRect(
    layout.safe_margin,
    layout.safe_margin,
    width - layout.safe_margin * 2,
    height - layout.safe_margin * 2,
  );
  context.strokeRect(
    layout.safe_margin,
    layout.headline_top,
    width - layout.safe_margin * 2,
    typography.headline_size * 1.08,
  );

  context.strokeStyle = "#FF3B72";
  context.strokeRect(
    tileLeft,
    layout.label_top,
    layout.tile_size,
    layout.label_line_height * 2,
  );
  context.strokeRect(
    tileRight,
    layout.label_top,
    layout.tile_size,
    layout.label_line_height * 2,
  );
  context.strokeRect(
    tileLeft,
    layout.tile_top,
    layout.tile_size,
    layout.tile_size,
  );
  context.strokeRect(
    tileRight,
    layout.tile_top,
    layout.tile_size,
    layout.tile_size,
  );

  context.strokeStyle = "#A7EF99";
  context.strokeRect(
    width / 2 - logoBoxSize / 2,
    logoCenterY - logoBoxSize / 2,
    logoBoxSize,
    logoBoxSize,
  );
  context.restore();
}

function drawComposition(
  canvas,
  { background, qr, manifest, companyLogo },
  logoPosition,
  logoCenterY,
  guides = false,
  targetStyle,
) {
  const { width, height } = cardConfig.canvas;
  const scaleX = canvas.width / width;
  const scaleY = canvas.height / height;
  const context = canvas.getContext("2d", { alpha: true });
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(scaleX, scaleY);
  drawCardBackground(context, background);
  drawTypography(context, manifest.text_color);
  drawTarget(context, cardConfig.layout.left_center_x, targetStyle);
  drawTarget(context, cardConfig.layout.right_center_x, targetStyle);
  drawQr(context, qr);
  drawNfc(context);
  drawCompanyLogo(context, companyLogo, logoPosition, logoCenterY);
  if (guides) drawGuides(context, logoPosition, logoCenterY);
  context.restore();
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32(value) {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function makePngChunk(type, payload) {
  const typeBytes = new TextEncoder().encode(type);
  const crcInput = new Uint8Array(typeBytes.length + payload.length);
  crcInput.set(typeBytes);
  crcInput.set(payload, typeBytes.length);
  const chunk = new Uint8Array(12 + payload.length);
  chunk.set(uint32(payload.length), 0);
  chunk.set(typeBytes, 4);
  chunk.set(payload, 8);
  chunk.set(uint32(crc32(crcInput)), 8 + payload.length);
  return chunk;
}

async function canvasPngAt300Dpi(sourceCanvas) {
  const blob = await new Promise((resolve, reject) => {
    sourceCanvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("Canvas export failed")),
      "image/png",
    );
  });
  const png = new Uint8Array(await blob.arrayBuffer());
  const payload = new Uint8Array(9);
  payload.set(uint32(PIXELS_PER_METER_300_DPI), 0);
  payload.set(uint32(PIXELS_PER_METER_300_DPI), 4);
  payload[8] = 1;
  const densityChunk = makePngChunk("pHYs", payload);
  const insertAt = 33;
  const output = new Uint8Array(png.length + densityChunk.length);
  output.set(png.slice(0, insertAt), 0);
  output.set(densityChunk, insertAt);
  output.set(png.slice(insertAt), insertAt + densityChunk.length);
  return new Blob([output], { type: "image/png" });
}

async function inspectPngBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  let offset = 8;
  let dpiX = null;
  let dpiY = null;

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    if (type === "pHYs") {
      const xPixelsPerMeter = view.getUint32(offset + 8);
      const yPixelsPerMeter = view.getUint32(offset + 12);
      const unitIsMeter = bytes[offset + 16] === 1;
      if (unitIsMeter) {
        dpiX = Math.round(xPixelsPerMeter * 0.0254);
        dpiY = Math.round(yPixelsPerMeter * 0.0254);
      }
      break;
    }
    offset += 12 + length;
  }

  return { bytes: bytes.length, width, height, dpiX, dpiY };
}

function updateRenderStatus() {
  const renderedCards = [...cardViews.values()].filter(
    (view) => view.rendered,
  ).length;
  const message = renderedCards
    ? `Отрендерено: ${renderedCards} из ${companies.length} · остальные собираются по клику`
    : `${companies.length} карточек доступны · нажмите на превью для рендера`;
  setStatus(message, "ready");
}

function createCardView(company) {
  const article = document.createElement("article");
  article.className = "preview-card";
  article.innerHTML = `
    <div class="preview-heading">
      <div>
        <span class="preview-kicker">Canvas</span>
        <h2></h2>
        <span class="card-status">Ожидает рендера…</span>
      </div>
      <div class="card-actions">
        <label class="logo-position-field">
          <span>Позиция логотипа</span>
          <select class="logo-position-select"></select>
        </label>
        <label class="logo-drag-field checkbox">
          <input class="logo-drag-toggle" type="checkbox" />
          <span>Двигать логотип</span>
        </label>
        <a class="public-link" target="_blank" rel="noreferrer"></a>
        <a class="download-button" aria-disabled="true">Скачать PNG · 300 DPI</a>
      </div>
    </div>
    <div class="canvas-stage is-idle">
      <canvas
        width="${Math.round(cardConfig.canvas.width * PREVIEW_SCALE)}"
        height="${Math.round(cardConfig.canvas.height * PREVIEW_SCALE)}"
      ></canvas>
      <button class="render-trigger" type="button">
        <span>Собрать карточку</span>
        <small>Нажмите для рендера</small>
      </button>
    </div>
  `;
  article.querySelector("h2").textContent = company.name;
  const canvas = article.querySelector("canvas");
  canvas.setAttribute(
    "aria-label",
    `Карточка меню ${company.name}, собранная в Canvas`,
  );
  canvas.setAttribute("aria-hidden", "true");
  const renderTrigger = article.querySelector(".render-trigger");
  renderTrigger.setAttribute(
    "aria-label",
    `Собрать карточку меню ${company.name}`,
  );
  const publicShortname = company.public_shortname ?? company.shortname;
  const publicLink = article.querySelector(".public-link");
  publicLink.href = `https://sigmela.ru/${publicShortname}`;
  publicLink.textContent = `sigmela.ru/${publicShortname}`;
  const logoPositionField = article.querySelector(".logo-position-field");
  const logoDragField = article.querySelector(".logo-drag-field");
  logoPositionField.hidden = Boolean(
    company.background_contains_brand_signature,
  );
  if (company.background_contains_brand_signature) {
    logoPositionField.style.display = "none";
    logoDragField.hidden = true;
    logoDragField.style.display = "none";
  }
  const logoPositionSelect = article.querySelector(".logo-position-select");
  const logoDragToggle = article.querySelector(".logo-drag-toggle");
  for (const optionDefinition of LOGO_POSITION_OPTIONS) {
    const option = document.createElement("option");
    option.value = optionDefinition.value;
    option.textContent = optionDefinition.label;
    logoPositionSelect.append(option);
  }
  const initialLogoPosition = storedLogoPosition(company);
  const initialLogoCenterY = storedLogoCenterY(
    company,
    initialLogoPosition,
  );
  logoPositionSelect.value = initialLogoPosition;
  logoPositionSelect.setAttribute(
    "aria-label",
    `Позиция логотипа для ${company.name}`,
  );
  logoDragToggle.setAttribute(
    "aria-label",
    `Двигать логотип ${company.name} по вертикали`,
  );
  logoDragToggle.disabled = true;
  canvas.tabIndex = -1;
  cardsList.append(article);
  const view = {
    article,
    canvas,
    canvasStage: article.querySelector(".canvas-stage"),
    renderTrigger,
    downloadLink: article.querySelector(".download-button"),
    cardStatus: article.querySelector(".card-status"),
    logoPositionField,
    logoPositionSelect,
    logoDragField,
    logoDragToggle,
    logoPosition: initialLogoPosition,
    logoCenterY: initialLogoCenterY,
    logoDragEnabled: false,
    logoDragState: null,
    logoDragFrame: null,
    pendingLogoCenterY: null,
    assets: null,
    rendered: false,
    renderPromise: null,
    renderRequest: 0,
  };

  renderTrigger.addEventListener("click", () => {
    if (view.rendered || view.renderPromise) return;
    renderTrigger.disabled = true;
    renderTrigger.querySelector("span").textContent = "Собираю карточку…";
    view.canvasStage.classList.add("is-rendering");
    view.renderPromise = renderCard(company, view, renderVersion)
      .then(() => {
        view.rendered = true;
        view.canvasStage.classList.remove("is-idle", "is-rendering");
        view.canvasStage.classList.add("is-rendered");
        view.canvas.removeAttribute("aria-hidden");
        renderTrigger.hidden = true;
        updateRenderStatus();
      })
      .catch((error) => {
        console.error(error);
        view.canvasStage.classList.remove("is-rendering");
        renderTrigger.disabled = false;
        renderTrigger.querySelector("span").textContent = "Повторить рендер";
        view.cardStatus.textContent = `Ошибка: ${error.message}`;
      })
      .finally(() => {
        view.renderPromise = null;
      });
  });

  const pointerPoint = (event) =>
    pointerToCanvasPoint(
      event.clientX,
      event.clientY,
      canvas.getBoundingClientRect(),
      cardConfig.canvas.width,
      cardConfig.canvas.height,
    );

  const redrawPreview = () => {
    if (!view.assets) return;
    drawComposition(
      view.canvas,
      view.assets,
      view.logoPosition,
      view.logoCenterY,
      guidesToggle.checked,
      company.target_style,
    );
  };

  const setHoverState = (event) => {
    if (
      !view.logoDragEnabled ||
      !view.assets?.companyLogo ||
      view.logoDragState
    ) {
      view.canvasStage.classList.remove("logo-drag-hover");
      return;
    }
    const placement = logoPlacement(
      view.logoPosition,
      view.logoCenterY,
    );
    view.canvasStage.classList.toggle(
      "logo-drag-hover",
      pointHitsLogo(
        pointerPoint(event),
        cardConfig.canvas.width,
        placement.centerY,
        placement.boxSize,
      ),
    );
  };

  const flushLogoDragFrame = () => {
    if (view.logoDragFrame !== null) {
      cancelAnimationFrame(view.logoDragFrame);
      view.logoDragFrame = null;
    }
    if (view.pendingLogoCenterY !== null) {
      view.logoCenterY = view.pendingLogoCenterY;
      view.pendingLogoCenterY = null;
      redrawPreview();
    }
  };

  const scheduleLogoCenterY = (centerY) => {
    view.pendingLogoCenterY = centerY;
    if (view.logoDragFrame !== null) return;
    view.logoDragFrame = requestAnimationFrame(() => {
      view.logoDragFrame = null;
      view.logoCenterY = view.pendingLogoCenterY;
      view.pendingLogoCenterY = null;
      redrawPreview();
      view.cardStatus.textContent =
        `Логотип: вручную · Y ${Math.round(view.logoCenterY)}`;
    });
  };

  const commitLogoCenterY = () => {
    flushLogoDragFrame();
    saveLogoCenterY(company, view.logoCenterY);
    renderCard(company, view, renderVersion).catch((error) => {
      console.error(error);
      view.cardStatus.textContent = `Ошибка: ${error.message}`;
    });
  };

  const finishLogoDrag = (event, cancelled = false) => {
    const drag = view.logoDragState;
    if (!drag || drag.pointerId !== event.pointerId) return;
    flushLogoDragFrame();
    if (cancelled) {
      view.logoCenterY = drag.startingCenterY;
      redrawPreview();
    }
    view.logoDragState = null;
    view.canvasStage.classList.remove("logo-drag-active");
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    commitLogoCenterY();
  };

  logoPositionSelect.addEventListener("change", () => {
    view.logoPosition = normalizeLogoPosition(logoPositionSelect.value);
    view.logoCenterY = logoPlacement(view.logoPosition).centerY;
    logoPositionSelect.value = view.logoPosition;
    saveLogoPosition(company, view.logoPosition);
    saveLogoCenterY(company, view.logoCenterY);
    if (!view.rendered) {
      view.cardStatus.textContent =
        "Позиция сохранена · нажмите на превью для рендера";
      return;
    }
    renderCard(company, view, renderVersion).catch((error) => {
      console.error(error);
      view.cardStatus.textContent = `Ошибка: ${error.message}`;
    });
  });

  logoDragToggle.addEventListener("change", () => {
    view.logoDragEnabled = logoDragToggle.checked;
    view.canvasStage.classList.toggle(
      "logo-drag-enabled",
      view.logoDragEnabled,
    );
    canvas.tabIndex = view.logoDragEnabled ? 0 : -1;
    canvas.setAttribute(
      "aria-label",
      view.logoDragEnabled
        ? `Карточка ${company.name}. Перетаскивайте логотип только вверх и вниз или используйте стрелки.`
        : `Карточка меню ${company.name}, собранная в Canvas`,
    );
    if (!view.logoDragEnabled) {
      view.canvasStage.classList.remove(
        "logo-drag-hover",
        "logo-drag-active",
      );
    }
    view.cardStatus.textContent = view.logoDragEnabled
      ? "Режим перемещения включён · тяните логотип вверх-вниз"
      : `Логотип: ${logoPlacementLabelForView(view)}`;
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (
      !view.logoDragEnabled ||
      !view.assets?.companyLogo ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }
    const placement = logoPlacement(
      view.logoPosition,
      view.logoCenterY,
    );
    const point = pointerPoint(event);
    if (
      !pointHitsLogo(
        point,
        cardConfig.canvas.width,
        placement.centerY,
        placement.boxSize,
      )
    ) {
      return;
    }
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    view.logoDragState = {
      pointerId: event.pointerId,
      grabOffsetY: point.y - placement.centerY,
      startingCenterY: placement.centerY,
    };
    view.canvasStage.classList.remove("logo-drag-hover");
    view.canvasStage.classList.add("logo-drag-active");
    view.downloadLink.setAttribute("aria-disabled", "true");
    view.cardStatus.textContent =
      `Перемещение · Y ${Math.round(placement.centerY)}`;
  });

  canvas.addEventListener("pointermove", (event) => {
    const drag = view.logoDragState;
    if (!drag || drag.pointerId !== event.pointerId) {
      setHoverState(event);
      return;
    }
    event.preventDefault();
    const placement = logoPlacement(
      view.logoPosition,
      view.logoCenterY,
    );
    const centerY = clampLogoCenterY(
      pointerPoint(event).y - drag.grabOffsetY,
      cardConfig.canvas.height,
      placement.boxSize,
    );
    scheduleLogoCenterY(centerY);
  });

  canvas.addEventListener("pointerup", (event) => {
    finishLogoDrag(event);
  });

  canvas.addEventListener("pointercancel", (event) => {
    finishLogoDrag(event, true);
  });

  canvas.addEventListener("pointerleave", () => {
    if (!view.logoDragState) {
      view.canvasStage.classList.remove("logo-drag-hover");
    }
  });

  canvas.addEventListener("keydown", (event) => {
    if (!view.logoDragEnabled || !view.assets?.companyLogo) return;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const placement = logoPlacement(
      view.logoPosition,
      view.logoCenterY,
    );
    const step = event.shiftKey
      ? LOGO_KEYBOARD_LARGE_STEP
      : LOGO_KEYBOARD_STEP;
    const direction = event.key === "ArrowUp" ? -1 : 1;
    view.logoCenterY = clampLogoCenterY(
      placement.centerY + direction * step,
      cardConfig.canvas.height,
      placement.boxSize,
    );
    saveLogoCenterY(company, view.logoCenterY);
    view.downloadLink.setAttribute("aria-disabled", "true");
    redrawPreview();
    view.cardStatus.textContent =
      `Логотип: вручную · Y ${Math.round(view.logoCenterY)}`;
  });

  canvas.addEventListener("keyup", (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      commitLogoCenterY();
    }
  });

  view.downloadLink.addEventListener("click", async (event) => {
    event.preventDefault();
    if (view.downloadLink.getAttribute("aria-disabled") === "true") return;
    view.downloadLink.setAttribute("aria-disabled", "true");
    const previousStatus = view.cardStatus.textContent;
    view.cardStatus.textContent =
      `Готовлю PNG ${cardConfig.canvas.width}×${cardConfig.canvas.height} · ` +
      `${cardConfig.canvas.physical_width_mm}×${cardConfig.canvas.physical_height_mm} мм · 300 DPI…`;
    try {
      const assets = view.assets ?? (await loadCardAssets(company));
      view.assets = assets;
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = cardConfig.canvas.width;
      exportCanvas.height = cardConfig.canvas.height;
      drawComposition(
        exportCanvas,
        assets,
        normalizeLogoPosition(view.logoPosition),
        view.logoCenterY,
        false,
        company.target_style,
      );
      const exportBlob = await canvasPngAt300Dpi(exportCanvas);
      const exportMetadata = await inspectPngBlob(exportBlob);
      if (
        exportMetadata.width !== cardConfig.canvas.width ||
        exportMetadata.height !== cardConfig.canvas.height ||
        exportMetadata.dpiX !== 300 ||
        exportMetadata.dpiY !== 300
      ) {
        throw new Error(`Некорректный PNG: ${JSON.stringify(exportMetadata)}`);
      }
      const exportUrl = URL.createObjectURL(exportBlob);
      const anchor = document.createElement("a");
      anchor.href = exportUrl;
      anchor.download = `${company.name.replaceAll(":", "")} — Menu Card Canvas.png`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(exportUrl), 30_000);
      const brandPlacement = company.background_contains_brand_signature
        ? "Надпись: в фоне"
        : `Логотип: ${logoPlacementLabelForView(view)}`;
      view.cardStatus.textContent =
        `PNG готов · ${exportMetadata.width}×${exportMetadata.height} · ` +
        `${exportMetadata.dpiX} DPI · ${brandPlacement}`;
    } catch (error) {
      console.error(error);
      view.cardStatus.textContent = `Ошибка экспорта: ${error.message}`;
    } finally {
      view.downloadLink.setAttribute("aria-disabled", "false");
      if (!view.cardStatus.textContent) {
        view.cardStatus.textContent = previousStatus;
      }
    }
  });

  return view;
}

async function loadCardAssets(company) {
  const companyRoot = `${OUTPUT_ROOT}/${company.shortname}`;
  const cacheKey = Date.now();
  const [background, qr, manifest] = await Promise.all([
    loadImage(`${companyRoot}/background.webp?v=${cacheKey}`),
    loadImage(`${companyRoot}/qr.png?v=${cacheKey}`),
    loadJson(`${companyRoot}/manifest.json?v=${cacheKey}`),
    document.fonts.ready,
  ]);
  const companyLogo = manifest.company_logo
    ? await loadImage(`${companyRoot}/company-logo.png?v=${cacheKey}`)
    : null;
  if (!/^#[0-9a-f]{6}$/i.test(manifest.text_color ?? "")) {
    throw new Error(
      `${company.name}: manifest.text_color должен быть вычислен из палитры фона и логотипа`,
    );
  }
  return { background, qr, manifest, companyLogo };
}

async function renderCard(
  company,
  view,
  version,
  { guides = guidesToggle.checked } = {},
) {
  const request = ++view.renderRequest;
  const logoPosition = normalizeLogoPosition(view.logoPosition);
  const isStale = () =>
    version !== renderVersion || request !== view.renderRequest;
  view.downloadLink.setAttribute("aria-disabled", "true");
  view.cardStatus.textContent =
    `Собираю Canvas · логотип: ${logoPlacementLabelForView(view)}…`;
  const assets = view.assets ?? (await loadCardAssets(company));
  if (isStale()) return;
  view.assets = assets;
  if (!assets.companyLogo) {
    view.logoDragToggle.checked = false;
    view.logoDragToggle.disabled = true;
    view.logoDragEnabled = false;
    view.canvasStage.classList.remove(
      "logo-drag-enabled",
      "logo-drag-hover",
      "logo-drag-active",
    );
    view.canvas.tabIndex = -1;
  } else {
    view.logoDragToggle.disabled = false;
  }
  drawComposition(
    view.canvas,
    assets,
    logoPosition,
    view.logoCenterY,
    guides,
    company.target_style,
  );
  view.downloadLink.setAttribute("aria-disabled", "false");
  const brandPlacement = company.background_contains_brand_signature
    ? "Надпись: в фоне"
    : `Логотип: ${logoPlacementLabelForView(view)}`;
  view.cardStatus.textContent =
    `Предпросмотр готов · экспорт ${cardConfig.canvas.width}×${cardConfig.canvas.height} · ` +
    `${cardConfig.canvas.physical_width_mm}×${cardConfig.canvas.physical_height_mm} мм · 300 DPI · ` +
    brandPlacement;
}

function redrawRenderedCards() {
  for (const company of companies) {
    const view = cardViews.get(company.shortname);
    if (!view?.assets) continue;
    drawComposition(
      view.canvas,
      view.assets,
      view.logoPosition,
      view.logoCenterY,
      guidesToggle.checked,
      company.target_style,
    );
  }
}

async function initialize() {
  try {
    const loadedCardConfig = await loadJson(CONFIG_URL);
    const companiesConfigUrl = loadedCardConfig.companies_config.startsWith("/")
      ? loadedCardConfig.companies_config
      : `/${loadedCardConfig.companies_config}`;
    const companiesConfig = await loadJson(companiesConfigUrl);
    cardConfig = loadedCardConfig;
    companies = companiesConfig.companies.filter(
      (company) => company?.name && company?.shortname,
    );
    if (companies.length === 0) {
      throw new Error("Нет сгенерированных карточек для Canvas-эксперимента");
    }

    for (const company of companies) {
      cardViews.set(company.shortname, createCardView(company));
    }
    applyCompanySearch();
    updateRenderStatus();
  } catch (error) {
    console.error(error);
    setStatus(error.message, "error");
  }
}

guidesToggle.addEventListener("change", () => {
  redrawRenderedCards();
});

companySearch.addEventListener("input", applyCompanySearch);

initialize();
