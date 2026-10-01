import { describe, expect, it } from "vitest";
import { classifyAttachmentName, decodeTextAttachment, inspectImageHeader } from "../../apps/server/src/http/attachment-bytes.ts";
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(b); b.writeUInt32BE(13,8); b.write("IHDR",12,"ascii"); b.writeUInt32BE(width,16); b.writeUInt32BE(height,20); return b;
}
describe("bounded attachment byte preflight (not decoder acceptance)", () => {
  it("allows declared PNG/JPEG and ordinary text/code", () => {
    for (const name of ["1.png", "照相.JPG", "photo.jpeg"]) expect(classifyAttachmentName(name)).toBe("image");
    for (const name of ["README.md", "hello.py", "x.tsx", "x.cpp", "script.sh", "data.json", "test.txt"]) expect(classifyAttachmentName(name)).toBe("text");
  });
  it("rejects archives, binaries, unsupported containers and paths", () => {
    for (const name of ["a.zip", "a.exe", "a.pdf", "a.docx", "a.gif", "a.webp", "../x.png", "x", ".env"]) expect(() => classifyAttachmentName(name)).toThrow();
  });
  it("preserves literal code and unicode without executing or interpreting", () => {
    const text = "<script>console.log('内容')</script>\r\n\treturn 1;\n";
    expect(decodeTextAttachment(Buffer.from(text))).toBe(text);
  });
  it("rejects invalid UTF8 rather than replace corrupt bytes", () => {
    expect(() => decodeTextAttachment(Buffer.from([0xff,0xfe,0x61]))).toThrow(/UTF-8/);
  });
  it("rejects binary control data and strict size limits", () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0]), Buffer.from([0x1b,65]), Buffer.alloc(48*1024+1,65)]) expect(() => decodeTextAttachment(bytes)).toThrow();
    expect(decodeTextAttachment(Buffer.alloc(48*1024,65))).toHaveLength(48*1024);
  });
  it("bounds PNG dimensions before worker decoding", () => {
    expect(inspectImageHeader(pngHeader(100, 200))).toEqual({ mimeType: "image/png", width: 100, height: 200 });
    expect(() => inspectImageHeader(pngHeader(10000, 10000))).toThrow(/4000/);
    expect(() => inspectImageHeader(pngHeader(0, 1))).toThrow();
  });
  it("does not mistake filename/MIME or a partial signature for image bytes", () => {
    for (const bytes of [Buffer.from("not image"), pngHeader(1,1).subarray(0,24), Buffer.alloc(10*1024*1024+1)]) expect(() => inspectImageHeader(bytes)).toThrow();
  });
  it("reads JPEG SOF bounds but does not claim complete decode", () => {
    const b = Buffer.from([0xff,0xd8,0xff,0xc0,0,8,8,0,10,0,20,0,0xff,0xd9]);
    expect(inspectImageHeader(b)).toEqual({ mimeType: "image/jpeg", width: 20, height: 10 });
    expect(() => inspectImageHeader(b.subarray(0,9))).toThrow();
  });
  it("rejects contradictory JPEG frame headers", () => {
    const sof = Buffer.from([0xff,0xc0,0,8,8,0,10,0,20,0]);
    expect(() => inspectImageHeader(Buffer.concat([Buffer.from([0xff,0xd8]),sof,sof,Buffer.from([0xff,0xd9])]))).toThrow(/冲突/);
  });
});
