// 事件泵行缓冲（TECH §5 事实 6：stdout 常驻排空=进程红线）
// 子进程 stdout 以字节块到达；按 \n 拆行，尾半行缓冲到下一块；流结束 flush 残余。
// 多字节安全（送审前自审修复）：feed 收 Buffer，内部经 StringDecoder 跨块拼接——
// 逐块独立 decode 会把横跨 chunk 边界的中文字符撕成 U+FFFD（中文会话场景必踩），测试有多字节跨块用例。
import { StringDecoder } from "node:string_decoder";
export class LinePump {
    onLine;
    buf = "";
    dec = new StringDecoder("utf8");
    constructor(onLine) {
        this.onLine = onLine;
    }
    feed(chunk) {
        const s = this.dec.write(chunk); // 末尾不完整多字节序列由 decoder 缓冲，不产替换符
        if (s.length === 0)
            return;
        this.buf += s;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, i);
            this.buf = this.buf.slice(i + 1);
            if (line.length > 0)
                this.onLine(line); // 空行跳过
        }
    }
    /** 流结束（子进程退出）：交付残余（撕裂尾半行也算一行——解析层判坏行跳过）。 */
    flush() {
        const tail = this.dec.end(); // 多字节残片交给解析层判坏行（如实呈现，不静默丢）
        const rest = this.buf + tail;
        this.buf = "";
        if (rest.length > 0)
            this.onLine(rest);
    }
    /** 重置（复用/测试）。 */
    reset() {
        this.buf = "";
        this.dec = new StringDecoder("utf8");
    }
}
//# sourceMappingURL=line-pump.js.map