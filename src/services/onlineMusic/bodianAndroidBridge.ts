// src/services/onlineMusic/bodianAndroidBridge.ts
// 波点在 Android 上的落地：给渲染端注入一个 `window.electron.bodianRequest` 替身。
//
// 为什么这样做：桌面版的波点链路（bodianProvider → bodianTransport →
// window.electron.bodianRequest → 主进程 bodianApiBridge → bodian-music-api）
// 里，只有最后一段依赖 Node 主进程。渲染端只认一个函数：`window.electron.bodianRequest`。
// Android 壳没有主进程，但我们也不需要 Node——`bodian-music-api` 只用三样 Node 能力
// （node:https 发请求、node:crypto 的 md5 签名、node:zlib 的 gunzip），而这三样都能用
// 原生桥 + Web 平台能力顶上（见 bodianNodeShim.ts / bodianNodeModules.ts）。
//
// 于是这里把「包 + shim + 会话存储」装成一个小型桥对象挂在 window.electron 上，
// 桌面版的其他部分（provider 能力、目录、歌词解析、UI）一行都不用改。

import type { BodianBridgeResult, BodianOperation, BodianParams } from './bodianTransport';

const BODIAN_DEVICE_ID_KEY = 'folia_bodian_device_id';
const BODIAN_SESSION_KEY = 'folia_bodian_session';
/** 独立命名空间：不与桌面版的 window.electron 混用（见 bodianTransport 的说明）。 */
const ANDROID_BRIDGE_KEY = '__FOLIA_BODIAN_BRIDGE__';

interface BodianApiInstance {
    request(operation: string, params?: Record<string, unknown>): Promise<BodianBridgeResult>;
}

let apiPromise: Promise<BodianApiInstance | null> | null = null;

const readOrCreateDeviceId = (): string => {
    const saved = window.localStorage.getItem(BODIAN_DEVICE_ID_KEY);
    if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    window.localStorage.setItem(BODIAN_DEVICE_ID_KEY, id);
    return id;
};

/** 会话存储：形状对齐 bodian 的 sessions 接口，落 WebView 的 localStorage。
 * 桌面用系统加密（safeStorage）持久化；这里没有系统加密，等价于桌面在
 * safeStorage 不可用时的降级——凭据只留在本机应用沙箱内。 */
const createPersistentSessions = () => {
    let value: unknown = null;
    let revision = 0;
    try {
        const saved = window.localStorage.getItem(BODIAN_SESSION_KEY);
        if (saved) value = JSON.parse(saved);
    } catch {
        value = null;
    }
    return {
        get revision() { return revision; },
        get() { return value; },
        set(session: unknown) {
            value = session;
            revision += 1;
            try { window.localStorage.setItem(BODIAN_SESSION_KEY, JSON.stringify(session)); } catch { /* quota */ }
        },
        clear() {
            value = null;
            revision += 1;
            window.localStorage.removeItem(BODIAN_SESSION_KEY);
        },
    };
};

const loadApi = async (): Promise<BodianApiInstance | null> => {
    apiPromise ??= (async () => {
        try {
            // 动态 import：包与 shim 都不进首屏关键路径（波点用到时才解析）。
            // node:https / node:crypto / node:zlib 由 vite alias 指向 bodianNodeModules.ts。
            const [module, shim] = await Promise.all([
                import('bodian-music-api'),
                import('./bodianNodeShim'),
            ]);
            const createBodianApi = (module as unknown as {
                createBodianApi: (options: {
                    deviceId: string;
                    sessions: unknown;
                    requestFactory: unknown;
                    now?: () => number;
                }) => BodianApiInstance;
            }).createBodianApi;
            // 包的内部代码用全局 Buffer 拼响应字节（Buffer.concat / toString('utf8')），
            // WebView 没有，装一个最小替身（必须在首次请求前完成）。
            shim.installMiniBuffer();
            return createBodianApi({
                deviceId: readOrCreateDeviceId(),
                sessions: createPersistentSessions(),
                requestFactory: shim.createNativeHttpsRequest(),
                now: () => Date.now(),
            });
        } catch (error) {
            console.error('[Bodian/Android] bridge init failed', error);
            return null;
        }
    })();
    return apiPromise;
};

/** 原生桥存在时（Android 壳）挂上独立命名空间的 bodianRequest；桌面版不覆盖。 */
export const installBodianAndroidBridge = async (): Promise<void> => {
    if (typeof window === 'undefined') return;
    const shim = await import('./bodianNodeShim');
    if (!shim.isNativeBodianHttpAvailable()) return;
    // 桌面版（真 Electron 桥）里什么都不做，交回主进程实现。
    if (typeof window.electron?.bodianRequest === 'function') return;

    const api = await loadApi();
    if (!api) return;

    // 注意：不写 window.electron —— 那个对象在 Android 上不存在，而 Folia 的代码会
    // 把它当完整桌面桥用（onWindowFullscreenChanged 等）。只挂独立命名空间，
    // bodianTransport 会优先用桌面桥、否则回落到这里。
    (window as unknown as Record<string, unknown>)[ANDROID_BRIDGE_KEY] = async (
        operation: BodianOperation,
        params: BodianParams = {},
    ): Promise<BodianBridgeResult> => {
        try {
            return await api.request(operation, params as Record<string, unknown>);
        } catch (error) {
            return {
                ok: false,
                error: { code: 'invalid-response', message: String((error as Error)?.message ?? error) },
            } satisfies BodianBridgeResult;
        }
    };
};
