import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ImageValidator } from "../../apps/server/src/http/image-validator.ts";
const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
function sample(format: "png" | "jpeg" = "png"): Uint8Array {
  const { PhotonImage } = require("@silvia-odwyer/photon-node") as { PhotonImage: new (pixels: Uint8Array, width: number, height: number) => { get_bytes(): Uint8Array; get_bytes_jpeg(quality: number): Uint8Array; free(): void } };
  const image = new PhotonImage(Uint8Array.from([255,0,0,255,0,0,255,255]),2,1);
  try { return format === "png" ? image.get_bytes() : image.get_bytes_jpeg(80); } finally { image.free(); }
}
describe("actual isolated image decoder", () => {
  it("decodes valid PNG and JPEG with exact header dimensions", async () => {
    const validator = new ImageValidator();
    try {
      for (const format of ["png", "jpeg"] as const) await expect(validator.validate(sample(format))).resolves.toEqual({ mimeType: format === "png" ? "image/png" : "image/jpeg", width:2, height:1 });
    } finally { await validator.dispose(); }
  });
  it("rejects valid-looking image header with corrupted body", async () => {
    const validator = new ImageValidator(); const broken = sample().slice(0,33);
    try { await expect(validator.validate(broken)).rejects.toThrow(/损坏|失败|退出/); } finally { await validator.dispose(); }
  });
  it("does not let caller mutate the header/payload during worker validation", async () => {
    const validator = new ImageValidator(); const bytes = sample(); const pending = validator.validate(bytes); bytes.fill(0);
    try { await expect(pending).resolves.toMatchObject({width:2,height:1}); } finally { await validator.dispose(); }
  });
  it("bounds concurrency, rejects overload and releases after worker exit", async () => {
    const validator = new ImageValidator(2500,1); const first = validator.validate(sample());
    try {
      await expect(validator.validate(sample())).rejects.toThrow(/繁忙/);
      await first;
      await expect(validator.validate(sample())).resolves.toMatchObject({width:2});
    } finally { await validator.dispose(); }
  });
  it("ends timed-out work before making capacity available", async () => {
    const validator = new ImageValidator(1,1);
    try { await expect(validator.validate(sample())).rejects.toThrow(/超时/); await expect(validator.validate(sample())).rejects.toThrow(/超时/); }
    finally { await validator.dispose(); }
  });
  it("disposal cancels in-flight work and blocks any new decoding", async () => {
    const validator = new ImageValidator(); const pending = validator.validate(sample());
    const outcome = pending.then(() => "unexpected", () => "cancelled");
    await validator.dispose(); expect(await outcome).toBe("cancelled"); await expect(validator.validate(sample())).rejects.toThrow(/已关闭/);
  });
});
