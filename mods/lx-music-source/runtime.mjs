// folia-mod/runtime.mjs
// Universal runtime for LX Music (洛雪音乐) custom source scripts on Folia.
// Emulates the `globalThis.lx` script API (EVENT_NAMES / request / on / send /
// utils) over a host-provided fetch bridge, and executes one script inside a
// `new Function` scope whose `globalThis` is the sandbox object, so scripts
// never see the real renderer globals.

/** The subset of LX Music's EVENT_NAMES that source scripts actually use. */
export const EVENT_NAMES = {
    request: 'request',
    inited: 'inited',
    updateAlert: 'updateAlert',
};

/** LX source ids an Omni provider id maps onto (only providers Folia has). */
export const PROVIDER_TO_LX_SOURCE = {
    netease: 'wy',
    kugou: 'kg',
    qq: 'tx',
};

/** Canonical LX quality ladder, low → high. */
export const LX_QUALITY_RANK = ['128k', '320k', 'flac', 'flac24bit', 'hires'];

/** Folia playback quality preference → the LX quality the adapter asks for. */
export const FOLIA_TO_LX_QUALITY = {
    standard: '128k',
    high: '320k',
    lossless: 'flac',
    hires: 'flac24bit',
};

/**
 * Builds the `musicInfo` object LX scripts expect for one source id. Scripts
 * pick their id field by source (wy/tx/kw → songmid, kg → hash, mg →
 * copyrightId), so only the canonical field needs to be set.
 */
export const buildMusicInfo = (source, id) => {
    switch (source) {
        case 'kg': return { hash: id };
        case 'mg': return { copyrightId: id };
        default: return { songmid: id };
    }
};

