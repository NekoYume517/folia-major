import type { SongResult } from '../../types';
import type { ProviderAudioSource } from '../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { useLxSourceStore } from './lxSourceStore';
import { resolveLxSourceUrl } from './lxSourceProvider';
import { PROVIDER_TO_LX_SOURCE } from './lxRuntime.mjs';

// src/services/lxSource/hostLxAudioSwap.ts
// Omni 换链侧：omni.getAudioSource 解析出内置 provider 的直链后，按替换策略决定
// 是否改用 LX 音源的直链。`fallback`（默认）只在内置 provider 给不出 URL 时问 LX；
// `always` 无条件优先 LX（LX 也失败时保留原直链）。
//
// hook 是被 await 的（hostExtensionHooks.applyOmniAudioHook），但上层播放链路对
// 冷启动很慢的音源 API 没有额外耐心 —— 这里限时 20 秒，超时就放弃这次换链
// （注意：超时后不抛错，播放仍按原直链走；但若原本就没有原直链，调用方会按
// 「取链失败」提示重试，而不是误报成歌曲下架）。
// 平时命中的是 10 分钟直链缓存，几乎零开销。20 秒是给冷启动的音源站留的余量：
// onrender 这类免费实例首次请求要 5~30 秒，6 秒（早期取值）在移网下几乎必然超时。

const SWAP_TIMEOUT_MS = 20000;

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

export const swapAudioWithLxSource = async (
    song: SongResult,
    source: ProviderAudioSource | null,
): Promise<ProviderAudioSource | null> => {
    const { enabled, mode } = useLxSourceStore.getState();
    if (!enabled) return source;
    if (mode !== 'always' && source?.url) return source;

    const ref = getPlaybackSourceRef(song);
    if (ref.kind !== 'online') return source;
    const lxSource = PROVIDER_TO_LX_SOURCE[ref.providerId as string];
    if (!lxSource) return source;

    const url = await withTimeout(resolveLxSourceUrl(lxSource, String(ref.mediaId)), SWAP_TIMEOUT_MS);
    if (!url) return source;
    return {
        quality: source?.quality ?? 'high',
        ...(source?.replayGain ? { replayGain: source.replayGain } : {}),
        url,
        fetchedAt: Date.now(),
    };
};
