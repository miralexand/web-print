package com.webprint.client;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 检查更新与 APK 下载 / 安装。
 *
 * <p>更新源为 GitHub Releases：请求 {@code /releases/latest}，对比版本号后，
 * 从 Release 附件里挑选 {@code WebPrintClient-*.apk} 下载到应用私有目录
 * {@code files/updates/}，再通过 {@link CaptureFileProvider} 交给系统安装器安装。
 *
 * <p>全部基于框架自带的 {@link HttpURLConnection} 与 {@code org.json}，
 * 不引入任何第三方库（与整个客户端“薄壳、零依赖”的取向一致）。
 * 线程模型：网络请求在后台线程执行，回调统一切回主线程。
 */
public final class UpdateManager {

    public static final String REPO_URL = "https://github.com/miralexand/web-print";
    public static final String RELEASES_URL = REPO_URL + "/releases";
    private static final String LATEST_API =
            "https://api.github.com/repos/miralexand/web-print/releases/latest";

    /** 与桌面端一致的下载镜像前缀（GitHub 直连不稳时依次回退）。 */
    private static final String[] MIRROR_PREFIXES = {
            "",
            "https://ghproxy.net/",
            "https://gh-proxy.com/",
            "https://ghfast.top/",
    };

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private UpdateManager() {
    }

    // ------------------------------------------------------------------
    // 数据结构与回调
    // ------------------------------------------------------------------

    /** 最新版本信息。 */
    public static final class UpdateInfo {
        public String version;
        public String tag;
        public String notes;
        public String releaseUrl;
        public String apkName;
        public String apkUrl;

        /** GitHub 直连 + 镜像回退的完整下载地址列表。 */
        List<String> downloadUrls() {
            List<String> urls = new ArrayList<>();
            if (TextUtils.isEmpty(apkUrl)) {
                return urls;
            }
            for (String prefix : MIRROR_PREFIXES) {
                urls.add(prefix + apkUrl);
            }
            return urls;
        }
    }

    public interface CheckCallback {
        void onUpdateAvailable(UpdateInfo info);

        void onUpToDate(String currentVersion);

        void onError(String message);
    }

    public interface DownloadCallback {
        /** percent 为 -1 表示无法确定进度。 */
        void onProgress(int percent);

        void onDone(File apk);

        void onError(String message);
    }

    // ------------------------------------------------------------------
    // 检查更新
    // ------------------------------------------------------------------

    public static void check(final String currentVersion, final CheckCallback callback) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    conn = open(LATEST_API);
                    conn.setRequestProperty("Accept", "application/vnd.github+json");
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(20000);
                    int code = conn.getResponseCode();
                    if (code != 200) {
                        postError(callback, "HTTP " + code);
                        return;
                    }
                    String body = readAll(conn.getInputStream());
                    final JSONObject json = new JSONObject(body);
                    final UpdateInfo info = parse(json);

