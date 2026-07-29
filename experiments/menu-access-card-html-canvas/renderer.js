const CONFIG_URL = "/data/menu-access-card-config.json";
const OUTPUT_ROOT = "/data/generated/menu-access-cards-v1";
const PIXELS_PER_METER_300_DPI = 11811;
const PREVIEW_SCALE = 0.4;
const FALLBACK_LOGO_POSITION = "bottom";
const LOGO_POSITION_STORAGE_PREFIX = "sigmela-menu-card-logo-position-v2:";
const LOGO_POSITION_OPTIONS = [
  { value: "bottom", label: "Снизу" },
  { value: "center", label: "По центру" },
  { value: "under_headline", label: "Под «МЕНЮ»" },
];

const cardsList = document.querySelector("#cards-list");
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

function logoPositionStorageKey(company) {
  return `${LOGO_POSITION_STORAGE_PREFIX}${company.shortname}`;
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

function saveLogoPosition(company, position) {
  try {
    localStorage.setItem(logoPositionStorageKey(company), position);
  } catch {
    // The selector still works for this session if storage is unavailable.
  }
}

function logoPlacement(position) {
  const normalizedPosition = normalizeLogoPosition(position);
  const preset = logoPositionPresets()[normalizedPosition];
  return {
    position: normalizedPosition,
    centerY: preset.center_y,
    boxSize: preset.box_size,
  };
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

async function generatedCompanies(configuredCompanies) {
  const candidates = await Promise.all(
    configuredCompanies.map(async (company) => {
      try {
        const manifest = await loadJson(
          `${OUTPUT_ROOT}/${company.shortname}/manifest.json`,
        );
        return manifest.shortname === company.shortname ? company : null;
      } catch {
        return null;
      }
    }),
  );
  return candidates.filter(Boolean);
}

function coverImage(context, image, width, height) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height,
  );
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
  roundedRectPath(context, 0, 0, width, height, cornerRadius);
  context.clip();
  coverImage(context, background, width, height);
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

function drawTarget(context, centerX) {
  const { layout, tiles } = cardConfig;
  const left = centerX - layout.tile_size / 2;
  context.save();
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

function drawCompanyLogo(context, logo, position) {
  if (!logo) return;
  const { width } = cardConfig.canvas;
  const { centerY, boxSize } = logoPlacement(position);
  context.drawImage(
    logo,
    width / 2 - boxSize / 2,
    centerY - boxSize / 2,
    boxSize,
    boxSize,
  );
}

function drawGuides(context, logoPosition) {
  const { width, height } = cardConfig.canvas;
  const { layout, typography } = cardConfig;
  const tileLeft = layout.left_center_x - layout.tile_size / 2;
  const tileRight = layout.right_center_x - layout.tile_size / 2;
  const { centerY: logoCenterY, boxSize: logoBoxSize } =
    logoPlacement(logoPosition);

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
  guides = false,
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
  drawTarget(context, cardConfig.layout.left_center_x);
  drawTarget(context, cardConfig.layout.right_center_x);
  drawQr(context, qr);
  drawNfc(context);
  drawCompanyLogo(context, companyLogo, logoPosition);
  if (guides) drawGuides(context, logoPosition);
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
        <a class="public-link" target="_blank" rel="noreferrer"></a>
        <a class="download-button" aria-disabled="true">Скачать PNG · 300 DPI</a>
      </div>
    </div>
    <div class="canvas-stage">
      <canvas
        width="${Math.round(cardConfig.canvas.width * PREVIEW_SCALE)}"
        height="${Math.round(cardConfig.canvas.height * PREVIEW_SCALE)}"
      ></canvas>
    </div>
  `;
  article.querySelector("h2").textContent = company.name;
  const canvas = article.querySelector("canvas");
  canvas.setAttribute(
    "aria-label",
    `Карточка меню ${company.name}, собранная в Canvas`,
  );
  const publicLink = article.querySelector(".public-link");
  publicLink.href = `https://sigmela.ru/${company.shortname}`;
  publicLink.textContent = `sigmela.ru/${company.shortname}`;
  const logoPositionSelect = article.querySelector(".logo-position-select");
  for (const optionDefinition of LOGO_POSITION_OPTIONS) {
    const option = document.createElement("option");
    option.value = optionDefinition.value;
    option.textContent = optionDefinition.label;
    logoPositionSelect.append(option);
  }
  const initialLogoPosition = storedLogoPosition(company);
  logoPositionSelect.value = initialLogoPosition;
  logoPositionSelect.setAttribute(
    "aria-label",
    `Позиция логотипа для ${company.name}`,
  );
  cardsList.append(article);
  const view = {
    canvas,
    downloadLink: article.querySelector(".download-button"),
    cardStatus: article.querySelector(".card-status"),
    logoPositionSelect,
    logoPosition: initialLogoPosition,
    renderRequest: 0,
  };

  logoPositionSelect.addEventListener("change", () => {
    view.logoPosition = normalizeLogoPosition(logoPositionSelect.value);
    logoPositionSelect.value = view.logoPosition;
    saveLogoPosition(company, view.logoPosition);
    renderCard(company, view, renderVersion).catch((error) => {
      console.error(error);
      view.cardStatus.textContent = `Ошибка: ${error.message}`;
    });
  });

  view.downloadLink.addEventListener("click", async (event) => {
    event.preventDefault();
    if (view.downloadLink.getAttribute("aria-disabled") === "true") return;
    view.downloadLink.setAttribute("aria-disabled", "true");
    const previousStatus = view.cardStatus.textContent;
    view.cardStatus.textContent = "Готовлю PNG 2400×1500 · 300 DPI…";
    try {
      const assets = await loadCardAssets(company);
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = cardConfig.canvas.width;
      exportCanvas.height = cardConfig.canvas.height;
      drawComposition(
        exportCanvas,
        assets,
        normalizeLogoPosition(view.logoPosition),
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
      view.cardStatus.textContent =
        `PNG готов · ${exportMetadata.width}×${exportMetadata.height} · ` +
        `${exportMetadata.dpiX} DPI · Логотип: ${logoPositionLabel(view.logoPosition)}`;
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
    `Собираю Canvas · логотип: ${logoPositionLabel(logoPosition)}…`;
  const assets = await loadCardAssets(company);
  if (isStale()) return;
  drawComposition(view.canvas, assets, logoPosition, guides);
  view.downloadLink.setAttribute("aria-disabled", "false");
  view.cardStatus.textContent =
    `Предпросмотр готов · экспорт 2400×1500 · 300 DPI · ` +
    `Логотип: ${logoPositionLabel(logoPosition)}`;
}

async function renderAll() {
  const version = ++renderVersion;
  setStatus(`Собираю ${companies.length} карточек в Canvas…`);
  for (const company of companies) {
    if (version !== renderVersion) return;
    const view = cardViews.get(company.shortname);
    try {
      await renderCard(company, view, version);
    } catch (error) {
      view.cardStatus.textContent = `Ошибка: ${error.message}`;
      throw error;
    }
  }
  if (version !== renderVersion) return;
  setStatus(
    `${companies.length} карточек готовы · Canvas · PNG 2400×1500 · 300 DPI`,
    "ready",
  );
}

async function initialize() {
  try {
    const loadedCardConfig = await loadJson(CONFIG_URL);
    const companiesConfigUrl = loadedCardConfig.companies_config.startsWith("/")
      ? loadedCardConfig.companies_config
      : `/${loadedCardConfig.companies_config}`;
    const companiesConfig = await loadJson(companiesConfigUrl);
    cardConfig = loadedCardConfig;
    companies = await generatedCompanies(companiesConfig.companies);
    if (companies.length === 0) {
      throw new Error("Нет сгенерированных карточек для Canvas-эксперимента");
    }

    for (const company of companies) {
      cardViews.set(company.shortname, createCardView(company));
    }
    await renderAll();
  } catch (error) {
    console.error(error);
    setStatus(error.message, "error");
  }
}

guidesToggle.addEventListener("change", () => {
  renderAll().catch((error) => {
    console.error(error);
    setStatus(error.message, "error");
  });
});

initialize();
