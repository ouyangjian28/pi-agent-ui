export declare class LinePump {
    private readonly onLine;
    private buf;
    private dec;
    constructor(onLine: (line: string) => void);
    feed(chunk: Buffer): void;
    /** 流结束（子进程退出）：交付残余（撕裂尾半行也算一行——解析层判坏行跳过）。 */
    flush(): void;
    /** 重置（复用/测试）。 */
    reset(): void;
}
//# sourceMappingURL=line-pump.d.ts.map