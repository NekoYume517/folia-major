import type { OnlineMusicProvider, ProviderAudioSource, ProviderCapabilities, ProviderCollection, ProviderPage } from '../../types/onlineMusic';
import type { SongResult, UnifiedSong } from '../../types';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { announceOnlineMusicProviderChange } from '../onlineMusic/providerRegistry';
import {
    createLxRuntime,
    decodeLxScript,
    pickLxQuality,
    buildMusicInfo,
    PROVIDER_TO_LX_SOURCE,
    FOLIA_TO_LX_QUALITY,
} from './lxRuntime.mjs';
import { useLxSourceStore } from './lxSourceStore';
import {
    searchKuwoSongs,
    getKuwoPlaylists,
    getKuwoPlaylistSongs,
    getKuwoPlaylistTags,
    type KwSearchSong,
} from './kuwoCatalog';
import { getKuwoLyrics, getKuwoCoverUrl } from './kuwoMedia';

// src/services/lxSource/lxSourceProvider.ts
// 自用 fork 的内置 LX 音源 provider：搜索与歌单来自酷我的公开接口（kuwoCatalog.ts，
// 从 lx-music-desktop 的 musicSdk/kw 移植），播放直链由用户导入的洛雪音源脚本解析
// （酷我的 songmid 即 LX kw 源的 id，脚本按 {songmid} 取链）。
// 无账号；身份是 (online, 'lx', kw songmid)。换链侧（hostLxAudioSwap.ts）把
// netease/kugou/qq 的歌也映射到 wy/kg/tx 让脚本解析，覆盖「当前平台不是 LX」的场景。

export const LX_SOURCE_PROVIDER_ID = 'lx';

interface LoadedRuntime {
    id: string;
    name: string;
    runtime: ReturnType<typeof createLxRuntime>;
}

let runtimes: LoadedRuntime[] = [];
let loadGeneration = 0;

