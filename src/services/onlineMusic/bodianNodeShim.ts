// src/services/onlineMusic/bodianNodeShim.ts
// Android 上的「Node 运行时替身」：bodian-music-api 是纯 CJS 包，只用三样 Node 能力
// —— node:https（发请求）、node:crypto（md5 签名）、node:zlib（gunzip 响应）。
// 桌面版由 Electron 主进程提供真 Node；Android 壳里没有，这里用原生桥（OkHttp，
// 见 android 的 NativeHttpBridge.java）加 Web 平台已有的等价物补齐：
//
// - 请求：window.__FOLIA_NATIVE_HTTP__.send(...)，支持 GET 带 body（波点协议必需，
//   CapacitorHttp 做不到），返回 base64 原始字节；
// - md5：Web Crypto 的 crypto.subtle.digest('MD5') 在 Chromium 里不可用，故用
//   本地实现（与 lxRuntime 里那份同源的紧凑版本）；
// - gunzip：DecompressionStream('gzip')。
//
// 返回值形状对齐 bodian 的 requestJson 期望：{ status, headers, body 文本 }。

const NATIVE_BRIDGE_KEY = '__FOLIA_NATIVE_HTTP__';

interface NativeHttpResult {
    status?: number;
    headers?: Record<string, string>;
    bodyBase64?: string;
    error?: string;
}

interface NativeHttpBridge {
    send(url: string, method: string, headersJson: string, payloadBase64: string): string;
}

const getBridge = (): NativeHttpBridge | null => {
    if (typeof window === 'undefined') return null;
    const bridge = (window as unknown as Record<string, unknown>)[NATIVE_BRIDGE_KEY];
    return bridge && typeof (bridge as NativeHttpBridge).send === 'function'
        ? (bridge as NativeHttpBridge)
        : null;
};

export const isNativeBodianHttpAvailable = (): boolean => getBridge() !== null;

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
};

const base64ToBytes = (text: string): Uint8Array => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

/** 极简 EventEmitter：bodian 的 requestJson 用到 on('data'|'end'|'error') 与 destroy。 */
class MinimalEmitter {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    on(event: string, listener: (...args: unknown[]) => void): this {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
        return this;
    }

    emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
}

/** 原生请求 + gunzip + JSON 解析，polyfill 成 node:https.request 的调用形状。 */
export const createNativeHttpsRequest = () => (
    options: { url: string; method?: string },
    onResponse: (response: MinimalEmitter & {
        statusCode: number;
        headers: Record<string, string>;
    }) => void,
) => {
    const request = new MinimalEmitter() as MinimalEmitter & {
        setHeader(name: string, value: string): void;
        end(body?: string): void;
        destroy(): void;
        abort(): void;
    };
    const headers: Record<string, string> = {};
    let aborted = false;
    request.setHeader = (name, value) => { headers[name] = value; };
    request.destroy = () => { aborted = true; };
    request.abort = () => { aborted = true; };
    request.end = (body?: string) => {
        const bridge = getBridge();
        if (!bridge) {
            request.emit('error', new Error('native http bridge is unavailable'));
            return;
        }
        // 诊断：把包实际发出的 URL/方法/请求体暴露出来（对照桌面 Node 的行为）。
        try {
            (globalThis as unknown as Record<string, unknown>).__FOLIA_BODIAN_LAST_REQ__ = {
                url: options.url,
                method: options.method ?? 'GET',
                headers: { ...headers },
                body: body ?? null,
            };
        } catch { /* diagnostics only */ }
        void (async () => {
            try {
                const payload = body ? bytesToBase64(new TextEncoder().encode(body)) : '';
                const raw = bridge.send(options.url, options.method ?? 'GET', JSON.stringify(headers), payload);
                const parsed = JSON.parse(raw) as NativeHttpResult;
                if (aborted) return;
                if (parsed.error) {
                    request.emit('error', new Error(parsed.error));
                    return;
                }
                const response = new MinimalEmitter() as MinimalEmitter & {
                    statusCode: number;
                    headers: Record<string, string>;
                };
                response.statusCode = parsed.status ?? 0;
                // 头名统一小写（原生桥也做了，这里是双保险）。
                const rawHeaders = parsed.headers ?? {};
                response.headers = Object.fromEntries(
                    Object.entries(rawHeaders).map(([name, value]) => [name.toLowerCase(), value]),
                );
                const bytes = base64ToBytes(parsed.bodyBase64 ?? '');
                const encoding = String(response.headers['content-encoding'] ?? '');
                // bodian 的 requestJson 只在「Chromium 已解压但保留头」时才自己 gunzip；
                // 我们这里给的是原生原始字节，所以先按 gzip 解开再交出去。
                const looksGzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
                const deliver = (chunk: Uint8Array) => {
                    onResponse(response);
                    if (chunk.length > 0) response.emit('data', chunk);
                    response.emit('end');
                };
                if (encoding.includes('gzip') && looksGzipped) {
                    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
                    const decoded = new Uint8Array(await new Response(stream).arrayBuffer());
                    // 解压后清掉编码头，bodian 就不会试图再解一次。
                    response.headers = { ...response.headers, 'content-encoding': '' };
                    if (aborted) return;
                    deliver(decoded);
                } else {
                    deliver(bytes);
                }
            } catch (error) {
                request.emit('error', error);
            }
        })();
    };
    return request;
};

