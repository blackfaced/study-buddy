// server/src/region-crop.ts
//
// Pure helper: crop a region out of a page photo, given a normalized
// bounding box. T04-B first slice — fed by VisionPage's LayoutRegion,
// consumed by runRegionOcr to feed each crop into analyzeMistakeImage.
//
// Why pure (no I/O): the test for cropRegion must not depend on
// sharp/libvips being installed in CI, and the function should be
// trivial to compose in higher-level workflows. sharp itself is the
// only I/O (decode input → re-encode output), and it works on Buffers
// in memory, so the function signature stays pure from the caller's
// point of view.

import sharp from "sharp";

/**
 * Normalized bounding box, matching the schema in
 * `mistake_photo_page_drafts.layout_regions_json` and VisionPage's
 * `LayoutRegion.bbox`.
 *
 *   bbox[0] = left   (0..1 of image width)
 *   bbox[1] = top    (0..1 of image height)
 *   bbox[2] = right  (0..1 of image width, must be > bbox[0])
 *   bbox[3] = bottom (0..1 of image height, must be > bbox[1])
 */
export type NormalizedBBox = readonly [
  number,
  number,
  number,
  number,
];

/**
 * Crop a region out of an encoded image (jpeg/png/webp — anything
 * sharp accepts). Returns the cropped region as JPEG bytes.
 *
 * Pure: same input → same output. No disk I/O, no env access.
 *
 * Throws if:
 *   - bbox has a 0/negative area (right ≤ left or bottom ≤ top)
 *   - bbox falls outside [0, 1] after rounding to pixels
 *   - imageBytes is not a valid encoded image
 */
export async function cropRegion(
  imageBytes: Buffer,
  bbox: NormalizedBBox,
): Promise<Buffer> {
  const [x1n, y1n, x2n, y2n] = bbox;
  if (x2n <= x1n || y2n <= y1n) {
    throw new Error(
      `cropRegion: invalid bbox ${JSON.stringify(bbox)} (right must be > left, bottom must be > top)`,
    );
  }
  const meta = await sharp(imageBytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error(
      `cropRegion: cannot read image dimensions (got ${width}x${height})`,
    );
  }

  // Convert normalized → absolute pixel coords. Clamp to image bounds
  // so a slightly-out-of-bounds bbox from a model still produces a
  // valid crop instead of throwing.
  const left = Math.max(0, Math.floor(x1n * width));
  const top = Math.max(0, Math.floor(y1n * height));
  const right = Math.min(width, Math.ceil(x2n * width));
  const bottom = Math.min(height, Math.ceil(y2n * height));
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new Error(
      `cropRegion: bbox rounds to empty crop (${cropWidth}x${cropHeight})`,
    );
  }

  return sharp(imageBytes)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .jpeg({ quality: 92 })
    .toBuffer();
}
