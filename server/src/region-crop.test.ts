// server/src/region-crop.test.ts
//
// T04B-2: cropRegion is a pure function over (imageBytes, bbox).
// Same input → same output. Returns JPEG bytes. Throws on invalid
// input (degenerate bbox, undecodable image, empty crop).

import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { cropRegion } from "./region-crop.js";

/** Build a deterministic 16x16 solid-red PNG buffer for tests. */
async function makeTestPng(): Promise<Buffer> {
  return sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
}

describe("cropRegion (T04-B PR-B)", () => {
  it("T04B-2a: crops a valid bbox and returns JPEG bytes (magic ff d8 ff)", async () => {
    const img = await makeTestPng();
    const out = await cropRegion(img, [0.5, 0.5, 1.0, 1.0]);
    expect(out.length).toBeGreaterThan(0);
    // JPEG magic bytes
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(out[2]).toBe(0xff);
  });

  it("T04B-2b: crops a full-image bbox and returns the full image (≈ input size)", async () => {
    const img = await makeTestPng();
    const out = await cropRegion(img, [0, 0, 1, 1]);
    const outMeta = await sharp(out).metadata();
    expect(outMeta.width).toBe(16);
    expect(outMeta.height).toBe(16);
    expect(outMeta.format).toBe("jpeg");
  });

  it("T04B-2c: throws when right ≤ left (degenerate bbox)", async () => {
    const img = await makeTestPng();
    await expect(cropRegion(img, [0.5, 0.0, 0.5, 1.0])).rejects.toThrow(
      /invalid bbox/,
    );
  });

  it("T04B-2d: throws when bottom ≤ top (degenerate bbox)", async () => {
    const img = await makeTestPng();
    await expect(cropRegion(img, [0.0, 0.7, 1.0, 0.3])).rejects.toThrow(
      /invalid bbox/,
    );
  });

  it("T04B-2e: throws on undecodable image bytes", async () => {
    const garbage = Buffer.from("not an image at all, just text bytes");
    await expect(cropRegion(garbage, [0, 0, 1, 1])).rejects.toThrow();
  });

  it("T04B-2f: clamps bbox that goes outside image bounds (still crops)", async () => {
    // bbox that goes 0.5 to 1.5 — sharp should clamp to image edge
    // and produce a valid (smaller) crop instead of throwing.
    const img = await makeTestPng();
    const out = await cropRegion(img, [0.5, 0.0, 1.5, 1.0]);
    const outMeta = await sharp(out).metadata();
    expect(outMeta.width).toBeGreaterThan(0);
    expect(outMeta.width).toBeLessThanOrEqual(8); // 16 * 0.5
  });
});