/* eslint-disable no-bitwise */
// 紧凑 MD5（与 src/services/lxSource/lxRuntime.mjs 同源），签名用。
const MD5_SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const rotl32 = (value: number, count: number): number => ((value << count) | (value >>> (32 - count))) >>> 0;

const md5Bytes = (input: string): Uint8Array => {
    const bytes = new TextEncoder().encode(input);
    const len = bytes.length;
    const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
    withPad.set(bytes);
    withPad[len] = 0x80;
    const bitLen = len * 8;
    const view = new DataView(withPad.buffer);
    view.setUint32(withPad.length - 8, bitLen >>> 0, true);
    view.setUint32(withPad.length - 4, Math.floor(bitLen / 0x100000000), true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i += 1) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

    for (let chunk = 0; chunk < withPad.length; chunk += 64) {
        const M = new Uint32Array(16);
        for (let i = 0; i < 16; i += 1) M[i] = view.getUint32(chunk + i * 4, true);
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i += 1) {
            let F: number; let g: number;
            if (i < 16) { F = (B & C) | (~B & D); g = i; }
            else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
            else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
            else { F = C ^ (B | ~D); g = (7 * i) % 16; }
            F = (F + A + K[i] + M[g]) >>> 0;
            A = D; D = C; C = B; B = (B + rotl32(F, MD5_SHIFTS[i])) >>> 0;
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, a0, true);
    outView.setUint32(4, b0, true);
    outView.setUint32(8, c0, true);
    outView.setUint32(12, d0, true);
    return out;
};
/* eslint-enable no-bitwise */

/* eslint-disable no-bitwise */
// ─── Buffer 替身 ────────────────────────────────────────────────────────
// bodian 的 http.cjs 用 Node 的 Buffer 处理响应字节：Buffer.concat(chunks)、
// 下标访问 bytes[0]（gzip 魔数）、decoded.toString('utf8')，qrcode 还用 to/from base64。
// WebView 没有 Buffer，而这是包的内部用法（不能改包），所以做一个最小替身：
// 每个「Buffer」就是真 Uint8Array（下标、length、set 都照旧）外加一个实例级 toString。
type MiniBufferInstance = Uint8Array & { toString(encoding?: string): string };

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

const withNodeToString = (bytes: Uint8Array): MiniBufferInstance => {
    const buffer = bytes as MiniBufferInstance;
    // 覆盖 Uint8Array 的 toString（默认是逗号分隔的数字列表），改成 Node 语义。
    buffer.toString = (encoding = 'utf8'): string => {
        switch (String(encoding).toLowerCase()) {
            case 'hex':
                return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
            case 'base64': {
                let binary = '';
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                }
                return btoa(binary);
            }
            case 'utf8':
            case 'utf-8':
            default:
                return decodeUtf8(bytes);
        }
    };
    return buffer;
};

const MiniBuffer = {
    concat(chunks: ArrayLike<Uint8Array>, totalLength?: number): MiniBufferInstance {
        const total = typeof totalLength === 'number'
            ? totalLength
            : Array.from(chunks).reduce((sum, chunk) => sum + chunk.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of Array.from(chunks)) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }
        return withNodeToString(merged);
    },
    from(value: string | Uint8Array | ArrayBuffer, encoding?: string): MiniBufferInstance {
        if (typeof value === 'string') {
            if (encoding === 'base64') {
                const binary = atob(value);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
                return withNodeToString(bytes);
            }
            if (encoding === 'hex') {
                const bytes = new Uint8Array(Math.floor(value.length / 2));
                for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(value.substr(i * 2, 2), 16);
                return withNodeToString(bytes);
            }
            return withNodeToString(new TextEncoder().encode(value));
        }
        return withNodeToString(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    },
    byteLength(value: string, encoding: string = 'utf8'): number {
        if (encoding === 'base64') return Math.floor(value.length * 3 / 4);
        if (encoding === 'hex') return Math.floor(value.length / 2);
        return new TextEncoder().encode(value).length;
    },
    isBuffer(value: unknown): boolean {
        return value instanceof Uint8Array;
    },
};
/* eslint-enable no-bitwise */

/** 把 Buffer 挂到 globalThis（包的内部代码直接引用全局 Buffer）。 */
export const installMiniBuffer = (): void => {
    const globalScope = globalThis as unknown as { Buffer?: typeof MiniBuffer };
    if (typeof globalScope.Buffer === 'undefined') globalScope.Buffer = MiniBuffer;
};

const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** node:crypto 的最小替身：bodian 只用到 createHash('md5').update().digest()。 */
export const createNativeCrypto = () => ({
    createHash: (algorithm: string) => {
        if (String(algorithm).toLowerCase() !== 'md5') {
            throw new Error(`native crypto shim only implements md5 (asked for ${algorithm})`);
        }
        let acc = '';
        return {
            update: (value: string | Uint8Array) => {
                acc += typeof value === 'string' ? value : new TextDecoder().decode(value);
                return { digest: (encoding?: string) => (encoding === 'hex' ? bytesToHex(md5Bytes(acc)) : md5Bytes(acc)) };
            },
        };
    },
});
