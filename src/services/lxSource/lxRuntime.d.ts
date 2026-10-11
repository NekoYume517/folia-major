// src/services/lxSource/lxRuntime.d.ts
// lxRuntime.mjs（自用 fork 内置的 LX 音源运行时）的类型声明。

export interface LxNetFetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
}

export interface LxNetFetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    /** 同步返回（FoliumFetchResponse 契约），调用方按同步读。 */
    text(): string;
}

export interface LxRuntimeHost {
    netFetch: (url: string, options: LxNetFetchOptions) => Promise<LxNetFetchResponse>;
    log: {
        info: (message: string, details?: unknown) => void;
        warn: (message: string, details?: unknown) => void;
        error: (message: string, details?: unknown) => void;
    };
    scriptInfo?: { name: string; version: string; description: string; homepage: string; rawScript: string };
    env?: string;
    version?: string;
    requestTimeoutMs?: number;
    handlerTimeoutMs?: number;
}

export interface LxRuntime {
    name: string;
    readonly sources: Record<string, { type?: string; actions?: string[]; qualitys?: string[] }> | null;
    readonly inited: boolean;
    whenInited(): Promise<void>;
    resolveMusicUrl(source: string, musicInfo: Record<string, string>, quality: string): Promise<string>;
}

export declare const EVENT_NAMES: Record<string, string>;
export declare const PROVIDER_TO_LX_SOURCE: Record<string, string>;
export declare const LX_QUALITY_RANK: string[];
export declare const FOLIA_TO_LX_QUALITY: Record<string, string>;
export declare const buildMusicInfo: (source: string, id: string) => Record<string, string>;
export declare const decodeLxScript: (raw: string) => Promise<string>;
export declare const createLxRuntime: (code: string, host: LxRuntimeHost) => LxRuntime;
export declare const pickLxQuality: (sources: LxRuntime['sources'], source: string, preferred: string) => string | null;
