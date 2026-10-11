import { create } from 'zustand';

// src/services/lxSource/lxSourceStore.ts
// 自用 fork 的 LX 音源设置：脚本列表、总开关、目标音质与替换策略。
// 持久化到 localStorage（与桌面偏好同一机制），脚本正文原样保存——gz_ 封装的
// 脚本在装载时才解开，导入的文件多大就存多大（localStorage 5MB 内足够）。

export const LX_SOURCE_ENABLED_KEY = 'lx_source_enabled';
export const LX_SOURCE_QUALITY_KEY = 'lx_source_quality';
export const LX_SOURCE_MODE_KEY = 'lx_source_mode';
export const LX_SOURCE_SCRIPTS_KEY = 'lx_source_scripts';

export type LxSourceMode = 'fallback' | 'always';

export interface LxSourceScriptEntry {
    id: string;
    name: string;
    /** 脚本原文，或 lx-music user_api 里的 gz_ 文本。 */
    code: string;
}

interface LxSourceState {
    enabled: boolean;
    quality: string;
    mode: LxSourceMode;
    scripts: LxSourceScriptEntry[];
    /** 已装载脚本的摘要（脚本名 → 声明的音源列表），由 provider 层写回供 UI 展示。 */
    loadedSummaries: { id: string; name: string; sources: string[] }[];
    setEnabled: (enabled: boolean) => void;
    setQuality: (quality: string) => void;
    setMode: (mode: LxSourceMode) => void;
    addScript: (entry: LxSourceScriptEntry) => void;
    removeScript: (id: string) => void;
    setLoadedSummaries: (summaries: { id: string; name: string; sources: string[] }[]) => void;
}

const readBoolean = (key: string, fallback: boolean) => {
    if (typeof window === 'undefined') return fallback;
    const saved = window.localStorage.getItem(key);
    return saved === null ? fallback : saved === 'true';
};

const readString = (key: string, fallback: string) => {
    if (typeof window === 'undefined') return fallback;
    return window.localStorage.getItem(key) ?? fallback;
};

const readScripts = (): LxSourceScriptEntry[] => {
    if (typeof window === 'undefined') return [];
    try {
        const parsed = JSON.parse(window.localStorage.getItem(LX_SOURCE_SCRIPTS_KEY) ?? '[]');
        return Array.isArray(parsed)
            ? parsed.filter(entry => entry && typeof entry.id === 'string' && typeof entry.code === 'string')
            : [];
    } catch {
        return [];
    }
};

const persistScripts = (scripts: LxSourceScriptEntry[]) => {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(LX_SOURCE_SCRIPTS_KEY, JSON.stringify(scripts));
    } catch (error) {
        console.warn('[LxSource] persist scripts failed (quota?)', error);
    }
};

export const useLxSourceStore = create<LxSourceState>((set, get) => ({
    enabled: readBoolean(LX_SOURCE_ENABLED_KEY, false),
    quality: readString(LX_SOURCE_QUALITY_KEY, '320k'),
    mode: (readString(LX_SOURCE_MODE_KEY, 'fallback') === 'always' ? 'always' : 'fallback'),
    scripts: readScripts(),
    loadedSummaries: [],
    setEnabled: (enabled) => {
        if (typeof window !== 'undefined') window.localStorage.setItem(LX_SOURCE_ENABLED_KEY, String(enabled));
        set({ enabled });
    },
    setQuality: (quality) => {
        if (typeof window !== 'undefined') window.localStorage.setItem(LX_SOURCE_QUALITY_KEY, quality);
        set({ quality });
    },
    setMode: (mode) => {
        if (typeof window !== 'undefined') window.localStorage.setItem(LX_SOURCE_MODE_KEY, mode);
        set({ mode });
    },
    addScript: (entry) => {
        // 同名脚本视为更新：保留原 id，替换正文。
        const scripts = [...get().scripts];
        const existing = scripts.findIndex(script => script.name === entry.name);
        if (existing >= 0) scripts[existing] = { ...scripts[existing], code: entry.code };
        else scripts.push(entry);
        persistScripts(scripts);
        set({ scripts });
    },
    removeScript: (id) => {
        const scripts = get().scripts.filter(script => script.id !== id);
        persistScripts(scripts);
        set({ scripts });
    },
    setLoadedSummaries: (loadedSummaries) => set({ loadedSummaries }),
}));
