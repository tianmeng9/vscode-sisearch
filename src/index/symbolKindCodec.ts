import type { SymbolKind } from './indexTypes';

export const SYMBOL_KIND_ID: Record<SymbolKind, number> = {
    function: 0, class: 1, struct: 2, enum: 3, typedef: 4,
    namespace: 5, macro: 6, variable: 7, union: 8,
};

export const SYMBOL_KIND_NAME: SymbolKind[] = [
    'function', 'class', 'struct', 'enum', 'typedef',
    'namespace', 'macro', 'variable', 'union',
];

export function encodeSymbolKind(kind: SymbolKind): number {
    return SYMBOL_KIND_ID[kind];
}

export function decodeSymbolKind(id: number): SymbolKind {
    if (id >= 0 && id < SYMBOL_KIND_NAME.length) { return SYMBOL_KIND_NAME[id]; }
    return 'variable';
}
