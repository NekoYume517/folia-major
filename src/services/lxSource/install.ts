import {
    registerOnlineMusicProvider,
    subscribeOnlineMusicProviderRegistry,
    announceOnlineMusicProviderChange,
} from '../onlineMusic/providerRegistry';
import { installBaseAudioHook } from '../hostExtensionHooks';
import { lxSourceProvider, reloadLxSourceRuntimes } from './lxSourceProvider';
import { useLxSourceStore } from './lxSourceStore';
import { swapAudioWithLxSource } from './hostLxAudioSwap';

// src/services/lxSource/install.ts
// 自用 fork 的 LX 音源装配：注册内置 provider、装底层换链 hook，脚本列表变化时
// 重载运行时并重新广播 availability（平台徽章随之点亮/熄灭）。

let installed = false;
let lastScriptsKey = '';

const syncRuntimes = async () => {
    const { scripts } = useLxSourceStore.getState();
    const key = scripts.map(script => script.id).join(',');
    if (key === lastScriptsKey) return;
    lastScriptsKey = key;
    await reloadLxSourceRuntimes();
    // 装载完成（或全失败）后 availability 才会变，广播一次让 UI 重读摘要。
    announceOnlineMusicProviderChange();
};

export const installLxSource = () => {
    if (installed) return;
    installed = true;

    registerOnlineMusicProvider(lxSourceProvider);
    installBaseAudioHook(swapAudioWithLxSource);

    void syncRuntimes();
    useLxSourceStore.subscribe(() => void syncRuntimes());
    // 初次装载是异步的；registry 在 register 时广播的那次还读不到结果。
    subscribeOnlineMusicProviderRegistry(() => void syncRuntimes());
};
