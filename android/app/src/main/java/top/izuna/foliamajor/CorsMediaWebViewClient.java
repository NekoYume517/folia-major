package top.izuna.foliamajor;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

// 自用 fork：媒体与接口的 CORS 代理。
//
// 桌面版靠 Electron 的 webRequest.onHeadersReceived 给酷狗/QQ/波点的音频与封面响应
// 注入 Access-Control-Allow-Origin（electron/main.cjs）。WebView 没有这层，而 Folia
// 的播放器对 <audio> 用了 crossOrigin="anonymous"（为了 Web Audio 可视化取数），
// 响应缺 CORS 头时 Chromium 会直接拒绝加载——这正是 Android 上「还是有跨域限制」的根因。
//
// 这里在 shouldInterceptRequest 上做同样的事：命中白名单的请求由原生发起（不受 CORS
// 约束），再把响应连同 ACAO 头交回 WebView，因此 <audio crossOrigin> 与 canvas/WebGL
// 取色都能通过。范围请求（Range）原样转发，音频拖动进度才能工作。
public class CorsMediaWebViewClient extends BridgeWebViewClient {

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    // 只代理媒体/封面/歌词这类资源，页面自身（asset 与本地服务器）不经过这里。
    private static final String[] ALLOWED_HOST_SUFFIXES = {
        // 酷狗（Folia 内置 provider 的音频与封面）
        "kugou.com",
        // 波点的 Kuwo 域名：音频、封面、接口
        "kuwo.cn",
        "kwcdn.kuwo.cn",
        "bd-api.kuwo.cn",
        "bodian-oia.kuwo.cn",
        // QQ 音乐的封面
        "y.gtimg.cn",
        "qq.com",
        // LX 音源：酷我目录/歌词/封面接口（与 lxSource 的域名白名单一致）
        "search.kuwo.cn",
        "wapi.kuwo.cn",
        "nplserver.kuwo.cn",
        "mobileinterfaces.kuwo.cn",
        "qukudata.kuwo.cn",
        "mlyric.kuwo.cn",
        "artistpicserver.kuwo.cn",
        // LX 音源脚本可能把直链放在这些常见 CDN 上
        "music.126.net",
        "sns-video-hw.xhscdn.com",
        "panspace.kuwo.cn",
    };

    private final Bridge bridge;

    public CorsMediaWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri == null || !shouldProxy(uri, request)) {
            return super.shouldInterceptRequest(view, request);
        }
        try {
            return proxyRequest(request);
        } catch (IOException error) {
            // 代理失败就让 WebView 按原样去取（至少能拿到错误页，不吞掉请求）。
            return super.shouldInterceptRequest(view, request);
        }
    }

    private boolean shouldProxy(Uri uri, WebResourceRequest request) {
        String scheme = uri.getScheme();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
        String host = uri.getHost();
        if (host == null) return false;
        if (host.equals("localhost") || host.equals("127.0.0.1")) return false;
        for (String suffix : ALLOWED_HOST_SUFFIXES) {
            if (host.equals(suffix) || host.endsWith("." + suffix)) return true;
        }
        return false;
    }

    /** 原生取一次，回填 CORS 头；Range / Content-Range 原样传递。 */
    private WebResourceResponse proxyRequest(WebResourceRequest request) throws IOException {
        URL url = new URL(request.getUrl().toString());
        String method = request.getMethod() == null ? "GET" : request.getMethod();
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(true);
        // 原请求头透传（Range、Referer、User-Agent 等）。
        for (Map.Entry<String, String> header : request.getRequestHeaders().entrySet()) {
            String name = header.getKey();
            if (name == null) continue;
            // Host / Connection 之类由底层管理，转发会出问题。
            if (name.equalsIgnoreCase("host") || name.equalsIgnoreCase("connection")
                || name.equalsIgnoreCase("content-length")) continue;
            connection.setRequestProperty(name, header.getValue());
        }
        // 透传原请求头（Range、Referer、User-Agent 等）。注意不主动加 Origin：
        // 这些是媒体/封面资源，服务端不需要它；带上反而可能触发按 Origin 的差异分支
        // （例如波点接口在带 Origin 且 GET 有 body 时返回 500）。

        int status = connection.getResponseCode();
        String reason = connection.getResponseMessage() == null ? "" : connection.getResponseMessage();
        Map<String, String> headers = new HashMap<>();
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            String name = entry.getKey();
            if (name == null || entry.getValue() == null || entry.getValue().isEmpty()) continue;
            // 重写 CORS 相关头：ACAO 用 *，并允许 Range 与自定义请求头。
            if (name.equalsIgnoreCase("Access-Control-Allow-Origin")
                || name.equalsIgnoreCase("Access-Control-Allow-Headers")
                || name.equalsIgnoreCase("Access-Control-Allow-Methods")
                || name.equalsIgnoreCase("Access-Control-Expose-Headers")) continue;
            headers.put(name, joinValues(entry.getValue()));
        }
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Allow-Headers", "*");
        headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
        headers.put("Access-Control-Expose-Headers", "*");

        String contentType = connection.getContentType();
        String mime = "application/octet-stream";
        String encoding = null;
        if (contentType != null && !contentType.isEmpty()) {
            String[] parts = contentType.split(";");
            mime = parts[0].trim();
            for (int i = 1; i < parts.length; i++) {
                String part = parts[i].trim();
                if (part.toLowerCase().startsWith("charset=")) encoding = part.substring(8).trim();
            }
        }

        InputStream body = (status >= 200 && status < 300) || status == 206
            ? connection.getInputStream()
            : connection.getErrorStream();
        // 状态码 + 文案：WebResourceResponse 的 reasonPhrase 在 API 21+ 可用。
        WebResourceResponse response = new WebResourceResponse(mime, encoding, status, reason, headers, body);
        return response;
    }

    private static String joinValues(List<String> values) {
        if (values.size() == 1) return values.get(0);
        List<String> copy = new ArrayList<>(values);
        StringBuilder joined = new StringBuilder();
        for (int i = 0; i < copy.size(); i++) {
            if (i > 0) joined.append(", ");
            joined.append(copy.get(i));
        }
        return joined.toString();
    }
}
