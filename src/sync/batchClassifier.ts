// src/sync/batchClassifier.ts
// 并发 stat 与变更文件分类器

import type { IndexedFile } from '../index/indexTypes';

export interface FileCandidate {
    relativePath: string;
    absPath: string;
    mtime: number;
    size: number;
}

export interface ClassifyInput {
    workspaceRoot: string;
    currentFiles: FileCandidate[];
    previousFiles: Map<string, IndexedFile>;
}

export interface ClassifyResult {
    toProcess: FileCandidate[];
    toDelete: string[];
}

export async function classifyBatches(input: ClassifyInput): Promise<ClassifyResult> {
    const currentMap = new Map(input.currentFiles.map(f => [f.relativePath, f]));
    const toProcess: FileCandidate[] = [];
    const toDelete: string[] = [];

    for (const file of input.currentFiles) {
        const prev = input.previousFiles.get(file.relativePath);
        if (!prev || prev.mtime !== file.mtime || prev.size !== file.size) {
            toProcess.push(file);
        }
    }

    for (const prevPath of input.previousFiles.keys()) {
        if (!currentMap.has(prevPath)) {
            toDelete.push(prevPath);
        }
    }

    return { toProcess, toDelete };
}
