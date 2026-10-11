// src/services/lxSource/kuwoMedia.ts
// 酷我歌词与封面——从 lx-music-desktop 的 musicSdk/kw 移植（lyric.js + pic.js +
// util.js 的 decodeLyric/lrcTools），去除 Node 专属依赖（zlib/crypto → Decompression-
// Stream/自研 md5 不需要——歌词只用到 inflate 与逐字时间轴清洗）。歌词源
// mlyric.kuwo.cn 返回 TP=content 包封 + deflate 的 LRC（可带逐字标记），封面源
// artistpicserver.kuwo.cn 返回纯文本 URL。请求统一走主进程代理（lx-kuwo-fetch）。

import type { ProviderLyricsResult } from '../../types/onlineMusic';
import { parseLyricsByFormat } from '../../utils/lyrics/parserCore';
import { isPureMusicLyricText } from '../../utils/lyrics/pureMusic';

/** 走主进程酷我代理拿原始字节。主进程返回 utf8 字符串会破坏二进制段，
 * 所以代理侧要保字节：这里约定 body 是 latin1 语义的字符串（每 char 一字节），
 * 主进程的 lx-kuwo-fetch 用 buffer.toString('latin1') 提供。 */
const fetchRaw = async (url: string): Promise<{ status: number; text: string }> => {
    const bridge = typeof window !== 'undefined' && (window as any).electron?.lxKuwoFetch;
    if (bridge) {
        const result = await bridge(url);
        if (!result?.ok) throw new Error(`kuwo proxy: ${result?.error ?? 'unknown'}`);
        return { status: result.status ?? 200, text: result.body ?? '' };
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const buffer = await response.arrayBuffer();
    // latin1 语义展开，保持与主进程代理相同的字节语义。
    const bytes = new Uint8Array(buffer);
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { status: response.status, text };
};

// ─── TP=content 包封解码 ─────────────────────────────────────────────────

const inflateToText = async (bytes: Uint8Array): Promise<string> => {
    // mlyric 返回 zlib 流（78 9c…）。DecompressionStream 'deflate' 处理 zlib 封装。
    for (const format of ['deflate', 'deflate-raw'] as const) {
        try {
            const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
            return await new Response(stream).text();
        } catch { /* try next framing */ }
    }
    throw new Error('kw lyric: inflate failed');
};

/**
 * lx util.js decodeLyric 的移植：TP=content 包封；lrcx（逐字）时正文再过一层
 * base64 + yeelion 异或。返回原始 LRC 文本（可能带 <start,dur> 逐字标记）。
 */
export const decodeKuwoLyric = async (rawText: string, isGetLyricx: boolean): Promise<string> => {
    if (rawText.slice(0, 10).toLowerCase() !== 'tp=content') return '';
    const bytes = new Uint8Array(rawText.length);
    for (let i = 0; i < rawText.length; i += 1) bytes[i] = rawText.charCodeAt(i) & 0xff;
    const headerEnd = rawText.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw new Error('kw lyric: bad envelope');
    const inflated = await inflateToText(bytes.subarray(headerEnd + 4));
    if (!isGetLyricx) return inflated;
    // lrcx：base64 + 'yeelion' 循环异或
    const binary = atob(inflated.trim());
    const key = 'yeelion';
    const out = new Uint8Array(binary.length);
    for (let i = 0, j = 0; i < binary.length; i += 1, j = (j + 1) % key.length) {
        out[i] = binary.charCodeAt(i) ^ key.charCodeAt(j);
    }
    return new TextDecoder().decode(out);
};

// ─── 逐字标记清洗（lx lrcTools.rxps.wordTimeAll 的等价物）────────────────

const WORD_TIME_ALL = /<(-?\d+),(-?\d+)(?:,-?\d+)?>/g;

/** lx lyric.js getLyric 的收尾：去掉逐字时间轴，只留行级 LRC。 */
const stripWordTimes = (lrc: string): string => lrc.replace(WORD_TIME_ALL, '');

const HAS_LINE_TIME = /\[\d{1,2}:.*\d{1,4}]/;

// ─── 对外接口 ────────────────────────────────────────────────────────────

/** 歌词。lrcx=1 拿逐字版，清洗成行级 LRC 后交给共享解析器；失败返回 null。 */
export const getKuwoLyrics = async (songmid: string): Promise<ProviderLyricsResult | null> => {
    const { status, text } = await fetchRaw(`http://mlyric.kuwo.cn/mobi.s?f=web&type=lyric&lrcx=1&rid=${songmid}&encode=utf8`);
    if (status !== 200) return null;
    const rawLrc = await decodeKuwoLyric(text, true);
    if (!rawLrc) return null;
    const mainText = stripWordTimes(rawLrc);
    if (!HAS_LINE_TIME.test(mainText)) return null;
    const lyrics = parseLyricsByFormat('lrc', mainText);
    return {
        lyrics: lyrics.lines.length ? lyrics : null,
        mainText,
        wordByWordText: null,
        translationText: null,
        romanizationText: null,
        isPureMusic: isPureMusicLyricText(mainText),
    };
};

/** 封面（500x500）。非 http 开头的响应按无封面处理。 */
export const getKuwoCoverUrl = async (songmid: string): Promise<string | null> => {
    const { text } = await fetchRaw(`http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${songmid}`);
    return /^http/.test(text.trim()) ? text.trim() : null;
};