                    if (TextUtils.isEmpty(info.version)) {
                        postError(callback, "返回数据缺少版本号");
                        return;
                    }
                    if (!isNewer(info.version, currentVersion)) {
                        post(new Runnable() {
                            @Override
                            public void run() {
                                callback.onUpToDate(currentVersion);
                            }
                        });
                        return;
                    }
                    if (TextUtils.isEmpty(info.apkUrl)) {
                        postError(callback, "未找到 APK 附件");
                        return;
                    }
                    post(new Runnable() {
                        @Override
                        public void run() {
                            callback.onUpdateAvailable(info);
                        }
                    });
                } catch (final Exception e) {
                    postError(callback, messageOf(e));
                } finally {
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
            }
        }).start();
    }

    private static UpdateInfo parse(JSONObject json) {
        UpdateInfo info = new UpdateInfo();
        info.tag = json.optString("tag_name", "");
        info.version = stripV(info.tag);
        info.notes = json.optString("body", "");
        info.releaseUrl = json.optString("html_url", RELEASES_URL);

        JSONArray assets = json.optJSONArray("assets");
        if (assets != null) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null) {
                    continue;
                }
                String name = asset.optString("name", "");
                if (isApkAsset(name)) {
                    info.apkName = name;
                    info.apkUrl = asset.optString("browser_download_url", "");
                    break;
                }
            }
        }
        // 下载地址缺失时回退到 Release 页面，至少让用户能手动打开
        if (TextUtils.isEmpty(info.releaseUrl)) {
            info.releaseUrl = RELEASES_URL;
        }
        return info;
    }

    /** 只认客户端 APK，排除桌面安装包、压缩包与校验文件。 */
    private static boolean isApkAsset(String name) {
        if (TextUtils.isEmpty(name)) {
            return false;
        }
        String lower = name.toLowerCase(java.util.Locale.US);
        return lower.startsWith("webprintclient") && lower.endsWith(".apk");
    }

    // ------------------------------------------------------------------
    // 下载
    // ------------------------------------------------------------------

    public static void download(final Context context, final UpdateInfo info,
            final DownloadCallback callback) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                List<String> urls = info.downloadUrls();
                if (urls.isEmpty()) {
                    postDownloadError(callback, "没有可用的下载地址");
                    return;
                }
                File dir = new File(context.getFilesDir(), "updates");
                if (!dir.exists() && !dir.mkdirs()) {
                    postDownloadError(callback, "无法创建下载目录");
                    return;
                }
                File target = new File(dir, TextUtils.isEmpty(info.apkName)
                        ? "webprint-update.apk" : info.apkName);
                // 先清理同名旧包，避免半截文件被安装
                if (target.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                }

                String lastError = null;
                for (String url : urls) {
                    try {
                        downloadOne(url, target, callback);
                        final File done = target;
                        post(new Runnable() {
                            @Override
                            public void run() {
                                callback.onDone(done);
                            }
                        });
                        return;
                    } catch (Exception e) {
                        lastError = messageOf(e);
                        // 清理失败产生的半截文件后尝试下一个镜像
                        if (target.exists()) {
                            //noinspection ResultOfMethodCallIgnored
                            target.delete();
                        }
                    }
                }
                postDownloadError(callback, lastError == null ? "未知错误" : lastError);
            }
        }).start();
    }

    private static void downloadOne(String url, File target, DownloadCallback callback)
            throws Exception {
        HttpURLConnection conn = null;
        InputStream in = null;
        FileOutputStream out = null;
        try {
            conn = open(url);
            conn.setRequestProperty("Accept", "application/octet-stream");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(120000);
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new Exception("HTTP " + code);
            }
            int total = conn.getContentLength();
            in = conn.getInputStream();
            out = new FileOutputStream(target);
            byte[] buffer = new byte[16384];
            long done = 0;
            int read;
            int lastPercent = -1;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                done += read;
                if (total > 0) {
                    int percent = (int) (done * 100 / total);
                    if (percent != lastPercent) {
                        lastPercent = percent;
                        postProgress(callback, percent);
                    }
                } else {
                    postProgress(callback, -1);
                }
            }
            out.flush();
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (Exception ignored) {
                    // 忽略
                }
            }
            if (in != null) {
                try {
                    in.close();
                } catch (Exception ignored) {
                    // 忽略
                }
            }
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    // ------------------------------------------------------------------
    // 安装
    // ------------------------------------------------------------------

    /** Android 8.0+ 需要“允许安装未知应用”授权。 */
    public static boolean canInstall(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return context.getPackageManager().canRequestPackageInstalls();
        }
        return true;
    }

    /**
     * 调起系统安装器。必须在 Activity 上下文调用，并在拥有授权后调用。
     *
     * @return true 表示已成功发出安装意图
     */
    public static boolean install(Context context, File apk) {
        if (apk == null || !apk.isFile()) {
            return false;
        }
        try {
            Uri uri = CaptureFileProvider.buildUpdateUri(apk.getName());
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setInstanceFollowRedirects(true);
        // GitHub 要求带 User-Agent，否则会返回 403
        conn.setRequestProperty("User-Agent", "web-print-android");
        return conn;
    }

    /** 版本号对比：只比较前三段数字。 */
    static boolean isNewer(String latest, String current) {
        int[] a = parseVersion(latest);
        int[] b = parseVersion(current);
        for (int i = 0; i < 3; i++) {
            if (a[i] != b[i]) {
                return a[i] > b[i];
            }
        }
        return false;
    }

    private static int[] parseVersion(String value) {
        int[] out = {0, 0, 0};
        if (TextUtils.isEmpty(value)) {
            return out;
        }
        String[] parts = value.replaceAll("[^0-9.]", "").split("\\.");
        for (int i = 0; i < parts.length && i < 3; i++) {
            try {
                out[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException ignored) {
                out[i] = 0;
            }
        }
        return out;
    }

    private static String stripV(String tag) {
        if (tag == null) {
            return "";
        }
        String value = tag.trim();
        if (value.startsWith("v") || value.startsWith("V")) {
            return value.substring(1);
        }
        return value;
    }

    private static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
            if (out.size() > 512 * 1024) {
                break;
            }
        }
        return out.toString("UTF-8");
    }

    private static String messageOf(Throwable t) {
        String message = t == null ? null : t.getMessage();
        return TextUtils.isEmpty(message) ? String.valueOf(t) : message;
    }

    private static void post(Runnable runnable) {
        MAIN.post(runnable);
    }

    private static void postError(final CheckCallback callback, final String message) {
        post(new Runnable() {
            @Override
            public void run() {
                callback.onError(message);
            }
        });
    }

    private static void postProgress(final DownloadCallback callback, final int percent) {
        post(new Runnable() {
            @Override
            public void run() {
                callback.onProgress(percent);
            }
        });
    }

    private static void postDownloadError(final DownloadCallback callback, final String message) {
        post(new Runnable() {
            @Override
            public void run() {
                callback.onError(message);
            }
        });
    }
}
