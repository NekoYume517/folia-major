// src/services/onlineMusic/bodianNodeModules.ts
// 给 `bodian-music-api` 用的 node: 模块替身（只覆盖它用到的三样）。
//
// 背景：这个包（AGPL，协议实现独立仓库维护）是纯 CJS，顶层 `require('node:crypto')`
// / `node:https` / `node:zlib`。桌面版由 Electron 主进程提供真 Node；Android 壳里
// 没有，所以构建时把这三个模块名 alias 到本文件（见 vite.config.ts 的
// bodianNodeAliases），由原生桥 + Web 平台能力顶上：
//
// - https.request → OkHttp（原生桥，支持 GET 带 body）
// - crypto.createHash('md5') → 本地 MD5
// - zlib.gunzipSync → DecompressionStream('gzip')（同步接口，见下）
//
// 只在原生桥存在时才是「真」实现；桌面/网页版不会走到这里（vite alias 只在
// 构建 Android 壳时启用，或用它自己的主进程实现）。

import { createNativeCrypto, createNativeHttpsRequest, isNativeBodianHttpAvailable } from './bodianNodeShim';

// ─── node:crypto ───────────────────────────────────────────────────────
export const createHash = createNativeCrypto().createHash;

// ─── node:https ────────────────────────────────────────────────────────
export const request = createNativeHttpsRequest() as never;

// ─── node:zlib ─────────────────────────────────────────────────────────
// bodian 的 http.cjs 用 gunzipSync 做「响应是 gzip 就解压」的兜底；我们的原生桥
// 已经交付解压后的字节（并清掉 content-encoding），所以正常路径不会调用它。
// 保留一个同步实现：需要时用 XHR 的同步模式 + DecompressionStream 的同步等待不可行，
// 因此这里对已被解压的输入直接原样返回，对真 gzip 输入抛出可诊断的错误。
export const gunzipSync = (input: Uint8Array, _options?: unknown): Uint8Array => {
    if (!(input.length > 2 && input[0] === 0x1f && input[1] === 0x8b)) return input;
    if (!isNativeBodianHttpAvailable()) return input;
    // 走到这里说明原生桥没解压（异常路径）。同步接口无法等待流，交回原始字节让
    // 上层的 JSON 解析失败并给出可读错误，好过静默返回空对象。
    throw new Error('bodian zlib shim: gzip payload reached gunzipSync unexpectedly');
};

export default undefined;
