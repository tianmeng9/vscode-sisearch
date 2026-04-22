// test/benchmark/heapSampler.ts
// 周期采样 process.memoryUsage().heapUsed,记录峰值,用于 P8 验收。
// 可独立运行,也可被其它 bench import。

export class HeapSampler {
    private peak = 0;
    private samples: Array<{ t: number; heapUsed: number; rss: number }> = [];
    private timer: NodeJS.Timeout | null = null;

    start(intervalMs: number = 200): void {
        if (this.timer) { return; }
        this.timer = setInterval(() => {
            const m = process.memoryUsage();
            this.samples.push({ t: Date.now(), heapUsed: m.heapUsed, rss: m.rss });
            if (m.heapUsed > this.peak) { this.peak = m.heapUsed; }
        }, intervalMs);
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    peakHeapMB(): number { return this.peak / 1024 / 1024; }

    report(): { peakMB: number; samples: number; durationMs: number } {
        const first = this.samples[0], last = this.samples[this.samples.length - 1];
        return {
            peakMB: this.peakHeapMB(),
            samples: this.samples.length,
            durationMs: last && first ? last.t - first.t : 0,
        };
    }
}

if (require.main === module) {
    // Usage: node out/test/benchmark/heapSampler.js <durationSeconds>
    const durationS = parseInt(process.argv[2] ?? '5', 10);
    const s = new HeapSampler();
    s.start(200);
    setTimeout(() => {
        s.stop();
        console.log(JSON.stringify(s.report(), null, 2));
    }, durationS * 1000);
}