const bytesFromBase64 = (text) => {
    if (typeof atob === 'function') {
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    return new Uint8Array(Buffer.from(text, 'base64'));
};

const bytesToString = (bytes) => {
    if (typeof TextDecoder === 'function') return new TextDecoder().decode(bytes);
    return Buffer.from(bytes).toString('utf-8');
};

/**
 * LX's user_api.json persists scripts as `gz_` + base64(deflate). This decodes
 * that envelope; plain scripts pass through untouched. Tries the zlib-wrapped
 * stream first, then the raw deflate stream.
 */
export const decodeLxScript = async (raw) => {
    if (typeof raw !== 'string' || !raw.startsWith('gz_')) return raw;
    const bytes = bytesFromBase64(raw.slice(3));
    for (const format of ['deflate', 'deflate-raw']) {
        try {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
            const buffer = await new Response(stream).arrayBuffer();
            return bytesToString(new Uint8Array(buffer));
        } catch { /* try the next framing */ }
    }
    throw new Error('cannot decode gz_ script payload');
};

const bytesToHex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/* eslint-disable no-bitwise */
// Compact MD5 (public-domain style) — hex digest. LX scripts reach MD5 only
// through `utils.crypto.md5`, which most URL-source scripts use for signatures.
// Per-op shift amounts: each round of 16 cycles its 4 values (RFC 1321).
const MD5_SHIFTS = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const rotl32 = (value, count) => ((value << count) | (value >>> (32 - count))) >>> 0;
const md5Digest = (input) => {
    const bytes = typeof input === 'string'
        ? (typeof TextEncoder === 'function' ? new TextEncoder().encode(input) : new Uint8Array(Buffer.from(input, 'utf-8')))
        : Uint8Array.from(input);
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
            let F; let g;
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
    new DataView(out.buffer).setUint32(0, a0, true);
    new DataView(out.buffer).setUint32(4, b0, true);
    new DataView(out.buffer).setUint32(8, c0, true);
    new DataView(out.buffer).setUint32(12, d0, true);
    return out;
};
/* eslint-enable no-bitwise */

const bytesFromValue = (value) => {
    if (typeof value === 'string') {
        return typeof TextEncoder === 'function'
            ? new TextEncoder().encode(value)
            : new Uint8Array(Buffer.from(value, 'utf-8'));
    }
    if (value instanceof Uint8Array) return value;
    if (Array.isArray(value)) return Uint8Array.from(value);
    throw new Error(`lx.utils.buffer: unsupported value ${typeof value}`);
};

// LX's `utils` surface: buffer encoding helpers plus MD5. Advanced crypto
// (AES/RSA) is intentionally absent — URL-source scripts don't need it, and a
// loud failure beats a silent wrong signature.
const makeUtils = (log) => {
    const unsupported = (name) => () => {
        log.error(`lx.utils.crypto.${name} is not implemented by this adapter`);
        throw new Error(`lx.utils.crypto.${name} not supported`);
    };
    return {
        buffer: {
            from: bytesFromValue,
            bufToString: (value, format = 'utf-8') => {
                if (typeof value === 'string') return value;
                const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
                switch (String(format).toLowerCase()) {
                    case 'hex': return bytesToHex(bytes);
                    case 'base64': return btoa(String.fromCharCode(...bytes));
                    case 'utf-8':
                    case 'utf8':
                    default: return bytesToString(bytes);
                }
            },
        },
        crypto: {
            md5: (...parts) => {
                if (parts.length === 1) return bytesToHex(md5Digest(parts[0]));
                const total = parts.reduce((sum, part) => sum + bytesFromValue(part).length, 0);
                const merged = new Uint8Array(total);
                let offset = 0;
                for (const part of parts) {
                    const bytes = bytesFromValue(part);
                    merged.set(bytes, offset);
                    offset += bytes.length;
                }
                return bytesToHex(md5Digest(merged));
            },
            randomBytes: (count) => {
                const bytes = new Uint8Array(Number(count) || 0);
                if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
                else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
                return bytes;
            },
            aesEn: unsupported('aesEn'),
            aesDe: unsupported('aesDe'),
            rsaEncrypt: unsupported('rsaEncrypt'),
        },
    };
};

const makeConsole = (log) => {
    const asInfo = (...args) => log.info(args.map(arg => {
        try { return typeof arg === 'string' ? arg : JSON.stringify(arg); } catch { return String(arg); }
    }).join(' '));
    return {
        log: asInfo, debug: asInfo, info: asInfo,
        warn: (...args) => log.warn(...args),
        error: (...args) => log.error(...args),
        group: asInfo, groupEnd: () => {}, groupCollapsed: asInfo,
        table: asInfo, dir: asInfo, trace: asInfo, assert: asInfo, count: () => {},
        time: () => {}, timeEnd: () => {}, timeLog: () => {},
    };
};

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`lx script ${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
        value => { clearTimeout(timer); resolve(value); },
        error => { clearTimeout(timer); reject(error); },
    );
});

/**
 * Creates one isolated runtime for one LX script and executes it. `host`:
 * { netFetch(url, opts), log, scriptInfo, version?, env?, requestTimeoutMs?,
 *   handlerTimeoutMs? }. Returns { resolveMusicUrl, sources, inited, dispose }.
 */
export const createLxRuntime = (code, host) => {
    const state = {
        handler: null,
        sources: null,
        inited: false,
        waiters: [],
    };
    const log = {
        info: (message, details) => host.log.info(`[LX] ${message}`, ...(details === undefined ? [] : [details])),
        warn: (message, details) => host.log.warn(`[LX] ${message}`, ...(details === undefined ? [] : [details])),
        error: (message, details) => host.log.error(`[LX] ${message}`, ...(details === undefined ? [] : [details])),
    };
    const consoleShim = makeConsole(log);

    const requestTimeoutMs = Number(host.requestTimeoutMs) || 15000;
    const handlerTimeoutMs = Number(host.handlerTimeoutMs) || 30000;

    // lx.request: callback-style HTTP over the host's fetch bridge. JSON bodies
    // are auto-parsed, matching LX Music's own request behavior.
    const request = (url, options = {}, callback = () => {}) => {
        let body = options.body;
        if (body != null && typeof body !== 'string') body = JSON.stringify(body);
        host.netFetch(String(url), {
            method: String(options.method || 'GET').toUpperCase(),
            ...(options.headers ? { headers: options.headers } : {}),
            ...(body != null ? { body } : {}),
            timeoutMs: Math.min(60000, Math.max(2000, Number(options.timeoutMs) || requestTimeoutMs)),
        }).then((response) => {
            let payload = response.text();
            try { payload = JSON.parse(payload); } catch { /* keep raw text */ }
            callback(null, {
                statusCode: response.status,
                headers: response.headers,
                body: payload,
            });
        }).catch((error) => {
            callback(new Error(String(error?.message ?? error)));
        });
        return { abort() {} };
    };

    const lx = {
        EVENT_NAMES,
        env: host.env ?? 'desktop',
        version: host.version ?? '2.1.0',
        currentScriptInfo: host.scriptInfo ?? { name: '', version: '', description: '', homepage: '', rawScript: code },
        utils: makeUtils(log),
        on: (event, handler) => {
            if (event === EVENT_NAMES.request && typeof handler === 'function') state.handler = handler;
        },
        send: (event, data) => {
            if (event === EVENT_NAMES.inited) {
                state.sources = (data && typeof data === 'object' && data.sources) || null;
                state.inited = true;
                state.waiters.splice(0).forEach(resolve => resolve());
                log.info(`script "${state.scriptName}" inited`, state.sources ?? undefined);
            } else if (event === EVENT_NAMES.updateAlert) {
                log.info('script posted an update alert', data);
            } else {
                log.info(`script sent event "${String(event)}"`, data);
            }
        },
        request,
    };

    state.scriptName = host.scriptInfo?.name ?? 'unnamed';

    // The `globalThis` parameter shadows the real one inside the script scope:
    // sandbox.lx is what `globalThis.lx` destructuring reads, and the `lx`
    // parameter covers scripts that reference it bare.
    const sandbox = { lx, console: consoleShim };
    new Function('globalThis', 'lx', 'console', code)
        .call(sandbox, sandbox, lx, consoleShim);

    const whenInited = () => new Promise((resolve) => {
        if (state.inited) resolve();
        else state.waiters.push(resolve);
    });

    return {
        name: state.scriptName,
        get sources() { return state.sources; },
        get inited() { return state.inited; },
        whenInited,
        /** Asks the script's `on(request)` handler for a music URL. */
        resolveMusicUrl: async (source, musicInfo, quality) => {
            if (!state.handler) throw new Error('script never registered a request handler');
            const result = await withTimeout(
                Promise.resolve(state.handler({ source, action: 'musicUrl', info: { musicInfo, type: quality } })),
                handlerTimeoutMs,
                'musicUrl',
            );
            if (typeof result === 'string' && result) return result;
            if (result && typeof result === 'object' && typeof result.url === 'string') return result.url;
            throw new Error(`script returned no url (source=${source}, quality=${quality})`);
        },
    };
};

/** Picks the best quality a script declared for one source, given a preferred one. */
export const pickLxQuality = (sources, source, preferred) => {
    const declared = sources?.[source]?.qualitys;
    if (!Array.isArray(declared) || declared.length === 0) return preferred;
    if (declared.includes(preferred)) return preferred;
    const preferredIndex = LX_QUALITY_RANK.indexOf(preferred);
    const ranked = declared
        .filter(q => LX_QUALITY_RANK.includes(q))
        .sort((a, b) => LX_QUALITY_RANK.indexOf(a) - LX_QUALITY_RANK.indexOf(b));
    const below = ranked.filter(q => LX_QUALITY_RANK.indexOf(q) <= preferredIndex);
    return below[below.length - 1] ?? ranked[0] ?? preferred;
};
