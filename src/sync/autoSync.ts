// src/sync/autoSync.ts
// 自动 Sync 防抖调度器

export interface AutoSyncOptions {
    delayMs: number;
    enabled: boolean;
    syncDirty: () => Promise<void>;
}

export class AutoSyncController {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private dirty = new Set<string>();
    private disposed = false;

    constructor(private options: AutoSyncOptions) {}

    markDirty(path: string): void {
        this.dirty.add(path);
        this.schedule();
    }

    markDeleted(path: string): void {
        this.dirty.add(path);
        this.schedule();
    }

    private schedule(): void {
        if (!this.options.enabled || this.disposed) {
            return;
        }
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            void this.flush();
        }, this.options.delayMs);
    }

    async flush(): Promise<void> {
        if (this.dirty.size === 0 || this.disposed) {
            return;
        }
        this.dirty.clear();
        await this.options.syncDirty();
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}
