// src/services/lxSource/kuwoCatalog.ts
// 酷我音乐的搜索与歌单只读客户端——从 lx-music-desktop 的 musicSdk/kw 移植
// （musicSearch.js + songList.js + util.js 的纯 HTTP 部分），去掉 Vue/store/Node
// 依赖，接口与返回结构保持原样。给内置 LX 音源 provider 当搜索/歌单后端：
// 酷我没有加密、不用登录，搜索与歌单都是公开接口；播放直链仍由用户导入的
// LX 音源脚本解析（songmid/FileHash 即 LX 的 kw 源 id）。

const decodeName = (str?: string | null): string => {
    if (!str) return '';
    // DOMParser 在渲染进程可用；Node 测试环境退回实体反转义。
    if (typeof DOMParser === 'undefined') {
        return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    return new DOMParser().parseFromString(str, 'text/html').body.textContent ?? '';
};

const numFix = (num: number, len = 2): string => num.toString().padStart(len, '0');

const formatPlayTime = (time: number): string => {
    const m = Math.trunc(time / 60);
    const s = Math.trunc(time % 60);
    return m === 0 && s === 0 ? '--/--' : `${numFix(m)}:${numFix(s)}`;
};

const formatSinger = (rawData: string): string => rawData.replace(/&/g, '、');

const formatPlayCount = (num: number): string => {
    if (num > 100000000) return `${parseInt(String(num / 10000000), 10) / 10}亿`;
    if (num > 10000) return `${parseInt(String(num / 1000), 10) / 10}万`;
    return String(num);
};

/** 主进程代理按 latin1 语义返回字节（每 char 一字节，保二进制安全）；
 * JSON 端点把它们还原成 UTF-8 文本。 */
const latin1ToUtf8 = (text: string): string => {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
    return new TextDecoder('utf-8').decode(bytes);
};

/** lx httpFetch 的最小复刻：JSON 优先。渲染进程没有跨域豁免，走主进程代理
 * （electron/preload.cjs 的 lxKuwoFetch，main.cjs 里窄域名白名单）；Node/纯 Web
 * 环境退回直接 fetch（Node 无 CORS，Web 环境该 provider 本就不可用）。 */
const httpFetchJson = async (url: string, timeoutMs = 15000): Promise<{ statusCode: number; body: any }> => {
    const viaBridge = typeof window !== 'undefined' && (window as any).electron?.lxKuwoFetch;
    if (viaBridge) {
        const result = await viaBridge(url);
        if (!result?.ok) throw new Error(`kuwo proxy: ${result?.error ?? 'unknown'}`);
        const text = latin1ToUtf8(String(result.body ?? ''));
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* keep text */ }
        return { statusCode: result.status ?? 200, body };
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { statusCode: response.status, body };
};

// ─── 搜索 ────────────────────────────────────────────────────────────────

const M_INFO_REGEXP = /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/;

interface KwQuality { type: string; size?: string }

const qualityTypesOf = (mInfo: string): KwQuality[] => {
    const types: KwQuality[] = [];
    for (const segment of mInfo.split(';')) {
        const matched = segment.match(M_INFO_REGEXP);
        if (!matched) continue;
        switch (matched[2]) {
            case '4000': types.push({ type: 'flac24bit', size: matched[4] }); break;
            case '2000': types.push({ type: 'flac', size: matched[4] }); break;
            case '320': types.push({ type: '320k', size: matched[4] }); break;
            case '128': types.push({ type: '128k', size: matched[4] }); break;
        }
    }
    return types.reverse();
};

export interface KwSearchSong {
    songmid: string;
    name: string;
    singer: string;
    albumName: string;
    albumId: string;
    interval: number;
    img: string | null;
    qualitys: KwQuality[];
}

export const searchKuwoSongs = async (query: string, page = 1, limit = 30, retry = 0): Promise<{ songs: KwSearchSong[]; total: number }> => {
    if (retry > 2) throw new Error('kuwo search: try max num');
    const url = `http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(query)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`;
    const { body } = await httpFetchJson(url);
    if (!body || (body.TOTAL !== '0' && body.SHOW === '0')) return searchKuwoSongs(query, page, limit, retry + 1);
    const rawList: any[] = Array.isArray(body.abslist) ? body.abslist : [];
    const songs = rawList.map((info): KwSearchSong => {
        const duration = parseInt(info.DURATION, 10);
        return {
            songmid: String(info.MUSICRID ?? '').replace('MUSIC_', ''),
            name: decodeName(info.SONGNAME),
            singer: formatSinger(decodeName(info.ARTIST)),
            albumName: info.ALBUM ? decodeName(info.ALBUM) : '',
            albumId: decodeName(info.ALBUMID || ''),
            interval: Number.isNaN(duration) ? 0 : duration,
            img: null,
            qualitys: qualityTypesOf(String(info.N_MINFO ?? '')),
        };
    }).filter(song => song.songmid);
    return { songs, total: parseInt(body.TOTAL, 10) || songs.length };
};

// ─── 歌单 ────────────────────────────────────────────────────────────────

export interface KwPlaylistSummary {
    id: string;
    name: string;
    author: string;
    desc: string;
    img: string | null;
    total: number;
    playCount: string;
}

export interface KwTag {
    id: string;
    name: string;
}

const PLAYLIST_LIST_LIMIT = 36;

export const getKuwoPlaylistTags = async (): Promise<{ hot: KwTag[]; tags: { name: string; list: KwTag[] }[] }> => {
    const [hotRes, tagRes] = await Promise.all([
        httpFetchJson('http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmTagList?loginUid=0&loginSid=0&appUid=76039576'),
        httpFetchJson('http://wapi.kuwo.cn/api/pc/classify/playlist/getTagList?cmd=rcm_keyword_playlist&user=0&prod=kwplayer_pc_9.0.5.0&vipver=9.0.5.0&source=kwplayer_pc_9.0.5.0&loginUid=0&loginSid=0&appUid=76039576'),
    ]);
    const hot: KwTag[] = (hotRes.body?.data?.[0]?.data ?? []).map((item: any) => ({ id: `${item.id}-${item.digest}`, name: item.name }));
    const tags = (tagRes.body?.data ?? []).map((type: any) => ({
        name: type.name,
        list: (type.data ?? []).map((item: any) => ({ id: `${item.id}-${item.digest}`, name: item.name })),
    }));
    return { hot, tags };
};

/** 推荐歌单 / 标签歌单。tagId 形如 `{id}-{digest}`（与 lx 一致）。 */
export const getKuwoPlaylists = async (sortId: 'new' | 'hot', tagId: string | null, page = 1): Promise<{ playlists: KwPlaylistSummary[]; total: number }> => {
    let id: string | null = null;
    let type: string | null = null;
    if (tagId) {
        const [tagIdPart, tagType] = tagId.split('-');
        id = tagIdPart;
        type = tagType;
    }
    const url = !id
        ? `http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0&appUid=76039576&&pn=${page}&rn=${PLAYLIST_LIST_LIMIT}&order=${sortId}`
        : type === '10000'
            ? `http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=${page}&id=${id}&rn=${PLAYLIST_LIST_LIMIT}`
            : null;
    if (!url) return { playlists: [], total: 0 };
    const { body } = await httpFetchJson(url);
    if (body?.code !== 200) return { playlists: [], total: 0 };
    const rawList: any[] = body.data?.data ?? [];
    const playlists = rawList.map((item): KwPlaylistSummary => ({
        id: `digest-${item.digest}__${item.id}`,
        name: item.name,
        author: item.uname,
        desc: item.desc,
        img: item.img ?? null,
        total: item.total,
        playCount: formatPlayCount(item.listencnt),
    }));
    return { playlists, total: body.data?.total ?? playlists.length };
};

/** 歌单详情（digest-8 / digest-5 两种 id 形态都归到 pl.svc 的数字 id）。 */
export const getKuwoPlaylistSongs = async (rawId: string, page = 1, retry = 0): Promise<{ songs: KwSearchSong[]; info: KwPlaylistSummary | null; total: number }> => {
    if (retry > 2) throw new Error('kuwo playlist: try max num');
    let id = rawId;
    if (/^digest-/.test(id)) id = id.split('__')[1] ?? id;
    const url = `http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${id}&pn=${page - 1}&rn=1000&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`;
    const { body } = await httpFetchJson(url);
    if (body?.result !== 'ok') return getKuwoPlaylistSongs(rawId, page, retry + 1);
    const rawList: any[] = Array.isArray(body.musiclist) ? body.musiclist : [];
    const songs = rawList.map((item): KwSearchSong => ({
        songmid: String(item.id),
        name: decodeName(item.name),
        singer: formatSinger(decodeName(item.artist)),
        albumName: decodeName(item.album),
        albumId: String(item.albumid ?? ''),
        interval: parseInt(item.duration, 10) || 0,
        img: null,
        qualitys: qualityTypesOf(String(item.N_MINFO ?? '')),
    })).filter(song => song.songmid);
    return {
        songs,
        total: body.total ?? songs.length,
        info: {
            id,
            name: body.title ?? '',
            author: body.uname ?? '',
            desc: body.info ?? '',
            img: body.pic ?? null,
            total: body.total ?? songs.length,
            playCount: formatPlayCount(body.playnum),
        },
    };
};
