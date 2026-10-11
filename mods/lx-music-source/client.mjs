// folia-mod/client.mjs
// Folia (Folium 1) mod: runs LX Music custom source scripts and feeds their
// music URLs into Omni's audio resolution through the experimental
// `omni.hooks.audioSourceResolved` event. Songs are warmed on
// `playback.songChanged` because hook handlers are abandoned after 1.5 s —
// a cold third-party API (onrender free tier can take 5–30 s) must be hit
// before playback asks, and answered from cache.

import {
    createLxRuntime,
    decodeLxScript,
    pickLxQuality,
    buildMusicInfo,
    PROVIDER_TO_LX_SOURCE,
    FOLIA_TO_LX_QUALITY,
} from './runtime.mjs';

// Cache TTL for one resolved URL. LX source URLs are short-lived signed links.
const URL_TTL_MS = 10 * 60 * 1000;
// Cache entries kept in memory; URLs expire anyway.
const CACHE_MAX = 200;
// The host abandons async hook handlers after 1.5 s; stay under it.
const HOOK_RACE_MS = 1200;
// Storage key holding the imported scripts: [{ id, name, code }].
const STORAGE_SCRIPTS = 'scripts';

const extractScriptName = (code, fallback) => {
    const match = /@name\s+(.+)/.exec(code.slice(0, 2000));
    return (match?.[1] ?? '').trim() || fallback;
};

