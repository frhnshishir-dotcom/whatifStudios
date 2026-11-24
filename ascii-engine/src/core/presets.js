// Quality and output-format presets. Render mode uses the format size exactly; preview mode scales it down.

export const QUALITY = {
  // Real-time in a browser on integrated graphics.
  preview: { density: 0.35, supersample: 1.0, previewScale: 0.6, bloomLevels: 4, maxPointPx: 48 },
  // Quick frame checks (stills, timing tests).
  draft: { density: 0.65, supersample: 1.0, previewScale: 1.0, bloomLevels: 5, maxPointPx: 64 },
  // Delivery.
  final: { density: 1.0, supersample: 1.0, previewScale: 1.0, bloomLevels: 6, maxPointPx: 80 },
  // Best quality: 1.5x internal resolution, downsampled in the composite pass. About 2.2x the cost of final.
  master: { density: 1.0, supersample: 1.5, previewScale: 1.0, bloomLevels: 6, maxPointPx: 96 },
};

export const FORMATS = {
  '9x16': { width: 720, height: 1280 },
  '9x16-hd': { width: 1080, height: 1920 },
  '16x9': { width: 1280, height: 720 },
  '16x9-hd': { width: 1920, height: 1080 },
  '1x1': { width: 1080, height: 1080 },
};

export function resolveFormat(name, size) {
  if (size) {
    const m = /^(\d+)x(\d+)$/.exec(size);
    if (!m) throw new Error(`bad size ${size}, expected WxH`);
    const width = +m[1], height = +m[2];
    if (width % 2 || height % 2) throw new Error('width and height must be even (H.264 yuv420p)');
    return { width, height, name: `${width}x${height}` };
  }
  const f = FORMATS[name];
  if (!f) throw new Error(`unknown format ${name}; use one of ${Object.keys(FORMATS).join(', ')}`);
  return { ...f, name };
}

export function resolveQuality(name) {
  const q = QUALITY[name];
  if (!q) throw new Error(`unknown quality ${name}; use one of ${Object.keys(QUALITY).join(', ')}`);
  return { ...q, name };
}
