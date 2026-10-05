package com.webprint.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 薄壳主界面：用 WebView 承载 web-print 服务端的网页，其余功能全部来自网页。
 *
 * <p>本类只负责三件事：
 * <ol>
 *   <li>记住/选择要连接的服务器地址（交给 {@link ServerStore}）；</li>
 *   <li>把网页装进 WebView，并让站内跳转留在应用里；</li>
 *   <li>实现 {@code <input type="file">} 的文件选择（打印的前提），以及错误页与重试。</li>
 * </ol>
 */
public class MainActivity extends Activity {

    private static final int REQ_SERVERS = 100;
    private static final int REQ_FILE_CHOOSER = 101;

    private static final String JS_BRIDGE_NAME = "AndroidBridge";

    private ServerStore mStore;
    private WebView mWebView;
    private ProgressBar mProgress;
    private TextView mErrorView;
    private Button mRetryButton;
    private LinearLayout mErrorPanel;

    /** 当前正在加载的地址，用于「刷新」「浏览器打开」以及错误页重试。 */
    private String mCurrentUrl;
    private String mFailedUrl;
    private String mErrorText;

    /** 当前显示的证书确认对话框；不为 null 表示已经有一个在等用户决定。 */
    private AlertDialog mSslDialog;

    /** 下载完成、等待安装的更新包（用户去开启“未知来源”授权后回来继续安装）。 */
    private File mPendingInstallApk;
    private TextView mUpdateMessage;
    private ProgressBar mUpdateBar;

    /** 网页 <input type="file"> 的回调，选中/取消后必须调用。 */
    private ValueCallback<Uri[]> mFilePathCallback;
    private Uri mCameraOutputUri;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        mStore = new ServerStore(this);

        setContentView(buildContentView());

