// src/storage/codec.ts
// MessagePack 编解码封装
import { decode, decodeMulti, encode } from '@msgpack/msgpack';

export function encodeMessagePack<T>(value: T): Uint8Array {
    return encode(value);
}

export function decodeMessagePack<T>(value: Uint8Array | Buffer): T {
    return decode(value) as T;
}

/**
 * 顺序解码 buffer 里串联的多个 msgpack top-level 值。
 * 旧格式的单数组文件等价于 "只有一个 top-level 值",也能被正常迭代出来。
 * @msgpack/msgpack 的 decodeMulti 返回 Generator,消费方自己决定如何聚合。
 */
export function* decodeMessagePackMulti<T>(value: Uint8Array | Buffer): Generator<T> {
    for (const chunk of decodeMulti(value)) {
        yield chunk as T;
    }
}
