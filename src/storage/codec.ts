// src/storage/codec.ts
// MessagePack 编解码封装

import { decode, encode } from '@msgpack/msgpack';

export function encodeMessagePack<T>(value: T): Uint8Array {
    return encode(value);
}

export function decodeMessagePack<T>(value: Uint8Array | Buffer): T {
    return decode(value) as T;
}
