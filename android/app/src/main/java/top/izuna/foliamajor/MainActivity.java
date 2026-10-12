package top.izuna.foliamajor;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

// 自用 fork 的 Android 壳：
// - 沉浸式全屏（状态栏/导航栏隐藏，边缘划动临时唤出）；
// - 挂 CORS 媒体代理 WebViewClient（酷狗/QQ/波点/酷我/LX 的音频与封面注入 ACAO 头，
//   对齐桌面版 electron/main.cjs 的 onHeadersReceived）；
// - 暴露原生 HTTP 桥 __FOLIA_NATIVE_HTTP__（OkHttp，支持 GET 带 body），
//   供波点的 Node shim 使用。
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        enterImmersiveMode();
        installRenderEnhancements();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // 任何原因让系统栏回来（下拉通知、从最近任务回来）都要重新藏起来。
        if (hasFocus) {
            enterImmersiveMode();
        }
    }

    private void installRenderEnhancements() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        // CORS 头注入：替换掉 Capacitor 的默认 WebViewClient，未命中的请求仍交回原实现。
        webView.setWebViewClient(new CorsMediaWebViewClient(getBridge()));
        // 波点协议要求的「GET 带 JSON body」由这个桥承担。
        // 桥需要 WebView 引用做异步回调（evaluateJavascript），必须主线程构造。
        webView.addJavascriptInterface(new NativeHttpBridge(webView), "__FOLIA_NATIVE_HTTP__");
    }

    private void enterImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // 刘海/挖孔屏：内容铺到切口区，配合 CSS 的 viewport-fit=cover。
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }
}
