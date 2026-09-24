// 事件泵行缓冲（TECH §5 事实 6：stdout 常驻排空=进程红线）
// 子进程 stdout 以字节块到达；按 \n 拆行，尾半行缓冲到下一块；流结束 flush 残余。
export class LinePump {
  private buf = "";

  constructor(private readonly onLine: (line: string) => void) {}

  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.length > 0) this.onLine(line); // 空行跳过
    }
  }

  /** 流结束（子进程退出）：交付残余（撕裂尾半行也算一行——解析层判坏行跳过）。 */
  flush(): void {
    const rest = this.buf;
    this.buf = "";
    if (rest.length > 0) this.onLine(rest);
  }

  /** 重置（复用/测试）。 */
  reset(): void {
    this.buf = "";
  }
}
