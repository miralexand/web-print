package com.webprint.client;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 系统分享面板的接收页：把别的应用分享过来的文字 / 文件直接交给服务器打印。
 *
 * <p>这是本客户端做原生壳（而不是 PWA）的主要理由：PWA 无法出现在
 * 微信 / 文件管理 / 相册的「分享」列表里。数据流全部在 {@code android.*}
 * 框架内完成，不依赖任何第三方库，也不经过 WebView：
 *
 * <ol>
 *   <li>{@link #onCreate} 解析 {@link Intent}（{@code EXTRA_STREAM}、
 *       {@code ClipData}、{@code EXTRA_TEXT}），拿到待打印条目；</li>
 *   <li>一屏确认界面：内容摘要 + 服务器选择 + 份数 + 「打印 / 取消」；</li>
 *   <li>点「打印」后在工作线程（{@link ExecutorService}）里用
 *       {@link HttpURLConnection} 手工拼 multipart/form-data 或 JSON 提交，
 *       结果通过 {@code runOnUiThread} 回主线程展示。</li>
 * </ol>
 *
 * <p>会话复用：请求前在主线程读取 {@link CookieManager#getCookie(String)}，
 * 把 WebView 里已登录的会话 Cookie 原样带上去（没有就匿名提交，走游客配额）。
 */
public class ShareActivity extends Activity {

    /** 服务端 {@code config.maxFileSize} 的默认值：20MB。 */
    private static final long MAX_FILE_BYTES = 20L * 1024 * 1024L;
    /** 服务端文本打印上限：100KB。 */
    private static final int MAX_TEXT_BYTES = 100 * 1024;
    /** 结果文本框里只保留这么多字符，避免超长错误信息撑爆界面。 */
    private static final int MAX_RESULT_CHARS = 400;

    /** 客户端本地认定的可打印类型（扩展名 → MIME、分类），与 fileValidator.js 保持一致。 */
    private static final String[] EXTENSIONS = {
            ".pdf", ".png", ".jpg", ".jpeg", ".txt",
            ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    };
    private static final String[] EXTENSION_MIME = {
            "application/pdf", "image/png", "image/jpeg", "image/jpeg", "text/plain",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };

    private ServerStore mStore;

    // 界面控件（分享打印页全部用 Java 搭建，见 ids.xml 的说明）
    private TextView mSummaryView;
    private TextView mInfoView;
    private LinearLayout mNoServerPanel;
    private LinearLayout mFormPanel;
    private TextView mServerUrlView;
    private Spinner mServerSpinner;
    private EditText mCopiesInput;
    private Button mPrintButton;
    private Button mCancelButton;
    private ProgressBar mProgress;
    private TextView mResultView;

    /** 本次待打印的条目（文本分享只有 1 条）。 */
    private final List<Item> mItems = new ArrayList<>();
    /** true 表示走 {@code /api/print/text}（JSON 文本打印）。 */
    private boolean mTextMode;
    /** 文本分享的全文（未截断），仅文本模式使用。 */
    private String mTextContent = "";

    /** 上传线程：单线程串行，保证 ACTION_SEND_MULTIPLE 逐个提交。 */
    private ExecutorService mExecutor;
    private boolean mUploading;

    private List<ServerStore.Server> mServers = new ArrayList<>();

    // ------------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTitle(getString(R.string.share_title));
        mStore = new ServerStore(this);
        mExecutor = Executors.newSingleThreadExecutor();

        setContentView(buildContentView());

        // 界面搭好后才能渲染内容（需要 mSummaryView 等控件）
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // 从分享面板再次分享时复用同一个实例（launchMode=singleTop）
        setIntent(intent);
        if (mUploading) {
            // 正在上传时不打断，避免出现两个任务同时写界面
            Toast.makeText(this, R.string.share_uploading, Toast.LENGTH_SHORT).show();
            return;
        }
        handleIntent(intent);
    }

    @Override
    protected void onDestroy() {
        if (mExecutor != null) {
            mExecutor.shutdownNow();
            mExecutor = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------
    // 界面
    // ------------------------------------------------------------------

    private View buildContentView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFFFFFFFF);

        int pad = dp(16);
        int side = dp(20);

        // ---- 标题 ----
        TextView title = new TextView(this);
        title.setText(getString(R.string.share_title));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTextColor(0xFF212121);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(side, pad, side, dp(6));
        root.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // ---- 可滚动内容区 ----
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(side, 0, side, pad);

        content.addView(label(getString(R.string.share_summary_title)));

        mSummaryView = new TextView(this);
        mSummaryView.setId(R.id.share_summary_text);
        mSummaryView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        mSummaryView.setTextColor(0xFF212121);
        mSummaryView.setLineSpacing(dp(3), 1f);
        mSummaryView.setTextIsSelectable(true);
        content.addView(mSummaryView, matchWidth());

        mInfoView = new TextView(this);
        mInfoView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mInfoView.setTextColor(0xFFD32F2F);
        mInfoView.setLineSpacing(dp(2), 1f);
        mInfoView.setVisibility(View.GONE);
        LinearLayout.LayoutParams infoLp = matchWidth();
        infoLp.topMargin = dp(8);
        content.addView(mInfoView, infoLp);

        // 「还没有服务器」时只显示这一段，不显示服务器选择与份数
        mNoServerPanel = new LinearLayout(this);
        mNoServerPanel.setOrientation(LinearLayout.VERTICAL);
        mNoServerPanel.setVisibility(View.GONE);

        TextView noServer = new TextView(this);
        noServer.setText(getString(R.string.share_no_server));
        noServer.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        noServer.setTextColor(0xFF616161);
        noServer.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams noServerLp = matchWidth();
        noServerLp.topMargin = dp(20);
        mNoServerPanel.addView(noServer, noServerLp);

        Button openServers = new Button(this);
        openServers.setId(R.id.share_open_servers_button);
        openServers.setText(getString(R.string.share_open_servers));
        openServers.setAllCaps(false);
        openServers.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openServers();
            }
        });
        LinearLayout.LayoutParams openLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        openLp.topMargin = dp(16);
        mNoServerPanel.addView(openServers, openLp);
        content.addView(mNoServerPanel, matchWidth());

        // 正常状态：服务器选择 + 份数
        mFormPanel = new LinearLayout(this);
        mFormPanel.setOrientation(LinearLayout.VERTICAL);

        mFormPanel.addView(label(getString(R.string.share_server_label)));

        // 只有一个服务器时不显示下拉框，直接显示地址（下拉框保持 GONE 占位）
        mServerUrlView = new TextView(this);
        mServerUrlView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mServerUrlView.setTextColor(0xFF1A73E8);
        mServerUrlView.setPadding(0, dp(4), 0, dp(4));
        mFormPanel.addView(mServerUrlView, matchWidth());

        mServerSpinner = new Spinner(this);
        mServerSpinner.setId(R.id.share_server_spinner);
        mServerSpinner.setVisibility(View.GONE);
        mServerSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position >= 0 && position < mServers.size()) {
                    // 用户在这里换服务器 = 切换当前服务器，和「设置页」的行为一致
                    mStore.setActive(position);
                }
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
                // 不需要处理
            }
        });
        mFormPanel.addView(mServerSpinner, matchWidth());

        mFormPanel.addView(label(getString(R.string.share_copies_label)));

        mCopiesInput = new EditText(this);
        mCopiesInput.setId(R.id.share_copies_input);
        mCopiesInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        mCopiesInput.setFilters(new InputFilter[] {new InputFilter.LengthFilter(2)});
        mCopiesInput.setSingleLine(true);
        mCopiesInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        mCopiesInput.setText("1");
        mCopiesInput.setSelection(mCopiesInput.getText().length());
        mFormPanel.addView(mCopiesInput, matchWidth());

        content.addView(mFormPanel, matchWidth());

        // ---- 结果区 ----
        mProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
        mProgress.setVisibility(View.GONE);
        LinearLayout.LayoutParams progressLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        progressLp.topMargin = dp(16);
        content.addView(mProgress, progressLp);

        mResultView = new TextView(this);
        mResultView.setId(R.id.share_result_text);
        mResultView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mResultView.setTextColor(0xFF616161);
        mResultView.setLineSpacing(dp(3), 1f);
        mResultView.setTextIsSelectable(true);
        LinearLayout.LayoutParams resultLp = matchWidth();
        resultLp.topMargin = dp(12);
        content.addView(mResultView, resultLp);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(content, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // ---- 底部按钮 ----
        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        buttons.setPadding(side, pad, side, pad);

        mCancelButton = new Button(this);
        mCancelButton.setId(R.id.share_cancel_button);
        mCancelButton.setText(getString(R.string.share_cancel));
        mCancelButton.setAllCaps(false);
        mCancelButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        buttons.addView(mCancelButton);

        mPrintButton = new Button(this);
        mPrintButton.setId(R.id.share_print_button);
        mPrintButton.setText(getString(R.string.share_print));
        mPrintButton.setAllCaps(false);
        mPrintButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onPrintClicked();
            }
        });
        LinearLayout.LayoutParams printLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        printLp.leftMargin = dp(12);
        buttons.addView(mPrintButton, printLp);

        root.addView(buttons, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return root;
    }

    private TextView label(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        tv.setTextColor(0xFF616161);
        tv.setPadding(0, dp(18), 0, 0);
        return tv;
    }

    private LinearLayout.LayoutParams matchWidth() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    // ------------------------------------------------------------------
    // Intent 解析
    // ------------------------------------------------------------------

    /**
     * 解析分享 Intent 并刷新界面。
     *
     * <p>优先级：文件（{@code EXTRA_STREAM} / {@code ClipData}）&gt; 文字（{@code EXTRA_TEXT}）。
     * 两者同时存在时以文件为准。
     */
    private void handleIntent(Intent intent) {
        mItems.clear();
        mTextMode = false;
        mTextContent = "";

        int unusableStreams = 0;
        if (intent != null) {
            String action = intent.getAction();
            boolean multiple = Intent.ACTION_SEND_MULTIPLE.equals(action);
            if (multiple) {
                // 多选：优先 ClipData，其次 ArrayList<Uri> 额外数据
                List<Uri> uris = new ArrayList<>();
                ClipData clip = intent.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        Uri uri = clip.getItemAt(i).getUri();
                        if (uri != null) {
                            uris.add(uri);
                        }
                    }
                }
                if (uris.isEmpty()) {
                    ArrayList<Uri> extra = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                    if (extra != null) {
                        for (Uri uri : extra) {
                            if (uri != null) {
                                uris.add(uri);
                            }
                        }
                    }
                }
                for (Uri uri : uris) {
                    Item item = readFile(uri, intent.getType());
                    if (item == null) {
                        unusableStreams++;
                    } else {
                        mItems.add(item);
                    }
                }
                if (unusableStreams > 0 && mItems.isEmpty()) {
                    setResultLine(prefixErr(getString(R.string.share_err_no_item)), true);
                }
            } else {
                Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (stream != null) {
                    Item item = readFile(stream, intent.getType());
                    if (item != null) {
                        mItems.add(item);
                    } else {
                        unusableStreams++;
                    }
                }
                if (mItems.isEmpty()) {
                    // 没有可读的文件（或压根没有 stream）时再考虑文字
                    String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                    if (text == null) {
                        text = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                    }
                    if (!TextUtils.isEmpty(text) && !text.trim().isEmpty()) {
                        mTextContent = text;
                        mTextMode = true;
                    }
                }
            }
        }

        bindServerPicker();
        renderSummary();

        if (mItems.isEmpty() && !mTextMode) {
            mPrintButton.setEnabled(false);
            if (unusableStreams == 0) {
                setResultLine(prefixErr(getString(R.string.share_err_no_item)), true);
            }
        }
    }

    /**
     * 读取一个 {@code content://} / {@code file://} 条目：显示名、大小、字节。
     *
     * <p>失败（{@link FileNotFoundException} / {@link SecurityException} 等）返回 {@code null}，
     * 由调用方给出中文提示，绝不抛出到上层。
     */
    private Item readFile(Uri uri, String intentType) {
        if (uri == null) {
            return null;
        }
        Item item = new Item();
        item.uri = uri;
        item.name = displayName(uri);
        item.size = querySize(uri);

        String mime = null;
        try {
            mime = getContentResolver().getType(uri);
        } catch (Exception ignored) {
            // 某些 provider 会抛异常，忽略并回退到扩展名判断
        }
        if (TextUtils.isEmpty(mime) || "application/octet-stream".equals(mime)) {
            mime = mimeForExtension(extensionOf(item.name));
        }
        if (TextUtils.isEmpty(mime) && !TextUtils.isEmpty(intentType)
                && intentType.indexOf('/') > 0 && !intentType.endsWith("/*")) {
            mime = intentType;
        }
        if (TextUtils.isEmpty(mime)) {
            mime = "application/octet-stream";
        }
        item.mime = mime;
        item.extension = resolveExtension(item.name, mime);

        try {
            item.bytes = readAllBytes(uri);
        } catch (FileNotFoundException e) {
            setResultLine(prefixErr(getString(R.string.share_err_read, describe(uri, e))), true);
            return null;
        } catch (SecurityException e) {
            setResultLine(prefixErr(getString(R.string.share_err_read, describe(uri, e))), true);
            return null;
        } catch (IOException e) {
            setResultLine(prefixErr(getString(R.string.share_err_read, describe(uri, e))), true);
            return null;
        } catch (OutOfMemoryError e) {
            setResultLine(prefixErr(getString(R.string.share_err_size)), true);
            return null;
        }
        if (item.size <= 0 && item.bytes != null) {
            // 拿不到 SIZE 时用实际读到的长度兜底
            item.size = item.bytes.length;
        }
        return item;
    }

    private static String describe(Uri uri, Exception e) {
        String message = e.getMessage();
        if (TextUtils.isEmpty(message)) {
            message = e.getClass().getSimpleName();
        }
        return uri + " (" + message + ")";
    }

    /** 用 {@link ContentResolver} 查显示名与大小，失败时回退到 URI 最后一段。 */
    private String displayName(Uri uri) {
        String scheme = uri.getScheme();
        if ("file".equalsIgnoreCase(scheme)) {
            String path = uri.getPath();
            if (!TextUtils.isEmpty(path)) {
                String name = new File(path).getName();
                if (!TextUtils.isEmpty(name)) {
                    return name;
                }
            }
        }
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri,
                    new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0 && !cursor.isNull(index)) {
                    String name = cursor.getString(index);
                    if (!TextUtils.isEmpty(name)) {
                        return name;
                    }
                }
            }
        } catch (Exception ignored) {
            // provider 不支持查询：回退
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        String last = uri.getLastPathSegment();
        return TextUtils.isEmpty(last) ? uri.toString() : last;
    }

    /** 查询大小，未知返回 -1。 */
    private long querySize(Uri uri) {
        String scheme = uri.getScheme();
        if ("file".equalsIgnoreCase(scheme)) {
            String path = uri.getPath();
            if (!TextUtils.isEmpty(path)) {
                File file = new File(path);
                if (file.isFile()) {
                    return file.length();
                }
            }
        }
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(uri,
                    new String[] {OpenableColumns.SIZE}, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0 && !cursor.isNull(index)) {
                    return cursor.getLong(index);
                }
            }
        } catch (Exception ignored) {
            // provider 不支持查询：当作未知大小
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return -1L;
    }

    private byte[] readAllBytes(Uri uri) throws IOException {
        InputStream in = null;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in == null) {
                throw new FileNotFoundException("openInputStream returned null");
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream(8192);
            byte[] buffer = new byte[8192];
            int read;
            long total = 0;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > MAX_FILE_BYTES) {
                    // 提前停止，避免为了报错把 20MB+ 全读进内存
                    throw new IOException("file too large");
                }
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        } finally {
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 关闭失败无需处理
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // 渲染
    // ------------------------------------------------------------------

    private void bindServerPicker() {
        mServers = mStore.list();
        boolean hasServer = !mServers.isEmpty();
        mNoServerPanel.setVisibility(hasServer ? View.GONE : View.VISIBLE);
        mFormPanel.setVisibility(hasServer ? View.VISIBLE : View.GONE);
        if (!hasServer) {
            mPrintButton.setEnabled(false);
            return;
        }

        boolean multiple = mServers.size() > 1;
        mServerSpinner.setVisibility(multiple ? View.VISIBLE : View.GONE);
        mServerUrlView.setVisibility(multiple ? View.GONE : View.VISIBLE);
        if (multiple) {
            List<String> names = new ArrayList<>();
            for (ServerStore.Server server : mServers) {
                names.add(server.displayName(getString(R.string.server_unnamed))
                        + "（" + server.url + "）");
            }
            ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                    android.R.layout.simple_spinner_item, names);
            adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
            mServerSpinner.setAdapter(adapter);
            int active = mStore.getActiveIndex();
            if (active >= 0 && active < names.size()) {
                mServerSpinner.setSelection(active);
            }
        } else {
            mServerUrlView.setText(mServers.get(0).url);
        }
    }

    /** 生成「将要打印什么」的摘要，并做可否打印的上游判断。 */
    private void renderSummary() {
        StringBuilder summary = new StringBuilder();
        StringBuilder info = new StringBuilder();

        if (mTextMode) {
            summary.append(getString(R.string.share_text_title)).append('\n');
            summary.append(preview(mTextContent, 300));
            if (!TextUtils.isEmpty(mTextContent)) {
                summary.append('\n');
            }
            summary.append(getString(R.string.share_text_meta, mTextContent.length()));
        } else if (!mItems.isEmpty()) {
            if (mItems.size() > 1) {
                summary.append(getString(R.string.share_batch, mItems.size())).append('\n');
            }
            for (int i = 0; i < mItems.size(); i++) {
                Item item = mItems.get(i);
                if (i > 0) {
                    summary.append('\n');
                }
                summary.append(item.name).append("（").append(sizeText(item.size)).append("）");
            }
            int usable = 0;
            for (Item item : mItems) {
                String problem = validate(item);
                if (problem == null) {
                    usable++;
                    continue;
                }
                if (info.length() > 0) {
                    info.append('\n');
                }
                info.append(item.name).append("：").append(problem);
            }
            if (!mUploading) {
                // 一个能打的都没有时直接禁用「打印」，让用户先看到红字说明；
                // 反过来（比如刚在服务器列表页添加了服务器）也要恢复可点
                mPrintButton.setEnabled(usable > 0 && mStore.getActive() != null);
            }
        }
        mSummaryView.setText(summary.length() == 0 ? getString(R.string.unknown) : summary.toString());
        if (info.length() > 0) {
            mInfoView.setText(info.toString());
            mInfoView.setVisibility(View.VISIBLE);
        } else {
            mInfoView.setVisibility(View.GONE);
        }
    }

    /**
     * 上传前的本地校验（与 fileValidator.js 对齐）。
     *
     * @return 中文错误说明；{@code null} 表示这一条可以上传
     */
    private String validate(Item item) {
        if (item.size > MAX_FILE_BYTES) {
            return getString(R.string.share_err_size);
        }
        if (item.size <= 0) {
            return getString(R.string.share_err_unknown_size);
        }
        String extension = item.extension != null ? item.extension
                : resolveExtension(item.name, item.mime);
        if (TextUtils.isEmpty(extension)) {
            return getString(R.string.share_err_extension);
        }
        if (mimeForExtension(extension) == null) {
            return getString(R.string.share_err_type);
        }
        return null;
    }

    // ------------------------------------------------------------------
    // 提交
    // ------------------------------------------------------------------

    private void onPrintClicked() {
        if (mUploading) {
            return;
        }
        if (mStore.isEmpty()) {
            bindServerPicker();
            return;
        }
        if (!mTextMode && mItems.isEmpty()) {
            setResultLine(prefixErr(getString(R.string.share_err_no_item)), true);
            return;
        }
        // 服务端文本上限 100KB：先说清楚，不浪费一次请求
        if (mTextMode && utf8Length(mTextContent) > MAX_TEXT_BYTES) {
            setResultLine(prefixErr(getString(R.string.share_err_text_too_long)), true);
            return;
        }

        int copies = parseCopies(false);
        if (copies <= 0) {
            return; // parseCopies 已经给出中文提示
        }

        // 逐个校验：能打的上传，不能打的先说明原因
        List<Item> queue = new ArrayList<>();
        List<String> problems = new ArrayList<>();
        if (!mTextMode) {
            for (Item item : mItems) {
                String problem = validate(item);
                if (problem == null) {
                    queue.add(item);
                } else {
                    problems.add(item.name + "：" + problem);
                }
            }
            if (queue.isEmpty()) {
                setResultLine(prefixErr(join(problems)), true);
                return;
            }
        }

        String base = ServerStore.normalizeUrl(selectedServerUrl());
        if (base == null) {
            // ServerStore 只保存 https 地址，这里只是兜底（不放开 HTTPS-only 策略）
            setResultLine(prefixErr(getString(R.string.share_err_insecure_url)), true);
            return;
        }

        beginUpload(base, copies, queue, problems);
    }

    private void beginUpload(final String baseUrl, final int copies,
            final List<Item> queue, final List<String> problems) {
        mUploading = true;
        mPrintButton.setEnabled(false);
        mCopiesInput.setEnabled(false);
        mServerSpinner.setEnabled(false);
        mProgress.setVisibility(View.VISIBLE);
        mResultView.setTextColor(0xFF616161);
        mResultView.setText(mTextMode
                ? getString(R.string.share_uploading)
                : getString(R.string.share_item_progress, 1, queue.size()));

        // CookieManager 只能在主线程访问：这里先取好 Cookie 再进工作线程
        final String cookie = readCookie(baseUrl);
        final int total = mTextMode ? 1 : queue.size();
        // 工作线程里不方便取资源，先在主线程取好结果行用的文案
        final String textLabel = getString(R.string.share_text_title);

        mExecutor.execute(new Runnable() {
            @Override
            public void run() {
                final UploadResult result = new UploadResult();
                try {
                    if (mTextMode) {
                        result.add(submitText(baseUrl, cookie, copies, mTextContent, textLabel));
                    } else {
                        int index = 0;
                        for (Item item : queue) {
                            index++;
                            final int current = index;
                            final String name = item.name;
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    mResultView.setText(getString(
                                            R.string.share_item_progress, current, total)
                                            + "\n" + name);
                                }
                            });
                            result.add(submitFile(baseUrl, cookie, copies, item));
                        }
                    }
                } catch (Throwable t) {
                    // 兜底：任何意外都不能让上传线程带着异常消失
                    result.add(Result.failure(textLabel, networkError(t)));
                } finally {
                    // 一次请求都没发出去（例如工作线程被提前打断）时也要如实报告失败，
                    // 否则界面会误报成功
                    if (result.results.isEmpty()) {
                        result.add(Result.failure(textLabel,
                                getString(R.string.share_err_no_item)));
                    }
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            finishUpload(result, problems);
                        }
                    });
                }
            }
        });
    }

    private void finishUpload(UploadResult result, List<String> problems) {
        mUploading = false;
        mProgress.setVisibility(View.GONE);
        mPrintButton.setEnabled(true);
        mCopiesInput.setEnabled(true);
        mServerSpinner.setEnabled(true);

        int failures = result.failures();
        String quota = quotaSuffix(result.lastQuota);
        StringBuilder text = new StringBuilder();

        if (failures == 0) {
            if (result.results.size() == 1) {
                text.append(getString(R.string.share_done));
                String task = result.results.get(0).taskId;
                if (!TextUtils.isEmpty(task)) {
                    text.append("（OK task=").append(task).append("）");
                } else {
                    text.append("（OK）");
                }
                text.append(quota);
            } else {
                text.append(getString(R.string.share_batch_done))
                        .append("（OK ").append(result.results.size()).append(" 个）")
                        .append(quota);
                for (Result one : result.results) {
                    text.append('\n').append(one.name);
                    if (!TextUtils.isEmpty(one.taskId)) {
                        text.append("  OK task=").append(one.taskId);
                    } else {
                        text.append("  OK");
                    }
                }
            }
            mResultView.setTextColor(0xFF2E7D32);
        } else {
            if (result.results.size() > 1) {
                text.append(getString(R.string.share_batch_failed, failures)).append('\n');
            }
            for (Result one : result.results) {
                if (text.length() > 0) {
                    text.append('\n');
                }
                if (one.ok) {
                    text.append(one.name).append("  OK task=")
                            .append(TextUtils.isEmpty(one.taskId) ? "-" : one.taskId);
                } else {
                    text.append(one.name).append("  ERR ").append(one.error);
                }
            }
            // 本地就被判定不可打印的条目也一并列出，避免“点完没反应”
            for (String problem : problems) {
                if (text.length() > 0) {
                    text.append('\n');
                }
                text.append(problem).append("  ERR");
            }
            mResultView.setTextColor(0xFFD32F2F);
        }
        mResultView.setText(clamp(text.toString()));
        // 多选完成后，剩下的内容已经提交过，避免重复点「打印」重复上传
        if (failures == 0 && result.results.size() > 1) {
            mPrintButton.setEnabled(false);
        }
    }

    /** 当前应当使用的服务器地址：Spinner 选中项优先，否则用当前激活服务器。 */
    private String selectedServerUrl() {
        int position = mServerSpinner.getVisibility() == View.VISIBLE
                ? mServerSpinner.getSelectedItemPosition() : -1;
        if (position >= 0 && position < mServers.size()) {
            return mServers.get(position).url;
        }
        ServerStore.Server active = mStore.getActive();
        if (active != null) {
            return active.url;
        }
        return mServers.isEmpty() ? null : mServers.get(0).url;
    }

    /** 读取 WebView 的会话 Cookie；没有会话时返回 null（匿名提交，走游客配额）。 */
    private String readCookie(String baseUrl) {
        try {
            CookieManager manager = CookieManager.getInstance();
            String cookie = manager.getCookie(baseUrl);
            return TextUtils.isEmpty(cookie) ? null : cookie;
        } catch (Exception e) {
            // 极端情况下 CookieManager 不可用：退化为匿名提交
            return null;
        }
    }

    private int parseCopies(boolean quiet) {
        String raw = mCopiesInput.getText().toString().trim();
        int value = 1;
        if (!raw.isEmpty()) {
            try {
                value = Integer.parseInt(raw);
            } catch (NumberFormatException e) {
                value = -1;
            }
        }
        if (value < 1 || value > 99) {
            if (!quiet) {
                Toast.makeText(this, R.string.share_err_copies, Toast.LENGTH_LONG).show();
                mCopiesInput.setText("1");
                mCopiesInput.setSelection(mCopiesInput.getText().length());
            }
            return -1;
        }
        return value;
    }

    // ------------------------------------------------------------------
    // 网络（工作线程）
    // ------------------------------------------------------------------

    private Result submitFile(String baseUrl, String cookie, int copies, Item item) {
        HttpURLConnection conn = null;
        try {
            MultipartBody body = buildMultipart(item, copies);
            URL url = new URL(baseUrl + "/api/print");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setUseCaches(false);
            conn.setRequestProperty("Content-Type",
                    "multipart/form-data; boundary=" + body.boundary);
            conn.setRequestProperty("Content-Length", String.valueOf(body.bytes.length));
            // 会话复用：把 WebView 已登录的 Cookie 原样带上（没有就匿名提交）
            if (cookie != null) {
                conn.setRequestProperty("Cookie", cookie);
            }
            conn.setRequestProperty("User-Agent", "web-print-android/1.0");

            OutputStream out = conn.getOutputStream();
            try {
                out.write(body.bytes);
                out.flush();
            } finally {
                out.close();
            }
            return readResult(conn, item.name);
        } catch (Throwable t) {
            return Result.failure(item.name, networkError(t));
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private Result submitText(String baseUrl, String cookie, int copies, String content,
            String label) {
        HttpURLConnection conn = null;
        try {
            JSONObject json = new JSONObject();
            json.put("content", content);
            json.put("copies", copies);
            json.put("color", "mono");
            json.put("paperSize", "A4");
            json.put("printer", "");
            byte[] payload = json.toString().getBytes(Charset.forName("UTF-8"));

            URL url = new URL(baseUrl + "/api/print/text");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setUseCaches(false);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Content-Length", String.valueOf(payload.length));
            if (cookie != null) {
                conn.setRequestProperty("Cookie", cookie);
            }
            conn.setRequestProperty("User-Agent", "web-print-android/1.0");

            OutputStream out = conn.getOutputStream();
            try {
                out.write(payload);
                out.flush();
            } finally {
                out.close();
            }
            return readResult(conn, label);
        } catch (Throwable t) {
            return Result.failure(label, networkError(t));
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /** 读取响应：201 视为成功，其它状态把服务器返回的 {@code error} 原文透传给用户。 */
    private Result readResult(HttpURLConnection conn, String label) {
        int code;
        String message = null;
        try {
            code = conn.getResponseCode();
        } catch (IOException e) {
            return Result.failure(label, networkError(e));
        }
        InputStream stream = null;
        try {
            stream = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
        } catch (IOException ignored) {
            stream = null;
        }
        String body = null;
        if (stream != null) {
            try {
                body = readStream(stream);
            } catch (IOException e) {
                message = e.getMessage();
            } finally {
                try {
                    stream.close();
                } catch (IOException ignored) {
                    // 忽略
                }
            }
        }

        JSONObject json = null;
        if (!TextUtils.isEmpty(body)) {
            try {
                json = new JSONObject(body);
            } catch (Exception ignored) {
                json = null;
            }
        }
        String serverError = json == null ? null : json.optString("error", null);

        if (code == 201 || code == 200) {
            Result result = Result.success(label);
            if (json != null) {
                JSONObject task = json.optJSONObject("task");
                if (task != null) {
                    result.taskId = task.optString("id", null);
                }
                result.quota = json.optJSONObject("quota");
            }
            return result;
        }
        if (code == 429) {
            String detail = !TextUtils.isEmpty(serverError) ? serverError
                    : getString(R.string.share_err_http, code);
            return Result.failure(label, getString(R.string.share_err_quota, detail));
        }
        if (!TextUtils.isEmpty(serverError)) {
            return Result.failure(label, serverError);
        }
        if (!TextUtils.isEmpty(body)) {
            return Result.failure(label, getString(R.string.share_err_response, preview(body, 120)));
        }
        if (message != null) {
            return Result.failure(label, getString(R.string.share_err_upload, message));
        }
        return Result.failure(label, getString(R.string.share_err_http, code));
    }

    private static String readStream(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(4096);
        byte[] buffer = new byte[4096];
        int read;
        while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
            if (out.size() > 256 * 1024) {
                break; // 响应体正常都很小，防止异常服务端拖垮客户端
            }
        }
        return out.toString("UTF-8");
    }

    private String networkError(Throwable t) {
        String message = t.getMessage();
        if (TextUtils.isEmpty(message)) {
            message = t.getClass().getSimpleName();
        }
        return getString(R.string.share_err_network, message);
    }

    // ------------------------------------------------------------------
    // multipart/form-data（手工拼装，无第三方依赖）
    // ------------------------------------------------------------------

    /**
     * 手工拼 multipart/form-data 请求体。
     *
     * <p>字段名与服务端 {@code upload.single('file')} 严格对应：
     * {@code file} / {@code copies} / {@code pages}（空串 = 全部页）/
     * {@code color}（固定 mono）/ {@code paperSize}（固定 A4）/ {@code printer}（空 = 默认打印机）。
     * 文件部分不带 {@code Content-Type}，由服务端按扩展名与文件头校验。
     *
     * <p>先算出总长度再一次性写出，目的是能给出准确的 {@code Content-Length}
     * （服务端 multer 也能据此拒绝超大请求）。
     */
    private MultipartBody buildMultipart(Item item, int copies) {
        String boundary = "----WebPrintAndroid"
                + Long.toHexString(System.currentTimeMillis())
                + Long.toHexString(Double.doubleToLongBits(Math.random()));
        Charset utf8 = Charset.forName("UTF-8");

        ByteArrayOutputStream head = new ByteArrayOutputStream();
        try {
            for (String[] field : new String[][] {
                    {"copies", String.valueOf(copies)},
                    {"pages", ""},
                    {"color", "mono"},
                    {"paperSize", "A4"},
                    {"printer", ""}}) {
                head.write(("--" + boundary + "\r\n").getBytes(utf8));
                head.write(("Content-Disposition: form-data; name=\"" + field[0] + "\"\r\n\r\n")
                        .getBytes(utf8));
                head.write(field[1].getBytes(utf8));
                head.write("\r\n".getBytes(utf8));
            }
            head.write(("--" + boundary + "\r\n").getBytes(utf8));
            head.write(("Content-Disposition: form-data; name=\"file\"; filename=\""
                    + sanitizeFilename(item.name) + "\"\r\n").getBytes(utf8));
            head.write("\r\n".getBytes(utf8));
            head.write(item.bytes);
            head.write("\r\n".getBytes(utf8));
            head.write(("--" + boundary + "--\r\n").getBytes(utf8));
        } catch (IOException e) {
            // ByteArrayOutputStream 不会抛 IOException
            throw new IllegalStateException(e);
        }
        return new MultipartBody(boundary, head.toByteArray());
    }

    /** 文件名只保留安全字符（含中文），防止换行/引号破坏 multipart 头。 */
    private static String sanitizeFilename(String name) {
        String cleaned = (name == null) ? "" : name.replaceAll("[\\r\\n\"]", "_").trim();
        return cleaned.isEmpty() ? "share" : cleaned;
    }

    private static final class MultipartBody {
        final String boundary;
        final byte[] bytes;

        MultipartBody(String boundary, byte[] bytes) {
            this.boundary = boundary;
            this.bytes = bytes;
        }
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    /** 打开服务器列表页；回来后在 {@link #onResume} 里重新绑定。 */
    private void openServers() {
        try {
            startActivity(new Intent(this, ServersActivity.class));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_server, Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 用户可能刚从服务器列表页回来：重新读取服务器并刷新摘要
        if (mExecutor != null) {
            bindServerPicker();
            renderSummary();
        }
    }

    /** 结果行：始终带上机器可断言的标记（ERR / OK task=）。 */
    private void setResultLine(String text, boolean error) {
        mResultView.setTextColor(error ? 0xFFD32F2F : 0xFF616161);
        mResultView.setText(clamp(text));
    }

    private static String prefixErr(String message) {
        String text = TextUtils.isEmpty(message) ? "" : message;
        return "ERR " + text;
    }

    private static String join(List<String> lines) {
        StringBuilder builder = new StringBuilder();
        for (String line : lines) {
            if (builder.length() > 0) {
                builder.append('\n');
            }
            builder.append(line);
        }
        return builder.toString();
    }

    private static String clamp(String text) {
        if (text == null) {
            return "";
        }
        return text.length() <= MAX_RESULT_CHARS ? text : text.substring(0, MAX_RESULT_CHARS) + "…";
    }

    private String quotaSuffix(JSONObject quota) {
        if (quota == null || quota.optBoolean("unlimited", false)) {
            return "";
        }
        int remaining = quota.optInt("remaining", -1);
        return remaining < 0 ? "" : getString(R.string.share_remaining, remaining);
    }

    private static String preview(String text, int limit) {
        if (text == null) {
            return "";
        }
        String flat = text.replaceAll("\\s+", " ").trim();
        return flat.length() <= limit ? flat : flat.substring(0, limit) + "…";
    }

    private static int utf8Length(String text) {
        return text == null ? 0 : text.getBytes(Charset.forName("UTF-8")).length;
    }

    private String sizeText(long bytes) {
        if (bytes <= 0) {
            return getString(R.string.share_size_unknown);
        }
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        }
        return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
    }

    /** 扩展名 → 服务端支持的 MIME；不支持的类型返回 {@code null}。 */
    private static String mimeForExtension(String extension) {
        if (extension == null) {
            return null;
        }
        String lower = extension.toLowerCase(Locale.US);
        for (int i = 0; i < EXTENSIONS.length; i++) {
            if (EXTENSIONS[i].equals(lower)) {
                return EXTENSION_MIME[i];
            }
        }
        return null;
    }

    /** 从文件名取扩展名（小写、带点）；没有则返回空串。 */
    private static String extensionOf(String name) {
        if (name == null) {
            return "";
        }
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return "";
        }
        String extension = name.substring(dot).toLowerCase(Locale.US);
        if (extension.length() > 12 || extension.indexOf('/') >= 0 || extension.indexOf(' ') >= 0) {
            return "";
        }
        return extension;
    }

    /**
     * 确定上传用的扩展名：文件名里没有（或被改成 txt 之类）时按 MIME 推断，
     * 保证服务端能识别类型；都不认识时返回空串（调用方给出「不支持」提示）。
     */
    private static String resolveExtension(String name, String mime) {
        String fromName = extensionOf(name);
        if (mimeForExtension(fromName) != null) {
            return fromName;
        }
        if (mime != null) {
            String byMime = extensionForMime(mime);
            if (byMime != null) {
                return byMime;
            }
        }
        // 文件名带 .txt（多数应用把未知文件当纯文本分享）时按文本处理
        if (".txt".equals(fromName)) {
            return fromName;
        }
        return "";
    }

    private static String extensionForMime(String mime) {
        String lower = mime.toLowerCase(Locale.US);
        int semi = lower.indexOf(';');
        if (semi >= 0) {
            lower = lower.substring(0, semi).trim();
        }
        if ("application/pdf".equals(lower)) {
            return ".pdf";
        }
        if ("image/png".equals(lower)) {
            return ".png";
        }
        if ("image/jpeg".equals(lower) || "image/jpg".equals(lower)) {
            return ".jpg";
        }
        if ("text/plain".equals(lower)) {
            return ".txt";
        }
        if ("application/msword".equals(lower)) {
            return ".doc";
        }
        if ("application/vnd.openxmlformats-officedocument.wordprocessingml.document".equals(lower)) {
            return ".docx";
        }
        if ("application/vnd.ms-excel".equals(lower)) {
            return ".xls";
        }
        if ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".equals(lower)) {
            return ".xlsx";
        }
        if ("application/vnd.ms-powerpoint".equals(lower)) {
            return ".ppt";
        }
        if ("application/vnd.openxmlformats-officedocument.presentationml.presentation".equals(lower)) {
            return ".pptx";
        }
        return null;
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return (int) (value * density + 0.5f);
    }

    /** 屏幕上要打印的一条（文件）。 */
    private static final class Item {
        Uri uri;
        String name;
        String mime;
        String extension;
        long size = -1L;
        byte[] bytes;
    }

    /** 单次请求的结果。 */
    private static final class Result {
        final String name;
        final boolean ok;
        final String error;
        String taskId;
        JSONObject quota;

        private Result(String name, boolean ok, String error) {
            this.name = name;
            this.ok = ok;
            this.error = error;
        }

        static Result success(String name) {
            return new Result(name, true, null);
        }

        static Result failure(String name, String error) {
            return new Result(name, false, error);
        }
    }

    /** 一次「打印」点击产生的所有请求结果。 */
    private static final class UploadResult {
        final List<Result> results = new ArrayList<>();
        JSONObject lastQuota;

        void add(Result result) {
            if (result == null) {
                return;
            }
            results.add(result);
            if (result.quota != null) {
                lastQuota = result.quota;
            }
        }

        int failures() {
            int count = 0;
            for (Result result : results) {
                if (!result.ok) {
                    count++;
                }
            }
            return count;
        }
    }
}
