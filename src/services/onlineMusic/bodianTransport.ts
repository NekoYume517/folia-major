import { OnlineProviderError } from '../../types/onlineMusic';
import type { BodianOperation, BodianParams, BodianResult } from 'bodian-music-api';

// src/services/onlineMusic/bodianTransport.ts

export type { BodianOperation, BodianParams } from 'bodian-music-api';
export type BodianBridgeResult = BodianResult;

/**
 * Android 壳的波点桥（原生 HTTP + Node shim，见 bodianAndroidBridge.ts）。
 *
 * 为什么不挂在 window.electron 上：那个对象是桌面版的完整桥，Folia 的代码会用它
 * 调用 onWindowFullscreenChanged 等一堆 API；Android 上只塞一个 bodianRequest
 * 进去会让那些调用变成 undefined is not a function，整页崩掉。所以这里用一个
 * 独立命名空间，只在 window.electron.bodianRequest 不存在时启用。
 */
const ANDROID_BRIDGE_KEY = '__FOLIA_BODIAN_BRIDGE__';

type BodianRequestFn = (operation: BodianOperation, params?: BodianParams) => Promise<BodianBridgeResult>;

const androidBridge = (): BodianRequestFn | null => {
    if (typeof window === 'undefined') return null;
    const bridge = (window as unknown as Record<string, unknown>)[ANDROID_BRIDGE_KEY];
    return typeof bridge === 'function' ? (bridge as BodianRequestFn) : null;
};

/** 桌面版走主进程桥；Android 壳走同协议的渲染端实现；网页版两者都没有。 */
const resolveBodianRequest = (): BodianRequestFn | null => {
    if (typeof window === 'undefined') return null;
    const desktop = window.electron?.bodianRequest;
    if (typeof desktop === 'function') return desktop.bind(window.electron);
    return androidBridge();
};

export const getBodianTransportAvailability = () => (
    resolveBodianRequest() !== null
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const
);

export async function requestBodian<T = unknown>(operation: BodianOperation, params: BodianParams = {}): Promise<T> {
    const request = resolveBodianRequest();
    if (!request) {
        throw new OnlineProviderError('unavailable', 'Bodian requires the desktop app or the Android shell', 'bodian');
    }
    let result: BodianBridgeResult;
    // Omni consumers request 150/1000-row batches; Bodian serves at most 100 and returns its own cursor.
    const boundedParams = Number.isSafeInteger(params.limit) && Number(params.limit) > 100
        ? { ...params, limit: 100 } : params;
    try { result = await request(operation, boundedParams); }
    catch { throw new OnlineProviderError('network', 'Bodian request failed', 'bodian'); }
    if (!result.ok) throw new OnlineProviderError(result.error.code, result.error.message, 'bodian');
    return result.data as T;
}
