import { SearchResult, SearchOptions, SearchHistoryEntry, SearchMode, ResultsPanelEntry } from './types';

let idCounter = 0;
function generateId(): string {
    return `search-${Date.now()}-${++idCounter}`;
}

export class SearchStore {
    private history: SearchHistoryEntry[] = [];
    private activeHistoryId: string | null = null;
    private activeResults: SearchResult[] = [];
    private navigationIndex = -1;
    private listeners: Array<() => void> = [];

    addSearch(query: string, options: SearchOptions, results: SearchResult[], mode: SearchMode): string {
        const entry: SearchHistoryEntry = {
            id: generateId(),
            query,
            options,
            results: [...results],
            timestamp: Date.now(),
        };

        this.history.push(entry);

        if (mode === 'replace') {
            this.activeResults = [...results];
        } else {
            this.activeResults = [...this.activeResults, ...results];
        }

        this.activeHistoryId = entry.id;
        this.navigationIndex = -1;
        this.emit();
        return entry.id;
    }

    getHistory(): SearchHistoryEntry[] {
        return [...this.history];
    }

    getActiveResults(): SearchResult[] {
        return [...this.activeResults];
    }

    getActiveResultsPanelEntries(): ResultsPanelEntry[] {
        return this.activeResults.map((r, i) => ({
            ...r,
            globalIndex: i,
        }));
    }

    getActiveHistoryId(): string | null {
        return this.activeHistoryId;
    }

    selectHistory(id: string): void {
        const entry = this.history.find(e => e.id === id);
        if (!entry) { return; }
        this.activeHistoryId = id;
        this.activeResults = [...entry.results];
        this.navigationIndex = -1;
        this.emit();
    }

    deleteHistory(id: string): void {
        this.history = this.history.filter(e => e.id !== id);
        if (this.activeHistoryId === id) {
            this.activeResults = [];
            this.activeHistoryId = null;
            this.navigationIndex = -1;
        }
        this.emit();
    }

    getNavigationIndex(): number {
        return this.navigationIndex;
    }

    nextResult(wrap: boolean): SearchResult | undefined {
        if (this.activeResults.length === 0) { return undefined; }
        let next = this.navigationIndex + 1;
        if (next >= this.activeResults.length) {
            if (wrap) { next = 0; } else { return undefined; }
        }
        this.navigationIndex = next;
        return this.activeResults[next];
    }

    previousResult(wrap: boolean): SearchResult | undefined {
        if (this.activeResults.length === 0) { return undefined; }
        let prev = this.navigationIndex - 1;
        if (prev < 0) {
            if (wrap) { prev = this.activeResults.length - 1; } else { return undefined; }
        }
        this.navigationIndex = prev;
        return this.activeResults[prev];
    }

    setNavigationIndex(index: number): void {
        if (index >= 0 && index < this.activeResults.length) {
            this.navigationIndex = index;
        }
    }

    onChange(listener: () => void): { dispose: () => void } {
        this.listeners.push(listener);
        return {
            dispose: () => {
                this.listeners = this.listeners.filter(l => l !== listener);
            }
        };
    }

    private emit(): void {
        for (const l of this.listeners) { l(); }
    }
}