export default async function activate(folium) {
    // Mods also activate for export sessions; only the main window owns Omni.
    if (folium.env?.context !== 'main') return undefined;

    const settings = folium.registries.settingsSections.register({
        id: 'lx-source',
        label: { 'zh-CN': 'LX 音乐音源', en: 'LX Music source' },
        description: {
            'zh-CN': '导入洛雪音乐音源脚本（.js 或 user_api 里的 gz_ 文本），为网易云/酷狗/QQ 在线歌曲解析播放直链。目标音质仅对声明了音质的脚本生效。',
            en: 'Import LX Music source scripts (.js or gz_ text from user_api); resolves playback URLs for Netease/Kugou/QQ songs. The quality preference applies to scripts that declare their qualities.',
        },
        settings: [
            { key: 'enabled', type: 'boolean', defaultValue: true, label: { 'zh-CN': '启用适配层', en: 'Enable adapter' } },
            {
                key: 'mode',
                type: 'select',
                defaultValue: 'fallback',
                label: { 'zh-CN': '替换策略', en: 'Replace mode' },
                options: [
                    { value: 'fallback', label: { 'zh-CN': '仅兜底（内置源失败时使用）', en: 'Fallback only (when the built-in source fails)' } },
                    { value: 'always', label: { 'zh-CN': '总是替换（优先 LX 音源）', en: 'Always replace (LX source first)' } },
                ],
            },
            {
                key: 'quality',
                type: 'select',
                defaultValue: '320k',
                label: { 'zh-CN': '目标音质', en: 'Target quality' },
                options: [
                    { value: '128k', label: { 'zh-CN': '128k', en: '128k' } },
                    { value: '320k', label: { 'zh-CN': '320k', en: '320k' } },
                    { value: 'flac', label: { 'zh-CN': '无损 FLAC', en: 'Lossless FLAC' } },
                    { value: 'flac24bit', label: { 'zh-CN': 'Hi-Res 24bit', en: 'Hi-Res 24bit' } },
                ],
            },
        ],
    });

    const cache = new Map();
    const inflight = new Map();
    let runtimes = [];
    let disposed = false;

    const setCache = (key, url) => {
        if (cache.size >= CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { url, expiresAt: Date.now() + URL_TTL_MS });
    };

    const readCached = (key) => {
        const hit = cache.get(key);
        return hit && hit.expiresAt > Date.now() + 5000 ? hit.url : null;
    };

    const loadScripts = async () => {
        const previous = runtimes;
        runtimes = [];
        const entries = Array.isArray(await folium.storage.get(STORAGE_SCRIPTS))
            ? await folium.storage.get(STORAGE_SCRIPTS)
            : [];
        for (const entry of entries) {
            try {
                const code = await decodeLxScript(entry.code);
                const runtime = createLxRuntime(code, {
                    netFetch: (url, options) => folium.net.fetch(url, options),
                    log: folium.log,
                    scriptInfo: { name: entry.name, version: '', description: '', homepage: '', rawScript: code },
                });
                runtimes.push({ id: entry.id, name: entry.name, runtime });
            } catch (error) {
                folium.log.error(`LX source script "${entry.name}" failed to load`, error);
            }
        }
        // Only tear the old runtimes down after the new ones took over.
        void previous;
        folium.log.info(`LX source adapter loaded ${runtimes.length} script(s)`);
        return runtimes;
    };

    /** Resolves one song URL through the imported scripts, caching the result. */
    const resolveUrl = (lxSource, songId, preferredQuality) => {
        const key = `${lxSource}:${songId}`;
        const cached = readCached(key);
        if (cached) return Promise.resolve(cached);
        const running = inflight.get(key);
        if (running) return running;
        const attempt = (async () => {
            const qualityPreference = String(settings.params.get().quality || '320k');
            for (const { name, runtime } of runtimes) {
                try {
                    const quality = pickLxQuality(runtime.sources, lxSource, qualityPreference);
                    if (quality == null) continue;
                    const url = await runtime.resolveMusicUrl(lxSource, buildMusicInfo(lxSource, songId), quality);
                    if (url) {
                        setCache(key, url);
                        inflight.delete(key);
                        return url;
                    }
                } catch (error) {
                    folium.log.warn(`LX source "${name}" failed for ${lxSource}:${songId}`, error);
                }
            }
            inflight.delete(key);
            return null;
        })();
        inflight.set(key, attempt);
        return attempt;
    };

    // Warm the cache as soon as a song appears, before playback resolves URLs.
    const warm = (song) => {
        if (disposed || !song?.id || !song.source) return;
        const lxSource = PROVIDER_TO_LX_SOURCE[song.source];
        if (!lxSource) return;
        const preference = FOLIA_TO_LX_QUALITY[String(settings.params.get().quality || '320k')] ?? undefined;
        void resolveUrl(lxSource, String(song.id), preference);
    };

    const songChangedDisposer = folium.events.on('playback.songChanged', ({ song }) => warm(song));
    const current = folium.playback.getState().song;
    if (current) warm(current);

    const hooks = folium.experimental?.['omni.hooks'];
    const hookDisposer = hooks?.on('audioSourceResolved', async (event) => {
        const song = event.song;
        const lxSource = song?.source ? PROVIDER_TO_LX_SOURCE[song.source] : null;
        if (!lxSource || !song.id) return;
        if (!settings.params.get().enabled) return;
        if (settings.params.get().mode !== 'always' && event.url) return;
        const key = `${lxSource}:${String(song.id)}`;
        const cached = readCached(key);
        if (cached) {
            event.url = cached;
            return;
        }
        // Kick the resolution off (it keeps running and fills the cache), but
        // only ride it for the hook's remaining time budget.
        const attempt = resolveUrl(lxSource, String(song.id));
        const raced = await Promise.race([
            attempt,
            new Promise(resolve => setTimeout(() => resolve(null), HOOK_RACE_MS)),
        ]);
        if (typeof raced === 'string' && raced) event.url = raced;
    }, { priority: 'low' });

    const addScript = async (raw, fallbackName) => {
        const code = await decodeLxScript(raw);
        const name = extractScriptName(code, fallbackName || `script-${Date.now()}`);
        const entries = Array.isArray(await folium.storage.get(STORAGE_SCRIPTS))
            ? await folium.storage.get(STORAGE_SCRIPTS)
            : [];
        const id = `lx_${Date.now().toString(36)}`;
        const existing = entries.findIndex(entry => entry.name === name);
        if (existing >= 0) entries[existing] = { ...entries[existing], code };
        else entries.push({ id, name, code });
        await folium.storage.set(STORAGE_SCRIPTS, entries);
        await loadScripts();
        return name;
    };

    const disposers = [
        songChangedDisposer,
        ...(hookDisposer ? [hookDisposer] : []),
    ];

    folium.registries.commands.register({
        id: 'lx-source-import-file',
        label: { 'zh-CN': 'LX 音源：从文件导入脚本', en: 'LX source: import script from file' },
        description: {
            'zh-CN': '选择一个洛雪音源脚本文件（.js 或含 gz_ 文本的文件）导入。',
            en: 'Pick an LX source script file (.js or a file containing gz_ text) to import.',
        },
        run: async () => {
            const handle = await folium.ui.pickFile({ accept: 'any' });
            if (!handle) return;
            const response = await fetch(handle.url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const name = await addScript(await response.text(), handle.name.replace(/\.(js|mjs|txt)$/i, ''));
            folium.ui.toast(`已导入音源脚本：${name}`, { type: 'success' });
        },
    });

    folium.registries.commands.register({
        id: 'lx-source-import-url',
        label: { 'zh-CN': 'LX 音源：从 URL 导入脚本', en: 'LX source: import script from URL' },
        description: {
            'zh-CN': '下载一个音源脚本并导入（走主进程网络，不受 CORS 限制）。',
            en: 'Downloads an LX source script and imports it (host network, no CORS limits).',
        },
        params: [
            {
                key: 'url',
                type: 'text',
                label: { 'zh-CN': '脚本 URL', en: 'Script URL' },
                placeholder: 'https://…/source.js',
                defaultValue: '',
            },
        ],
        run: async ({ values }) => {
            const url = String(values.url || '').trim();
            if (!url) throw new Error('URL is required');
            const response = await folium.net.fetch(url, { timeoutMs: 30000 });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const name = await addScript(response.text(), decodeURIComponent(url.split('/').pop() || '').replace(/\.(js|mjs|txt)$/i, ''));
            folium.ui.toast(`已导入音源脚本：${name}`, { type: 'success' });
        },
    });

    folium.registries.commands.register({
        id: 'lx-source-clear',
        label: { 'zh-CN': 'LX 音源：清除全部脚本', en: 'LX source: clear all scripts' },
        description: { 'zh-CN': '删除已导入的全部音源脚本。', en: 'Deletes every imported LX source script.' },
        run: async () => {
            await folium.storage.set(STORAGE_SCRIPTS, []);
            runtimes = [];
            cache.clear();
            folium.ui.toast('已清除全部音源脚本', { type: 'info' });
        },
    });

    folium.registries.commands.register({
        id: 'lx-source-status',
        label: { 'zh-CN': 'LX 音源：查看状态', en: 'LX source: status' },
        description: { 'zh-CN': '列出已加载脚本与其声明的音源。', en: 'Lists loaded scripts and the sources they declare.' },
        run: async () => {
            if (runtimes.length === 0) {
                folium.ui.toast('未加载任何音源脚本', { type: 'info' });
                return;
            }
            const summary = runtimes.map(({ name, runtime }) => {
                const sources = runtime.sources ? Object.keys(runtime.sources).join(', ') : '(未上报)';
                return `${name} → ${sources}`;
            }).join('\n');
            folium.log.info('LX source scripts', summary);
            folium.ui.toast(summary, { type: 'info', durationMs: 6000 });
        },
    });

    await loadScripts();

    return () => {
        disposed = true;
        inflight.clear();
        cache.clear();
        runtimes = [];
        disposers.forEach(dispose => { try { dispose(); } catch { /* already gone */ } });
    };
}
