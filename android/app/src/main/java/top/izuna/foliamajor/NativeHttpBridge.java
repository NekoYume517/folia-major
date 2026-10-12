package top.izuna.foliamajor;

import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.GZIPInputStream;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

// 自用 fork：桌面版「主进程 HTTP」在 Android 上的对应物。
//
// 为什么手写 HTTP 而不是用现成的客户端：
// 波点的协议必须发 **GET + JSON body**，三条常规路都不行——
// - CapacitorHttp：只给 POST/PUT/PATCH/DELETE 设请求体，GET 的 body 被丢弃；
// - OkHttp：直接抛 "method GET must not have a request body"；
// - HttpURLConnection：允许发，但会隐式改写请求头（Connection/Transfer-Encoding 等），
//   服务端对这种 GET+body 的组合返回 500（Service error），而桌面版 Node 的
//   http.request 发同样内容得到正常响应。
// 所以这里用原始 Socket 自己拼请求报文，完全对齐 Node 的报文形状：
//   GET <path> HTTP/1.1 / Host / 应用头 / Content-Length / Connection: keep-alive / 空行 / body
// TLS 由 SSLSocketFactory 承担（与 https:// 等价）。
//
// 返回 base64 的响应体（gzip 在这里就地解开，避免 JS 侧再处理二进制）。
public class NativeHttpBridge {

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;

    @JavascriptInterface
    public String send(String url, String method, String headersJson, String payloadBase64) {
        JSONObject result = new JSONObject();
        try {
            URI uri = new URI(url);
            boolean secure = "https".equalsIgnoreCase(uri.getScheme());
            String host = uri.getHost();
            int port = uri.getPort() != -1 ? uri.getPort() : (secure ? 443 : 80);
            String path = uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
            if (uri.getRawQuery() != null) path += "?" + uri.getRawQuery();

            byte[] payload = (payloadBase64 == null || payloadBase64.isEmpty())
                ? new byte[0]
                : Base64.decode(payloadBase64, Base64.DEFAULT);

            JSONObject headers = (headersJson == null || headersJson.isEmpty())
                ? new JSONObject() : new JSONObject(headersJson);

            // 拼请求报文：顺序与 Node 生成的一致（应用头 → Content-Length → Connection）。
            StringBuilder head = new StringBuilder();
            head.append(method == null ? "GET" : method.toUpperCase(Locale.ROOT))
                .append(' ').append(path).append(" HTTP/1.1\r\n");
            head.append("Host: ").append(host).append(port == 443 || port == 80 ? "" : ":" + port).append("\r\n");
            List<String> used = new ArrayList<>();
            for (java.util.Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String name = it.next();
                String value = headers.optString(name, null);
                if (name == null || value == null) continue;
                if (name.equalsIgnoreCase("host") || name.equalsIgnoreCase("content-length")
                    || name.equalsIgnoreCase("connection")) continue;
                head.append(name).append(": ").append(value).append("\r\n");
                used.add(name.toLowerCase(Locale.ROOT));
            }
            if (payload.length > 0) head.append("Content-Length: ").append(payload.length).append("\r\n");
            head.append("Connection: keep-alive\r\n\r\n");

            byte[] headBytes = head.toString().getBytes(StandardCharsets.UTF_8);

            Socket socket = secure
                ? SSLSocketFactory.getDefault().createSocket()
                : new Socket();
            socket.connect(new InetSocketAddress(host, port), CONNECT_TIMEOUT_MS);
            socket.setSoTimeout(READ_TIMEOUT_MS);
            if (secure) ((SSLSocket) socket).startHandshake();

            OutputStream out = socket.getOutputStream();
            out.write(headBytes);
            if (payload.length > 0) out.write(payload);
            out.flush();

            // 读响应：先读头，再按 Content-Length 或 chunked 读正文。
            InputStream in = socket.getInputStream();
            ByteArrayOutputStream headerBuffer = new ByteArrayOutputStream();
            int state = 0; // 匹配 \r\n\r\n
            int b;
            while ((b = in.read()) != -1) {
                headerBuffer.write(b);
                state = (state == 0 && b == '\r') ? 1
                    : (state == 1 && b == '\n') ? 2
                    : (state == 2 && b == '\r') ? 3
                    : (state == 3 && b == '\n') ? 4 : (b == '\r' ? 1 : 0);
                if (state == 4) break;
            }
            String headerText = headerBuffer.toString("ISO-8859-1");
            String[] headerLines = headerText.split("\r\n");
            String statusLine = headerLines.length > 0 ? headerLines[0] : "";
            int status = 0;
            try {
                String[] parts = statusLine.split(" ");
                if (parts.length > 1) status = Integer.parseInt(parts[1]);
            } catch (Exception ignored) { /* keep 0 */ }

            JSONObject headerMap = new JSONObject();
            long contentLength = -1;
            boolean chunked = false;
            boolean gzipped = false;
            for (int i = 1; i < headerLines.length; i++) {
                int colon = headerLines[i].indexOf(':');
                if (colon <= 0) continue;
                String name = headerLines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String value = headerLines[i].substring(colon + 1).trim();
                headerMap.put(name, value);
                if (name.equals("content-length")) {
                    try { contentLength = Long.parseLong(value); } catch (Exception ignored) { /* ignored */ }
                } else if (name.equals("transfer-encoding") && value.toLowerCase(Locale.ROOT).contains("chunked")) {
                    chunked = true;
                } else if (name.equals("content-encoding") && value.toLowerCase(Locale.ROOT).contains("gzip")) {
                    gzipped = true;
                }
            }

            ByteArrayOutputStream bodyBuffer = new ByteArrayOutputStream();
            if (chunked) {
                readChunkedBody(in, bodyBuffer);
            } else if (contentLength >= 0) {
                byte[] chunk = new byte[8192];
                long remaining = contentLength;
                while (remaining > 0) {
                    int read = in.read(chunk, 0, (int) Math.min(chunk.length, remaining));
                    if (read == -1) break;
                    bodyBuffer.write(chunk, 0, read);
                    remaining -= read;
                }
            }
            socket.close();

            byte[] body = bodyBuffer.toByteArray();
            if (gzipped && body.length > 2 && body[0] == 0x1f && body[1] == (byte) 0x8b) {
                body = gunzip(body);
                // 已解压：清掉编码头，JS 侧（bodian 的 zlib shim）就不会再解一次。
                headerMap.put("content-encoding", "");
            }

            result.put("status", status);
            result.put("headers", headerMap);
            result.put("bodyBase64", Base64.encodeToString(body, Base64.NO_WRAP));
        } catch (Exception error) {
            try {
                result.put("error", String.valueOf(error.getMessage()));
            } catch (Exception ignored) {
                return "{\"error\":\"native http failed\"}";
            }
        }
        return result.toString();
    }