/** 与 store 里的脚本列表对齐：解开 gz_、沙箱执行、收集声明的音源。 */
export const reloadLxSourceRuntimes = async (): Promise<{ id: string; name: string; sources: string[] }[]> => {
    const generation = ++loadGeneration;
    const { scripts, setLoadedSummaries } = useLxSourceStore.getState();
    const loaded: LoadedRuntime[] = [];
    const summaries: { id: string; name: string; sources: string[] }[] = [];
    for (const script of scripts) {
        try {
            const code = await decodeLxScript(script.code);
            const runtime = createLxRuntime(code, {
                // 脚本请求走主进程代理（lx-music 桌面版同款设计：脚本请求在主进程，
                // 无 CORS；白名单与限制见 electron/main.cjs 的 lx-script-fetch）。
                netFetch: (url: string, options: import('./lxRuntime').LxNetFetchOptions) => {
                    const bridge = typeof window !== 'undefined' && (window as any).electron?.lxScriptFetch;
                    if (!bridge) {
                        // Node 探针 / 非 Electron 环境：直接 fetch。
                        return fetch(url, {
                            method: options.method,
                            headers: options.headers,
                            body: options.body,
                            signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
                        }).then(async (response) => ({
                            ok: response.ok,
                            status: response.status,
                            statusText: response.statusText,
                            headers: Object.fromEntries(response.headers.entries()),
                            // FoliumFetchResponse 契约：text()/json() 同步返回。
                            text: () => response.text(),
                        }));
                    }
                    return bridge(url, options).then((result: any) => {
                        if (!result?.ok) throw new Error(result?.error ?? 'script fetch failed');
                        return {
                            ok: (result.status ?? 200) >= 200 && (result.status ?? 200) < 300,
                            status: result.status ?? 200,
                            statusText: result.statusText ?? '',
                            headers: result.headers ?? {},
                            text: () => result.body ?? '',
                        };
                    });
                },
                log: {
                    info: (message: string, details?: unknown) => console.info(`[LxSource] ${message}`, details ?? ''),
                    warn: (message: string, details?: unknown) => console.warn(`[LxSource] ${message}`, details ?? ''),
                    error: (message: string, details?: unknown) => console.error(`[LxSource] ${message}`, details ?? ''),
                },
                scriptInfo: { name: script.name, version: '', description: '', homepage: '', rawScript: code },
            });
            loaded.push({ id: script.id, name: script.name, runtime });
        } catch (error) {
            console.error(`[LxSource] script "${script.name}" failed to load`, error);
        }
    }
    // 等所有脚本的 inited 事件（LX 脚本装载完会 send(inited, { sources })），最多 3 秒。
    await Promise.race([
        Promise.all(loaded.map(entry => entry.runtime.whenInited())),
        new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    for (const entry of loaded) {
        summaries.push({
            id: entry.id,
            name: entry.name,
            sources: entry.runtime.sources ? Object.keys(entry.runtime.sources) : [],
        });
    }
    if (generation === loadGeneration) {
        runtimes = loaded;
        setLoadedSummaries(summaries);
    }
    return summaries;
};

export const listLxSourceRuntimes = (): LoadedRuntime[] => runtimes;

const sourceIdOfSong = (song: SongResult): { lxSource: string; id: string } | null => {
    const ref = getPlaybackSourceRef(song);
    if (ref.kind !== 'online') return null;
    // LX 平台自己的歌就是酷我的歌：songmid 即 kw 源 id。
    const lxSource = ref.providerId === LX_SOURCE_PROVIDER_ID ? 'kw' : PROVIDER_TO_LX_SOURCE[ref.providerId as string];
    if (!lxSource) return null;
    return { lxSource, id: String(ref.mediaId) };
};

/** 依次问每个已装载脚本要直链；全部失败返回 null（调用方按无结果处理）。 */
const resolveThroughScripts = async (lxSource: string, id: string, qualityPreference: string): Promise<string | null> => {
    for (const { name, runtime } of runtimes) {
        try {
            const quality = pickLxQuality(runtime.sources, lxSource, qualityPreference);
            if (!quality) continue;
            const url = await runtime.resolveMusicUrl(lxSource, buildMusicInfo(lxSource, id), quality);
            if (url) return url;
        } catch (error) {
            console.warn(`[LxSource] "${name}" failed for ${lxSource}:${id}`, error);
        }
    }
    return null;
};

// 进程内直链缓存：LX 直链是短时效签名链接，10 分钟足够一次播放会话。
const URL_TTL_MS = 10 * 60 * 1000;
const urlCache = new Map<string, { url: string; expiresAt: number }>();
const inflight = new Map<string, Promise<string | null>>();

export const resolveLxSourceUrl = (lxSource: string, id: string): Promise<string | null> => {
    const key = `${lxSource}:${id}`;
    const cached = urlCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 5000) return Promise.resolve(cached.url);
    const running = inflight.get(key);
    if (running) return running;
    const qualityPreference = FOLIA_TO_LX_QUALITY[useLxSourceStore.getState().quality as string] ?? '320k';
    const attempt = resolveThroughScripts(lxSource, id, qualityPreference)
        .then((url) => {
            if (url) {
                if (urlCache.size > 200) urlCache.delete(urlCache.keys().next().value as string);
                urlCache.set(key, { url, expiresAt: Date.now() + URL_TTL_MS });
            }
            return url;
        })
        .finally(() => inflight.delete(key));
    inflight.set(key, attempt);
    return attempt;
};

export const clearLxSourceUrlCache = () => {
    urlCache.clear();
    inflight.clear();
};

// ─── 酷我歌曲 → UnifiedSong 归一化 ─────────────────────────────────────

// 封面按 songmid 缓存（酷我封面接口按歌曲 id 返回稳定 URL）。搜索页渲染时
// 同步拿不到封面，先返回 undefined，由后台补齐后写回缓存——下一次渲染
// （或 getSongDetail）就能读到。失败按 null 记住，避免反复打接口。
const coverCache = new Map<string, string | null>();

const coverOf = (songmid: string): string | undefined => {
    const cached = coverCache.get(songmid);
    if (cached) return cached;
    void getKuwoCoverUrl(songmid)
        .then(url => {
            coverCache.set(songmid, url);
            if (url) announceOnlineMusicProviderChange();
        })
        .catch(() => coverCache.set(songmid, null));
    return undefined;
};

const toUnifiedSong = (song: KwSearchSong): UnifiedSong => ({
    id: song.songmid,
    name: song.name,
    artists: song.singer.split('、').filter(Boolean).map((name, index) => ({ id: `${song.songmid}#ar${index}`, name })),
    album: { id: song.albumId || `${song.songmid}#al`, name: song.albumName, ...(coverOf(song.songmid) ? { coverUrl: coverOf(song.songmid) } : {}) },
    durationMs: song.interval * 1000,
    sourceRef: { kind: 'online', providerId: LX_SOURCE_PROVIDER_ID, mediaId: song.songmid },
});

const toProviderPage = (songs: KwSearchSong[], total: number, offset: number, limit: number): ProviderPage<UnifiedSong> => ({
    items: songs.map(toUnifiedSong),
    total,
    hasMore: offset + songs.length < total,
    nextOffset: offset + songs.length,
});

const capabilities: ProviderCapabilities = {
    search: true,
    playback: true,
    lyrics: true,
    wordByWordLyrics: false,
    auth: false,
    userLibrary: false,
    playlists: true,
    albums: false,
    artists: false,
    recommendations: true,
    mutations: false,
};

/**
 * 内置 LX 音源 provider：酷我目录（搜索/歌单）+ LX 脚本直链。歌单详情的
 * trackCount/封面来自 pl.svc 的 info 段；分页用 pl.svc 的 total。
 */
export const lxSourceProvider: OnlineMusicProvider = {
    id: LX_SOURCE_PROVIDER_ID,
    displayName: 'LX 音源',
    shortName: 'LX',
    capabilities,
    getAvailability: () => ({
        configured: useLxSourceStore.getState().enabled && runtimes.length > 0,
        ...(useLxSourceStore.getState().enabled && runtimes.length > 0
            ? {}
            : { reason: 'not-configured' as const }),
    }),
    normalizeSong: (raw) => raw as UnifiedSong,
    songMetadata: {
        getSongMetadata: song => createProviderSongMetadata(song),
    },
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return { items: [], hasMore: false, nextOffset: offset };
            const page = Math.floor(offset / Math.max(limit, 1)) + 1;
            const { songs, total } = await searchKuwoSongs(query, page, limit);
            return toProviderPage(songs, total, offset, limit);
        },
    },
    catalog: {
        async getPlaylistTracks(id, limit, offset) {
            const page = Math.floor(offset / 1000) + 1;
            const { songs, total } = await getKuwoPlaylistSongs(String(id), page);
            const paged = songs.slice(offset % 1000, (offset % 1000) + limit);
            return toProviderPage(paged, total, offset, limit);
        },
        async getPlaylistDetail(id) {
            const { info } = await getKuwoPlaylistSongs(String(id), 1);
            if (!info) return null;
            const collection: ProviderCollection = {
                providerId: LX_SOURCE_PROVIDER_ID,
                id: String(id),
                name: info.name,
                type: 'playlist',
                coverUrl: info.img ?? undefined,
                description: info.desc || undefined,
                trackCount: info.total,
                publisher: info.author || undefined,
                playCount: Number(info.playCount) || undefined,
            };
            return collection;
        },
    },
    recommendations: {
        async getRecommendedCollections(limit) {
            const { playlists } = await getKuwoPlaylists('hot', null, 1);
            return playlists.slice(0, limit).map(playlist => ({
                providerId: LX_SOURCE_PROVIDER_ID,
                id: playlist.id,
                name: playlist.name,
                type: 'playlist',
                coverUrl: playlist.img ?? undefined,
                description: playlist.desc || undefined,
                trackCount: playlist.total,
                publisher: playlist.author || undefined,
                playCount: Number(playlist.playCount) || undefined,
            }));
        },
    },
    playback: {
        // 歌单行点进来时 omni 会先问 getSongDetail；酷我的元数据以搜索行为准，
        // 这里只补封面（songDetail 的调用方需要 coverUrl 时用它兜底）。
        async getSongDetail(id) {
            const coverUrl = await getKuwoCoverUrl(String(id)).catch(() => null);
            if (!coverUrl) return null;
            return {
                id: String(id),
                name: '',
                artists: [],
                album: { id: `${id}#al`, name: '', coverUrl },
                durationMs: 0,
                sourceRef: { kind: 'online', providerId: LX_SOURCE_PROVIDER_ID, mediaId: String(id) },
            };
        },
        async getAudioSource(song: SongResult): Promise<ProviderAudioSource | null> {
            const mapped = sourceIdOfSong(song);
            if (!mapped) return null;
            const url = await resolveLxSourceUrl(mapped.lxSource, mapped.id);
            if (!url) return null;
            return {
                url,
                fetchedAt: Date.now(),
                quality: useLxSourceStore.getState().quality === 'flac' ? 'lossless'
                    : useLxSourceStore.getState().quality === 'flac24bit' ? 'hires'
                        : useLxSourceStore.getState().quality === '128k' ? 'standard' : 'high',
            };
        },
    },
    lyrics: {
        async getLyrics(song) {
            return await getKuwoLyrics(String(song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : song.id))
                .catch(() => null) ?? {
                lyrics: null,
                mainText: null,
                isPureMusic: false,
            };
        },
    },
};