        WebSettings settings = mWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setAllowFileAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(mWebView, true);
        }

        mWebView.setWebViewClient(new ShellWebViewClient());
        mWebView.setWebChromeClient(new ShellChromeClient());
        mWebView.addJavascriptInterface(new ShellJsBridge(), JS_BRIDGE_NAME);

        if (savedInstanceState != null) {
            // 屏幕旋转等场景由 manifest 的 configChanges 兜住，不会走到这里；
            // 万一被系统重建（例如进程回收），恢复浏览位置而不是白屏重来。
            String saved = savedInstanceState.getString("state_current_url");
            if (!TextUtils.isEmpty(saved)) {
                mCurrentUrl = saved;
            }
            if (mWebView.restoreState(savedInstanceState) == null) {
                loadEntry();
            }
        } else {
            loadEntry();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 用户可能刚从「安装未知应用」设置页返回：有等待安装的包就继续安装
        if (mPendingInstallApk != null) {
            maybeInstallPending();
        }
    }

    // ------------------------------------------------------------------
    // 界面
    // ------------------------------------------------------------------

    private View buildContentView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        mProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        mProgress.setMax(100);
        mProgress.setVisibility(View.GONE);
        root.addView(mProgress, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        FrameLayout content = new FrameLayout(this);

        mWebView = new WebView(this);
        content.addView(mWebView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        mErrorPanel = buildErrorPanel();
        mErrorPanel.setVisibility(View.GONE);
        content.addView(mErrorPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(content, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        return root;
    }

    private LinearLayout buildErrorPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setBackgroundColor(Ui.BG);
        int pad = dp(28);
        panel.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(getString(R.string.error_title));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        title.setTextColor(Ui.TEXT);
        title.setGravity(Gravity.CENTER);
        panel.addView(title);

        mErrorView = new TextView(this);
        mErrorView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mErrorView.setTextColor(Ui.TEXT_MUTED);
        mErrorView.setGravity(Gravity.CENTER);
        mErrorView.setLineSpacing(dp(4), 1f);
        LinearLayout.LayoutParams errorLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        errorLp.topMargin = dp(14);
        panel.addView(mErrorView, errorLp);

        mRetryButton = Ui.primaryButton(this, getString(R.string.retry));
        mRetryButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (TextUtils.isEmpty(mFailedUrl)) {
                    loadEntry();
                } else {
                    hideError();
                    loadUrl(mFailedUrl);
                }
            }
        });
        LinearLayout.LayoutParams retryLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        retryLp.topMargin = dp(20);
        panel.addView(mRetryButton, retryLp);

        Button switchServer = Ui.ghostButton(this, getString(R.string.menu_switch_server));
        switchServer.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openServers();
            }
        });
        LinearLayout.LayoutParams switchLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        switchLp.topMargin = dp(8);
        panel.addView(switchServer, switchLp);

        return panel;
    }

    private void showError(String url, String detail) {
        mFailedUrl = url;
        StringBuilder text = new StringBuilder(getString(R.string.error_hint));
        if (!TextUtils.isEmpty(detail)) {
            text.append("\n\n").append(getString(R.string.error_detail, detail));
        }
        mErrorView.setText(text.toString());
        mErrorPanel.setVisibility(View.VISIBLE);
        mWebView.setVisibility(View.GONE);
        mProgress.setVisibility(View.GONE);
    }

    private void hideError() {
        mErrorPanel.setVisibility(View.GONE);
        mWebView.setVisibility(View.VISIBLE);
    }

    // ------------------------------------------------------------------
    // 加载
    // ------------------------------------------------------------------

    /** 没有服务器就去配置；有服务器就加载它。 */
    private void loadEntry() {
        ServerStore.Server active = mStore.getActive();
        if (active == null) {
            Toast.makeText(this, R.string.no_server, Toast.LENGTH_SHORT).show();
            openServers();
            return;
        }
        loadUrl(active.url);
    }

    private void loadUrl(String url) {
        String normalized = ServerStore.normalizeUrl(url);
        if (normalized == null) {
            showError(url, getString(R.string.err_url_invalid));
            return;
        }
        // 上一页可能还留着证书确认框，加载新地址前先收掉
        dismissSslDialog();
        mCurrentUrl = normalized;
        mFailedUrl = normalized;
        hideError();
        mProgress.setVisibility(View.VISIBLE);
        mProgress.setProgress(0);
        mWebView.loadUrl(normalized);
    }

    private void openServers() {
        startActivityForResult(new Intent(this, ServersActivity.class), REQ_SERVERS);
    }

    private void reloadActiveServer() {
        ServerStore.Server active = mStore.getActive();
        if (active == null) {
            loadEntry();
            return;
        }
        // 换服务器 / 刷新前先收掉可能遗留的证书确认框，避免它挡住新页面
        dismissSslDialog();
        if (!active.url.equals(mCurrentUrl)) {
            loadUrl(active.url);
        } else {
            hideError();
            mWebView.reload();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SERVERS) {
            if (resultCode == RESULT_OK) {
                // 用户换了服务器 / 首次添加完成：切到新的地址
                ServerStore.Server active = mStore.getActive();
                String target = active == null ? null : active.url;
                if (target == null) {
                    loadEntry();
                } else if (!target.equals(mCurrentUrl)) {
                    loadUrl(target);
                }
                return;
            }
            // 用户直接返回：如果没有可用服务器，就别停在空白页
            if (mStore.isEmpty()) {
                Toast.makeText(this, R.string.no_server, Toast.LENGTH_LONG).show();
            }
            return;
        }
        if (requestCode == REQ_FILE_CHOOSER) {
            deliverFileChooserResult(resultCode, data);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (mWebView != null) {
            mWebView.saveState(outState);
        }
        if (!TextUtils.isEmpty(mCurrentUrl)) {
            outState.putString("state_current_url", mCurrentUrl);
        }
    }

    @Override
    protected void onDestroy() {
        // 及时释放，避免 WebView 泄漏 Activity
        if (mWebView != null) {
            mWebView.setWebChromeClient(null);
            mWebView.setWebViewClient(null);
            mWebView.removeJavascriptInterface(JS_BRIDGE_NAME);
            mWebView.destroy();
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------
    // 返回键
    // ------------------------------------------------------------------

    @Override
    public void onBackPressed() {
        // 错误面板显示时，网页是空的，直接走“再按一次退出”
        if (mErrorPanel.getVisibility() != View.VISIBLE && mWebView.canGoBack()) {
            mWebView.goBack();
            return;
        }
        // 同 WebView 惯例：连续按两次返回才退出，避免误触
        if (System.currentTimeMillis() - mLastBackAt < 2000L) {
            super.onBackPressed();
        } else {
            mLastBackAt = System.currentTimeMillis();
            Toast.makeText(this, R.string.press_back_again, Toast.LENGTH_SHORT).show();
        }
    }

    private long mLastBackAt;

    // ------------------------------------------------------------------
    // 菜单
    // ------------------------------------------------------------------

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(0, 1, 0, getString(R.string.menu_switch_server));
        menu.add(0, 2, 1, getString(R.string.menu_refresh));
        menu.add(0, 3, 2, getString(R.string.menu_open_browser));
        menu.add(0, 4, 3, getString(R.string.menu_about));
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        switch (item.getItemId()) {
            case 1:
                openServers();
                return true;
            case 2:
                reloadActiveServer();
                return true;
            case 3:
                openInSystemBrowser();
                return true;
            case 4:
                showAbout();
                return true;
            default:
                return super.onOptionsItemSelected(item);
        }
    }

    private void openInSystemBrowser() {
        if (TextUtils.isEmpty(mCurrentUrl)) {
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(mCurrentUrl)));
            Toast.makeText(this, R.string.opening_browser, Toast.LENGTH_SHORT).show();
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show();
        }
    }

    private void showAbout() {
        final String version = appVersion();

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, dp(8), pad, dp(4));

        TextView name = new TextView(this);
        name.setText(getString(R.string.app_name));
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        name.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        name.setTextColor(Ui.TEXT);
        box.addView(name);

        TextView ver = new TextView(this);
        ver.setText(getString(R.string.about_version, version));
        ver.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        ver.setTextColor(Ui.TEXT_MUTED);
        ver.setPadding(0, dp(2), 0, dp(12));
        box.addView(ver);

        TextView repoLabel = new TextView(this);
        repoLabel.setText(getString(R.string.about_repo_label));
        repoLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        repoLabel.setTextColor(Ui.TEXT_FAINT);
        box.addView(repoLabel);

        TextView repo = new TextView(this);
        repo.setText(UpdateManager.REPO_URL);
        repo.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        repo.setTextColor(Ui.PRIMARY);
        repo.setPadding(0, dp(2), 0, dp(12));
        repo.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openUrl(UpdateManager.REPO_URL);
            }
        });
        box.addView(repo);

        TextView body = new TextView(this);
        body.setText(getString(R.string.about_body));
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        body.setTextColor(Ui.TEXT_MUTED);
        body.setLineSpacing(dp(3), 1f);
        box.addView(body);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(box, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.about_title))
                .setView(scroll)
                .setPositiveButton(getString(R.string.about_check_update),
                        new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                checkForUpdates();
                            }
                        })
                .setNeutralButton(getString(R.string.about_open_repo),
                        new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                openUrl(UpdateManager.REPO_URL);
                            }
                        })
                .setNegativeButton(getString(R.string.about_close), null)
                .show();
    }

    private String appVersion() {
        try {
            String version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            return TextUtils.isEmpty(version) ? getString(R.string.unknown) : version;
        } catch (PackageManager.NameNotFoundException e) {
            return getString(R.string.unknown);
        }
    }

    private void openUrl(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show();
        }
    }

    // ------------------------------------------------------------------
    // 检查更新 / 下载安装
    // ------------------------------------------------------------------

    private void checkForUpdates() {
        final AlertDialog progress = new AlertDialog.Builder(this)
                .setMessage(getString(R.string.update_checking))
                .setCancelable(false)
                .create();
        progress.show();
        UpdateManager.check(appVersion(), new UpdateManager.CheckCallback() {
            @Override
            public void onUpdateAvailable(UpdateManager.UpdateInfo info) {
                dismissSafe(progress);
                showUpdateDialog(info);
            }

            @Override
            public void onUpToDate(String current) {
                dismissSafe(progress);
                Toast.makeText(MainActivity.this, getString(R.string.update_latest, current),
                        Toast.LENGTH_LONG).show();
            }

            @Override
            public void onError(String message) {
                dismissSafe(progress);
                Toast.makeText(MainActivity.this, getString(R.string.update_failed, message),
                        Toast.LENGTH_LONG).show();
            }
        });
    }

    private void showUpdateDialog(final UpdateManager.UpdateInfo info) {
        String notes = info.notes == null ? "" : info.notes.trim();
        if (notes.length() > 600) {
            notes = notes.substring(0, 600) + "…";
        }
        StringBuilder message = new StringBuilder(
                getString(R.string.update_found_message, appVersion(), info.version));
        if (!notes.isEmpty()) {
            message.append("\n\n").append(getString(R.string.update_notes_title))
                    .append('\n').append(notes);
        }
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.update_found_title))
                .setMessage(message.toString())
                .setPositiveButton(getString(R.string.update_download),
                        new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                downloadUpdate(info);
                            }
                        })
                .setNeutralButton(getString(R.string.about_open_repo),
                        new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                openUrl(info.releaseUrl);
                            }
                        })
                .setNegativeButton(getString(R.string.update_later), null)
                .show();
    }

    private void downloadUpdate(final UpdateManager.UpdateInfo info) {
        final LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, dp(8), pad, dp(4));

        mUpdateMessage = new TextView(this);
        mUpdateMessage.setText(getString(R.string.update_downloading));
        mUpdateMessage.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mUpdateMessage.setTextColor(Ui.TEXT);
        box.addView(mUpdateMessage);

        mUpdateBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        mUpdateBar.setMax(100);
        mUpdateBar.setIndeterminate(true);
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        barLp.topMargin = dp(12);
        box.addView(mUpdateBar, barLp);

        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(getString(R.string.update_found_title))
                .setView(box)
                .setCancelable(false)
                .create();
        dialog.show();

        UpdateManager.download(this, info, new UpdateManager.DownloadCallback() {
            @Override
            public void onProgress(int percent) {
                if (percent < 0) {
                    mUpdateBar.setIndeterminate(true);
                    mUpdateMessage.setText(getString(R.string.update_downloading));
                } else {
                    mUpdateBar.setIndeterminate(false);
                    mUpdateBar.setProgress(percent);
                    mUpdateMessage.setText(getString(R.string.update_download_progress, percent));
                }
            }

            @Override
            public void onDone(File apk) {
                dismissSafe(dialog);
                mPendingInstallApk = apk;
                maybeInstallPending();
            }

            @Override
            public void onError(String message) {
                dismissSafe(dialog);
                Toast.makeText(MainActivity.this, getString(R.string.update_download_failed, message),
                        Toast.LENGTH_LONG).show();
            }
        });
    }

    /** 有下载好的安装包时，尝试安装；缺少「未知来源」授权就先引导用户开启。 */
    private void maybeInstallPending() {
        if (mPendingInstallApk == null) {
            return;
        }
        if (UpdateManager.canInstall(this)) {
            boolean ok = UpdateManager.install(this, mPendingInstallApk);
            if (ok) {
                mPendingInstallApk = null;
            } else {
                Toast.makeText(this, R.string.update_install_failed, Toast.LENGTH_LONG).show();
            }
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.update_found_title))
                .setMessage(getString(R.string.update_need_permission))
                .setPositiveButton(getString(R.string.update_open_settings),
                        new DialogInterface.OnClickListener() {
                            @Override
                            public void onClick(DialogInterface dialog, int which) {
                                openUnknownSourcesSettings();
                            }
                        })
                .setNegativeButton(getString(R.string.update_later), null)
                .show();
    }

    private void openUnknownSourcesSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        Uri packageUri = Uri.parse("package:" + getPackageName());
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, packageUri));
        } catch (ActivityNotFoundException e) {
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri));
            } catch (ActivityNotFoundException ignored) {
                // 没有对应设置页，忽略
            }
        }
    }

    private void dismissSafe(AlertDialog dialog) {
        if (dialog != null && dialog.isShowing()) {
            dialog.dismiss();
        }
    }

    // ------------------------------------------------------------------
    // WebViewClient
    // ------------------------------------------------------------------

    private final class ShellWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            return handleUrl(uri);
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            // API 24 以下走这个重载
            return handleUrl(Uri.parse(url));
        }

        /** 返回 true 表示已由外部处理；http/https 一律留在 WebView 内。 */
        private boolean handleUrl(Uri uri) {
            if (uri == null) {
                return false;
            }
            String scheme = uri.getScheme();
            if (scheme == null) {
                return false;
            }
            if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                return false; // 交给 WebView 自己加载
            }
            // mailto: / tel: / intent: 等交给系统
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, R.string.no_browser, Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            super.onPageStarted(view, url, favicon);
            if (!TextUtils.isEmpty(url) && (url.startsWith("http://") || url.startsWith("https://"))) {
                mCurrentUrl = url;
            }
            mProgress.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            mProgress.setVisibility(View.GONE);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                reportError(request.getUrl() == null ? null : request.getUrl().toString(),
                        error == null ? null : String.valueOf(error.getDescription()));
            }
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedError(WebView view, int errorCode, String description,
                String failingUrl) {
            // API 23 以下只有这个重载
            reportError(failingUrl, description);
        }

        private void reportError(String url, String description) {
            String target = TextUtils.isEmpty(url) ? mCurrentUrl : url;
            showError(target, description);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                WebResourceResponse errorResponse) {
            if (request != null && request.isForMainFrame() && errorResponse != null) {
                showError(request.getUrl() == null ? null : request.getUrl().toString(),
                        getString(R.string.page_not_found, errorResponse.getStatusCode()));
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler,
                SslError error) {
            if (handler == null) {
                return;
            }
            if (mSslDialog != null) {
                // 同一个证书错误会为页面的每个子资源各回调一次；
                // 已经有一个确认框在等用户决定，后续错误一律按“取消”处理，不再弹窗。
                handler.cancel();
                return;
            }
            showSslErrorDialog(handler, error);
        }
    }

    /**
     * 证书无法通过平台校验时的确认框（框架原生 {@link AlertDialog}，不依赖 AndroidX）。
     *
     * <p>策略：HTTPS 是唯一允许的连接方式，但用户可能用自建 CA / 自签证书。
     * 平台验证失败时不再静默放行，而是明确告知风险，由用户决定
     * 「继续」（{@link SslErrorHandler#proceed()}）或「取消」
     * （{@link SslErrorHandler#cancel()} + 错误面板）。两个分支都必须落到 handler，
     * 否则这次请求会一直挂着。
     */
    private void showSslErrorDialog(final SslErrorHandler handler, final SslError error) {
        final String failedUrl = (error == null) ? null : error.getUrl();
        final String target = TextUtils.isEmpty(failedUrl) ? mCurrentUrl : failedUrl;

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle(getString(R.string.ssl_dialog_title));
        if (error == null) {
            builder.setMessage(getString(R.string.ssl_dialog_message));
        } else {
            builder.setMessage(getString(R.string.ssl_dialog_message) + "\n\n"
                    + getString(R.string.ssl_error_detail, String.valueOf(error.getPrimaryError()))
                    + "\n" + (failedUrl == null ? "" : failedUrl));
        }
        // 默认焦点与「返回键」都落在安全的一侧：取消
        builder.setPositiveButton(getString(R.string.ssl_continue),
                new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        clearSslDialog();
                        handler.proceed(); // 用户已知晓风险，继续加载
                    }
                });
        builder.setNegativeButton(getString(R.string.ssl_cancel),
                new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        clearSslDialog();
                        handleSslCancel(handler, target);
                    }
                });
        // 返回键 / 点击对话框外部 = 取消：交给 OnCancelListener，走安全分支
        builder.setCancelable(true);
        builder.setOnCancelListener(new DialogInterface.OnCancelListener() {
            @Override
            public void onCancel(DialogInterface dialog) {
                // 绝不静默放行：没有点「继续」就一律 cancel
                clearSslDialog();
                handleSslCancel(handler, target);
            }
        });

        AlertDialog dialog = builder.create();
        mSslDialog = dialog;
        dialog.show();
        // 让「取消」成为默认按钮：既安全，也符合“返回键 = 取消”的一致行为
        Button cancelButton = dialog.getButton(AlertDialog.BUTTON_NEGATIVE);
        cancelButton.setFocusableInTouchMode(true);
        cancelButton.requestFocus();
    }

    /** 取消证书错误：不放行请求，并展示已有的错误面板。 */
    private void handleSslCancel(SslErrorHandler handler, String target) {
        handler.cancel();
        showError(target, getString(R.string.ssl_dialog_title));
    }

    private void clearSslDialog() {
        mSslDialog = null;
    }

    /** 收起仍在显示的证书确认框（对话框回调里已经把 handler 处理过了）。 */
    private void dismissSslDialog() {
        AlertDialog dialog = mSslDialog;
        mSslDialog = null;
        if (dialog != null && dialog.isShowing()) {
            dialog.dismiss();
        }
    }

    // ------------------------------------------------------------------
    // WebChromeClient：文件选择 / 进度 / 权限
    // ------------------------------------------------------------------

    private final class ShellChromeClient extends WebChromeClient {

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            mProgress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            mProgress.setProgress(newProgress);
        }

        /**
         * 关键实现：网页 {@code <input type="file">} 的入口。
         *
         * <p>交给系统的文件选择器 / 相机，结果通过 {@link #onActivityResult} 回传。
         */
        @Override
        public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                FileChooserParams fileChooserParams) {
            // 上一次回调没结束就再点一次：先取消旧的，否则 input 会一直卡住
            if (mFilePathCallback != null) {
                mFilePathCallback.onReceiveValue(null);
            }
            mFilePathCallback = filePathCallback;

            Intent intent = buildFileChooserIntent(fileChooserParams);
            try {
                startActivityForResult(intent, REQ_FILE_CHOOSER);
                return true;
            } catch (ActivityNotFoundException e) {
                // 没有文件选择器：必须回调 null，否则网页 input 一直等待
                mFilePathCallback = null;
                filePathCallback.onReceiveValue(null);
                Toast.makeText(MainActivity.this, R.string.no_browser, Toast.LENGTH_LONG).show();
                return false;
            }
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
                return;
            }
            // 目前网页只用摄像头/麦克风做扫描，简单起见到这里直接拒绝，避免网页越权
            request.deny();
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
            return true; // 静音网页日志
        }
    }

    /**
     * 组装文件选择 Intent。
     *
     * <p>支持多选（{@code fileChooserParams.getMode() == MODE_OPEN_MULTIPLE}），
     * 并在允许拍照（{@code isCaptureEnabled()}）时额外提供「拍照」入口。
     */
    private Intent buildFileChooserIntent(WebChromeClient.FileChooserParams params) {
        Intent contentIntent = new Intent(Intent.ACTION_GET_CONTENT);
        contentIntent.addCategory(Intent.CATEGORY_OPENABLE);
        contentIntent.setType("*/*");

        String[] acceptTypes = null;
        if (params != null) {
            // API 24 起可用 getAcceptTypes()，用它过滤文件类型
            acceptTypes = params.getAcceptTypes();
        }
        if (acceptTypes != null && acceptTypes.length > 0) {
            List<String> mimeTypes = new ArrayList<>();
            for (String accept : acceptTypes) {
                if (!TextUtils.isEmpty(accept)) {
                    mimeTypes.add(accept);
                }
            }
            if (!mimeTypes.isEmpty()) {
                contentIntent.setType(mimeTypes.get(0));
                if (mimeTypes.size() > 1) {
                    contentIntent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toArray(new String[0]));
                }
            }
        }

        Intent chooser = new Intent(Intent.ACTION_CHOOSER);
        chooser.putExtra(Intent.EXTRA_INTENT, contentIntent);
        chooser.putExtra(Intent.EXTRA_TITLE, getString(R.string.chooser_title));

        boolean multiple = false;
        boolean capture = false;
        if (params != null) {
            multiple = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
            capture = params.isCaptureEnabled();
        }
        chooser.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);

        Intent cameraIntent = capture ? buildCameraIntent() : null;
        if (cameraIntent != null) {
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] {cameraIntent});
        }
        return chooser;
    }

    /** 网页允许拍照时，提供「拍照」作为额外来源（相机 app 写入我们提供的 content:// URI）。 */
    private Intent buildCameraIntent() {
        try {
            File dir = new File(getFilesDir(), "captures");
            if (!dir.exists() && !dir.mkdirs()) {
                return null;
            }
            String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
            File photo = new File(dir, "capture_" + stamp + ".jpg");
            mCameraOutputUri = CaptureFileProvider.buildCaptureUri(photo.getName());
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, mCameraOutputUri);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            return intent;
        } catch (Exception e) {
            mCameraOutputUri = null;
            return null;
        }
    }

    /** 把文件选择器的结果交还给网页。 */
    private void deliverFileChooserResult(int resultCode, Intent data) {
        ValueCallback<Uri[]> callback = mFilePathCallback;
        mFilePathCallback = null;
        if (callback == null) {
            return;
        }
        if (resultCode != RESULT_OK || data == null) {
            callback.onReceiveValue(null); // 用户取消：必须回调，否则网页的 input 卡住
            mCameraOutputUri = null;
            return;
        }

        Uri[] results = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN && data.getClipData() != null) {
            int count = data.getClipData().getItemCount();
            List<Uri> uris = new ArrayList<>();
            for (int i = 0; i < count; i++) {
                Uri uri = data.getClipData().getItemAt(i).getUri();
                if (uri != null) {
                    uris.add(uri);
                }
            }
            if (!uris.isEmpty()) {
                results = uris.toArray(new Uri[0]);
            }
        }
        if (results == null) {
            Uri single = data.getData();
            if (single != null) {
                results = new Uri[] {single};
            } else if (mCameraOutputUri != null) {
                // 相机 app 只写了 EXTRA_OUTPUT，没有返回 data
                results = new Uri[] {mCameraOutputUri};
            }
        }
        mCameraOutputUri = null;

        if (results == null || results.length == 0) {
            callback.onReceiveValue(null);
            return;
        }
        // 说明：ACTION_GET_CONTENT 返回的就是带读取授权的 content:// URI，WebView 可以直接读取；
        // 少数第三方文件管理器若返回 file://，WebView 也会以宿主应用身份读取（不跨进程，无 FileUriExposed 问题），
        // 因此这里不再做额外拷贝。
        callback.onReceiveValue(results);
    }

    // ------------------------------------------------------------------
    // 供错误页/网页调用的小桥
    // ------------------------------------------------------------------

    /**
     * 供错误页/网页调用的小桥。
     *
     * <p>当前错误提示用的是原生面板（{@code mErrorPanel}），不依赖网页脚本；
     * 这里保留一个只读的 retry 入口，方便后续把错误页改成 HTML 时复用。
     */
    private final class ShellJsBridge {
        @android.webkit.JavascriptInterface
        public void retry() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!TextUtils.isEmpty(mFailedUrl)) {
                        hideError();
                        loadUrl(mFailedUrl);
                    }
                }
            });
        }
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return (int) (value * density + 0.5f);
    }
}