    /** chunked 正文：每块以十六进制长度开头，0 块结束。 */
    private static void readChunkedBody(InputStream in, ByteArrayOutputStream sink) throws Exception {
        while (true) {
            StringBuilder lengthLine = new StringBuilder();
            int b;
            while ((b = in.read()) != -1) {
                if (b == '\n') break;
                if (b != '\r') lengthLine.append((char) b);
            }
            String sizeText = lengthLine.toString().trim();
            int semicolon = sizeText.indexOf(';');
            if (semicolon >= 0) sizeText = sizeText.substring(0, semicolon);
            int size = Integer.parseInt(sizeText, 16);
            if (size == 0) {
                // 尾随头，读到空行为止。
                while ((b = in.read()) != -1) {
                    if (b == '\n') {
                        int peek = in.read();
                        if (peek == '\r') { in.read(); break; }
                        if (peek == '\n' || peek == -1) break;
                    }
                }
                return;
            }
            byte[] chunk = new byte[size];
            int offset = 0;
            while (offset < size) {
                int read = in.read(chunk, offset, size - offset);
                if (read == -1) return;
                offset += read;
            }
            sink.write(chunk);
            in.read(); in.read(); // 每块结尾的 CRLF
        }
    }

    private static byte[] gunzip(byte[] input) throws Exception {
        try (GZIPInputStream gzip = new GZIPInputStream(new java.io.ByteArrayInputStream(input))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = gzip.read(chunk)) != -1) out.write(chunk, 0, read);
            return out.toByteArray();
        }
    }
}
