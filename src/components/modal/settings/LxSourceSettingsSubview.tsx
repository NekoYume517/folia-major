import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileUp, Loader2, Music, Trash2 } from 'lucide-react';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import { useLxSourceStore } from '../../../services/lxSource/lxSourceStore';
import { decodeLxScript } from '../../../services/lxSource/lxRuntime.mjs';

// src/components/modal/settings/LxSourceSettingsSubview.tsx
// 自用 fork：LX（洛雪）音源脚本配置页。导入 lx-music 音源脚本（.js 或 gz_ 文本）、
// 管理已导入列表，控制总开关 / 目标音质 / 替换策略。脚本运行时与换链逻辑在
// services/lxSource；这里只写 store，provider 层的订阅负责重载与重新广播。

type Props = {
    isDaylight: boolean;
    settingsCardClass: string;
};

const QUALITY_OPTIONS = ['128k', '320k', 'flac', 'flac24bit'] as const;

const LxSourceSettingsSubview: React.FC<Props> = ({ isDaylight, settingsCardClass }) => {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [importing, setImporting] = useState(false);
    const [importError, setImportError] = useState<string | null>(null);
    const {
        enabled, quality, mode, scripts, loadedSummaries,
        setEnabled, setQuality, setMode, addScript, removeScript,
    } = useLxSourceStore();

    const importFiles = async (files: FileList | null) => {
        if (!files || files.length === 0) return;
        setImporting(true);
        setImportError(null);
        for (const file of Array.from(files)) {
            try {
                const raw = await file.text();
                // 能解开 gz_ 就解开再存（省空间）；纯脚本原样存。
                const code = await decodeLxScript(raw);
                const name = /@name\s+(.+)/.exec(code.slice(0, 2000))?.[1]?.trim()
                    || file.name.replace(/\.(js|mjs|txt)$/i, '');
                addScript({ id: `lx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, name, code });
            } catch (error) {
                setImportError(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    const summaryFor = (id: string) => loadedSummaries.find(summary => summary.id === id);

    return (
        <div className="space-y-5">
            <SettingsAnchor anchorId="lxSourceEnable" label={t('options.lxSourceSettings')} className="space-y-4">
                <SettingsSectionHeading icon={Music} label={t('options.lxSourceSettings')} />
                <div className={settingsCardClass}>
                    <label className="flex items-center justify-between gap-4 py-1">
                        <span className="text-sm">
                            {t('options.lxSourceEnable')}
                            <span className="mt-0.5 block text-xs opacity-50">{t('options.lxSourceEnableDesc')}</span>
                        </span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={enabled}
                            onClick={() => setEnabled(!enabled)}
                            className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${enabled ? 'bg-emerald-500' : (isDaylight ? 'bg-black/15' : 'bg-white/20')}`}
                        >
                            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                        </button>
                    </label>
                </div>
            </SettingsAnchor>

            <SettingsAnchor anchorId="lxSourceScripts" label={t('options.lxSourceScripts')} className="space-y-4">
                <div className={settingsCardClass}>
                    <div className="flex items-center justify-between gap-3 py-1">
                        <span className="text-sm font-medium">{t('options.lxSourceScripts')}</span>
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={importing}
                            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40"
                            style={{ background: isDaylight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)' }}
                        >
                            {importing ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
                            {t('options.lxSourceImport')}
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".js,.mjs,.txt,application/javascript,text/plain"
                            multiple
                            className="hidden"
                            onChange={event => void importFiles(event.target.files)}
                        />
                    </div>
                    {importError && (
                        <p className="py-1 text-xs text-red-400">{importError}</p>
                    )}
                    {scripts.length === 0 ? (
                        <p className="py-1 text-xs opacity-50">{t('options.lxSourceScriptsEmpty')}</p>
                    ) : (
                        <ul className="space-y-1 py-1">
                            {scripts.map(script => {
                                const summary = summaryFor(script.id);
                                return (
                                    <li key={script.id} className="flex items-center justify-between gap-3 rounded-xl px-3 py-2" style={{ background: isDaylight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.05)' }}>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm">{script.name}</span>
                                            <span className="block truncate text-xs opacity-50">
                                                {summary && summary.sources.length > 0
                                                    ? t('options.lxSourceScriptSources', { sources: summary.sources.join(', ').toUpperCase() })
                                                    : t('options.lxSourceScriptPending')}
                                            </span>
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => removeScript(script.id)}
                                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-red-500/15"
                                            title={t('options.lxSourceRemove')}
                                            aria-label={t('options.lxSourceRemove')}
                                        >
                                            <Trash2 size={15} className="opacity-60" />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <p className="py-1 text-xs opacity-40">{t('options.lxSourceScriptsHint')}</p>
                </div>
            </SettingsAnchor>

            <SettingsAnchor anchorId="lxSourcePlayback" label={t('options.lxSourcePlayback')} className="space-y-4">
                <div className={settingsCardClass}>
                    <div className="py-1">
                        <span className="text-sm font-medium">{t('options.lxSourceQuality')}</span>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {QUALITY_OPTIONS.map(option => (
                                <button
                                    key={option}
                                    type="button"
                                    onClick={() => setQuality(option)}
                                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${quality === option
                                        ? 'bg-emerald-500 text-white'
                                        : (isDaylight ? 'bg-black/5 hover:bg-black/10' : 'bg-white/8 hover:bg-white/15')}`}
                                >
                                    {option}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="mt-3 py-1">
                        <span className="text-sm font-medium">{t('options.lxSourceMode')}</span>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {(['fallback', 'always'] as const).map(option => (
                                <button
                                    key={option}
                                    type="button"
                                    onClick={() => setMode(option)}
                                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${mode === option
                                        ? 'bg-emerald-500 text-white'
                                        : (isDaylight ? 'bg-black/5 hover:bg-black/10' : 'bg-white/8 hover:bg-white/15')}`}
                                >
                                    {t(`options.lxSourceMode_${option}`)}
                                </button>
                            ))}
                        </div>
                        <p className="mt-1.5 text-xs opacity-50">{t(`options.lxSourceMode_${mode}_Desc`)}</p>
                    </div>
                </div>
            </SettingsAnchor>
        </div>
    );
};

export default LxSourceSettingsSubview;
