export const LOGO_KEYBOARD_STEP = 4;
export const LOGO_KEYBOARD_LARGE_STEP = 20;

export function clampLogoCenterY(centerY, canvasHeight, boxSize) {
  const minimum = boxSize / 2;
  const maximum = canvasHeight - boxSize / 2;
  return Math.min(maximum, Math.max(minimum, centerY));
}

export function pointerToCanvasPoint(
  clientX,
  clientY,
  bounds,
  canvasWidth,
  canvasHeight,
) {
  return {
    x: ((clientX - bounds.left) / bounds.width) * canvasWidth,
    y: ((clientY - bounds.top) / bounds.height) * canvasHeight,
  };
}

export function pointHitsLogo(
  point,
  canvasWidth,
  centerY,
  boxSize,
  hitPadding = 18,
) {
  const halfSize = boxSize / 2 + hitPadding;
  return (
    Math.abs(point.x - canvasWidth / 2) <= halfSize &&
    Math.abs(point.y - centerY) <= halfSize
  );
}
