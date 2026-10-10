package com.webprint.client;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
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
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
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
    /** PDF 预览最多渲染的页数（控制内存占用）。 */
    private static final int MAX_PREVIEW_PAGES = 20;
    /** PDF 缩略图位图宽度（像素）。 */
    private static final int PREVIEW_THUMB_WIDTH = 240;
    /** 图片转 PDF 时解码的最长边像素上限（控制内存并保证打印清晰度）。 */
    private static final int MAX_IMAGE_SIDE = 3000;
    /** 单页 PDF 的纸张尺寸（point，1pt = 1/72 inch）：A4。与 buildMultipart 的 paperSize 一致。 */
    private static final int PDF_PAGE_WIDTH = 595;
    private static final int PDF_PAGE_HEIGHT = 842;
    /** 图片转 PDF 时的页边距（point）。 */
    private static final int PDF_PAGE_MARGIN = 24;

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
    private RadioGroup mOrientationGroup;
    private Button mPrintButton;
    private Button mCancelButton;
    private ProgressBar mProgress;
    private TextView mResultView;

    // 预览与页码
    private LinearLayout mPreviewCard;
    private TextView mPreviewInfo;
    private HorizontalScrollView mThumbScroll;
    private LinearLayout mThumbStrip;
    private LinearLayout mPagesPanel;
    private EditText mPageFromInput;
    private EditText mPageToInput;
    private TextView mPageSelectedView;
    private final List<View> mThumbCells = new ArrayList<>();
    /** PDF 页数；0 表示未知（非 PDF 或尚未解析）。 */
    private int mPageCount;
    /** 是否显示页码输入（单个文件且可能多页时）。 */
    private boolean mPagesEnabled;
    /** 缩略图选择锚点：-1 表示等下一次点按作为起始页。 */
    private int mAnchor = -1;
    /** 预览渲染线程与“失效令牌”，重新选择文件后旧任务的结果会被丢弃。 */
    private ExecutorService mPreviewExecutor;
    private long mPreviewToken;
    private File mPreviewPdf;

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
        mPreviewExecutor = Executors.newSingleThreadExecutor();

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
        if (mPreviewExecutor != null) {
            mPreviewToken++;
            mPreviewExecutor.shutdownNow();
            mPreviewExecutor = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------
    // 界面
    // ------------------------------------------------------------------

    private View buildContentView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Ui.BG);

        int side = dp(16);

        // ---- 标题栏 ----
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setBackgroundColor(Ui.CARD);
        header.setPadding(side, dp(16), side, dp(14));

        TextView title = new TextView(this);
        title.setText(getString(R.string.share_title));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTextColor(Ui.TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        header.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText(getString(R.string.share_summary_title));
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        subtitle.setTextColor(Ui.TEXT_FAINT);
        subtitle.setPadding(0, dp(2), 0, 0);
        header.addView(subtitle);
        root.addView(header, matchWidth());

        // ---- 可滚动内容区 ----
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(side, dp(12), side, dp(12));

        // 即将打印
        LinearLayout summaryCard = Ui.card(this);
        summaryCard.addView(Ui.sectionTitle(this, getString(R.string.share_summary_title)));
        mSummaryView = new TextView(this);
        mSummaryView.setId(R.id.share_summary_text);
        mSummaryView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        mSummaryView.setTextColor(Ui.TEXT);
        mSummaryView.setLineSpacing(dp(3), 1f);
        mSummaryView.setTextIsSelectable(true);
        LinearLayout.LayoutParams summaryLp = matchWidth();
        summaryLp.topMargin = dp(6);
        summaryCard.addView(mSummaryView, summaryLp);

        mInfoView = new TextView(this);
        mInfoView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mInfoView.setTextColor(Ui.DANGER);
        mInfoView.setLineSpacing(dp(2), 1f);
        mInfoView.setVisibility(View.GONE);
        LinearLayout.LayoutParams infoLp = matchWidth();
        infoLp.topMargin = dp(8);
        summaryCard.addView(mInfoView, infoLp);
        content.addView(summaryCard, Ui.cardParams(this));

        // 预览（PDF / 图片，单个文件时才显示）
        mPreviewCard = Ui.card(this);
        mPreviewCard.setVisibility(View.GONE);
        mPreviewCard.addView(Ui.sectionTitle(this, getString(R.string.share_preview_title)));

        mPreviewInfo = new TextView(this);
        mPreviewInfo.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mPreviewInfo.setTextColor(Ui.TEXT_MUTED);
        mPreviewInfo.setLineSpacing(dp(2), 1f);
        mPreviewInfo.setPadding(0, dp(6), 0, 0);
        mPreviewCard.addView(mPreviewInfo, matchWidth());

        mThumbScroll = new HorizontalScrollView(this);
        mThumbScroll.setId(R.id.share_preview_scroll);
        mThumbScroll.setHorizontalScrollBarEnabled(false);
        mThumbStrip = new LinearLayout(this);
        mThumbStrip.setOrientation(LinearLayout.HORIZONTAL);
        mThumbScroll.addView(mThumbStrip, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout.LayoutParams thumbLp = matchWidth();
        thumbLp.topMargin = dp(10);
        mThumbScroll.setVisibility(View.GONE);
        mPreviewCard.addView(mThumbScroll, thumbLp);
        content.addView(mPreviewCard, Ui.cardParams(this));

        // 无服务器提示
        mNoServerPanel = Ui.card(this);
        mNoServerPanel.setVisibility(View.GONE);
        TextView noServer = new TextView(this);
        noServer.setText(getString(R.string.share_no_server));
        noServer.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        noServer.setTextColor(Ui.TEXT_MUTED);
        noServer.setLineSpacing(dp(3), 1f);
        mNoServerPanel.addView(noServer, matchWidth());
        Button openServers = Ui.ghostButton(this, getString(R.string.share_open_servers));
        openServers.setId(R.id.share_open_servers_button);
        openServers.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openServers();
            }
        });
        LinearLayout.LayoutParams openLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        openLp.topMargin = dp(12);
        mNoServerPanel.addView(openServers, openLp);
        content.addView(mNoServerPanel, Ui.cardParams(this));

        // 打印选项：服务器 + 页码 + 份数
        mFormPanel = Ui.card(this);
        mFormPanel.addView(Ui.sectionTitle(this, getString(R.string.share_server_label)));

        // 只有一个服务器时不显示下拉框，直接显示地址（下拉框保持 GONE 占位）
        mServerUrlView = new TextView(this);
        mServerUrlView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mServerUrlView.setTextColor(Ui.PRIMARY);
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
        LinearLayout.LayoutParams spinnerLp = matchWidth();
        spinnerLp.topMargin = dp(4);
        mFormPanel.addView(mServerSpinner, spinnerLp);

        // 页码
        mPagesPanel = new LinearLayout(this);
        mPagesPanel.setOrientation(LinearLayout.VERTICAL);
        mPagesPanel.setVisibility(View.GONE);
        mPagesPanel.addView(Ui.fieldLabel(this, getString(R.string.share_pages_label)));

        LinearLayout rangeRow = new LinearLayout(this);
        rangeRow.setOrientation(LinearLayout.HORIZONTAL);
        rangeRow.setGravity(Gravity.CENTER_VERTICAL);

        mPageFromInput = numberInput(R.id.share_page_from_input,
                getString(R.string.share_page_from_hint));
        rangeRow.addView(mPageFromInput, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView sep = new TextView(this);
        sep.setText(getString(R.string.share_page_to_sep));
        sep.setTextColor(Ui.TEXT_MUTED);
        sep.setPadding(dp(8), 0, dp(8), 0);
        rangeRow.addView(sep);

        mPageToInput = numberInput(R.id.share_page_to_input,
                getString(R.string.share_page_to_hint));
        rangeRow.addView(mPageToInput, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button allPages = Ui.ghostButton(this, getString(R.string.share_pages_all));
        allPages.setId(R.id.share_pages_all_button);
        allPages.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                clearPageRange();
            }
        });
        LinearLayout.LayoutParams allLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        allLp.leftMargin = dp(8);
        rangeRow.addView(allPages, allLp);

        mPagesPanel.addView(rangeRow, matchWidth());

        mPageSelectedView = new TextView(this);
        mPageSelectedView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mPageSelectedView.setTextColor(Ui.PRIMARY);
        mPageSelectedView.setPadding(0, dp(6), 0, 0);
        mPagesPanel.addView(mPageSelectedView, matchWidth());
        mFormPanel.addView(mPagesPanel, matchWidth());

        // 份数
        mFormPanel.addView(Ui.fieldLabel(this, getString(R.string.share_copies_label)));
        mCopiesInput = new EditText(this);
        mCopiesInput.setId(R.id.share_copies_input);
        mCopiesInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        mCopiesInput.setFilters(new InputFilter[] {new InputFilter.LengthFilter(2)});
        mCopiesInput.setSingleLine(true);
        mCopiesInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        mCopiesInput.setText("1");
        mCopiesInput.setSelection(mCopiesInput.getText().length());
        mFormPanel.addView(mCopiesInput, matchWidth());

        // 方向：纵向 / 横向（横向适合横拍照片、横向文档，可获得更大的打印效果）
        mFormPanel.addView(Ui.fieldLabel(this, getString(R.string.share_orientation_label)));
        mOrientationGroup = new RadioGroup(this);
        mOrientationGroup.setId(R.id.share_orientation_group);
        mOrientationGroup.setOrientation(RadioGroup.HORIZONTAL);

        RadioButton portrait = new RadioButton(this);
        portrait.setId(R.id.share_orientation_portrait);
        portrait.setText(getString(R.string.share_orientation_portrait));
        portrait.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        portrait.setTextColor(Ui.TEXT);
        mOrientationGroup.addView(portrait);

        RadioButton landscape = new RadioButton(this);
        landscape.setId(R.id.share_orientation_landscape);
        landscape.setText(getString(R.string.share_orientation_landscape));
        landscape.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        landscape.setTextColor(Ui.TEXT);
        mOrientationGroup.addView(landscape);

        mOrientationGroup.check(R.id.share_orientation_portrait);
        mFormPanel.addView(mOrientationGroup, matchWidth());

        TextView orientationHint = new TextView(this);
        orientationHint.setText(getString(R.string.share_orientation_hint));
        orientationHint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        orientationHint.setTextColor(Ui.TEXT_FAINT);
        orientationHint.setPadding(0, dp(2), 0, 0);
        mFormPanel.addView(orientationHint, matchWidth());

        content.addView(mFormPanel, Ui.cardParams(this));

        // ---- 结果区 ----
        mProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
        mProgress.setVisibility(View.GONE);
        LinearLayout.LayoutParams progressLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        progressLp.topMargin = dp(4);
        progressLp.leftMargin = dp(4);
        content.addView(mProgress, progressLp);

        mResultView = new TextView(this);
        mResultView.setId(R.id.share_result_text);
        mResultView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mResultView.setTextColor(Ui.TEXT_MUTED);
        mResultView.setLineSpacing(dp(3), 1f);
        mResultView.setTextIsSelectable(true);
        LinearLayout.LayoutParams resultLp = matchWidth();
        resultLp.topMargin = dp(8);
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
        buttons.setBackgroundColor(Ui.CARD);
        buttons.setPadding(side, dp(10), side, dp(10));

        mCancelButton = Ui.ghostButton(this, getString(R.string.share_cancel));
        mCancelButton.setId(R.id.share_cancel_button);
        mCancelButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                finish();
            }
        });
        buttons.addView(mCancelButton);

        mPrintButton = Ui.primaryButton(this, getString(R.string.share_print));
        mPrintButton.setId(R.id.share_print_button);
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

    private EditText numberInput(int id, String hint) {
        EditText input = new EditText(this);
        input.setId(id);
        input.setHint(hint);
        input.setInputType(InputType.TYPE_CLASS_NUMBER);
        input.setFilters(new InputFilter[] {new InputFilter.LengthFilter(4)});
        input.setSingleLine(true);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        return input;
    }

    private LinearLayout.LayoutParams matchWidth() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    /** 上传过程中禁用/恢复方向选择（RadioGroup 不会自动级联到子项）。 */
    private void setOrientationEnabled(boolean enabled) {
        if (mOrientationGroup == null) {
            return;
        }
        mOrientationGroup.setEnabled(enabled);
        for (int i = 0; i < mOrientationGroup.getChildCount(); i++) {
            mOrientationGroup.getChildAt(i).setEnabled(enabled);
        }
    }

    // ------------------------------------------------------------------
    // 预览与页码
    // ------------------------------------------------------------------

    /** 根据当前条目准备预览：单个文件时显示；PDF 渲染缩略图，图片直接显示。 */
    private void preparePreview() {
        resetPreviewState();
        if (mTextMode || mItems.size() != 1) {
            mPreviewCard.setVisibility(View.GONE);
            return;
        }
        Item item = mItems.get(0);
        String ext = item.extension != null ? item.extension
                : resolveExtension(item.name, item.mime);
        if (".pdf".equals(ext)) {
            mPreviewCard.setVisibility(View.VISIBLE);
            mPagesEnabled = true;
            mPagesPanel.setVisibility(View.VISIBLE);
            renderPdfPreview(item);
        } else if (isImageExtension(ext)) {
            mPreviewCard.setVisibility(View.VISIBLE);
            mPagesEnabled = false;
            mPagesPanel.setVisibility(View.GONE);
            renderImagePreview(item);
        } else {
            // Office / 文本：无法直接预览，但页码仍可手填（服务端转换后生效）
            mPreviewCard.setVisibility(View.VISIBLE);
            mPreviewInfo.setText(getString(R.string.share_preview_unavailable));
            mThumbScroll.setVisibility(View.GONE);
            mPagesEnabled = true;
            mPagesPanel.setVisibility(View.VISIBLE);
        }
    }

    private void resetPreviewState() {
        mPreviewToken++;
        mPageCount = 0;
        mPagesEnabled = false;
        mAnchor = -1;
        mThumbCells.clear();
        if (mThumbStrip != null) {
            mThumbStrip.removeAllViews();
        }
        if (mThumbScroll != null) {
            mThumbScroll.setVisibility(View.GONE);
        }
        if (mPreviewInfo != null) {
            mPreviewInfo.setText("");
        }
        if (mPageFromInput != null) {
            mPageFromInput.setText("");
        }
        if (mPageToInput != null) {
            mPageToInput.setText("");
        }
        if (mPageSelectedView != null) {
            mPageSelectedView.setText("");
        }
        if (mPagesPanel != null) {
            mPagesPanel.setVisibility(View.GONE);
        }
    }

    private void renderPdfPreview(final Item item) {
        final long token = mPreviewToken;
        mPreviewInfo.setText(getString(R.string.share_preview_loading));
        mThumbScroll.setVisibility(View.GONE);
        if (mPreviewExecutor == null) {
            return;
        }
        mPreviewExecutor.execute(new Runnable() {
            @Override
            public void run() {
                ParcelFileDescriptor pfd = null;
                PdfRenderer renderer = null;
                final List<Bitmap> bitmaps = new ArrayList<>();
                int pageCount = 0;
                try {
                    File file = new File(getCacheDir(), "preview.pdf");
                    FileOutputStream fos = new FileOutputStream(file);
                    try {
                        fos.write(item.bytes);
                        fos.flush();
                    } finally {
                        fos.close();
                    }
                    mPreviewPdf = file;
                    pfd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
                    renderer = new PdfRenderer(pfd);
                    pageCount = renderer.getPageCount();
                    int limit = Math.min(pageCount, MAX_PREVIEW_PAGES);
                    for (int i = 0; i < limit; i++) {
                        PdfRenderer.Page page = renderer.openPage(i);
                        int width = PREVIEW_THUMB_WIDTH;
                        int height = Math.max(1,
                                (int) ((float) page.getHeight() / page.getWidth() * width));
                        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                        bitmap.eraseColor(Color.WHITE);
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                        page.close();
                        bitmaps.add(bitmap);
                    }
                } catch (Throwable e) {
                    bitmaps.clear();
                } finally {
                    if (renderer != null) {
                        try {
                            renderer.close();
                        } catch (Exception ignored) {
                            // 忽略
                        }
                    }
                    if (pfd != null) {
                        try {
                            pfd.close();
                        } catch (Exception ignored) {
                            // 忽略
                        }
                    }
                }
                final int count = pageCount;
                final List<Bitmap> result = bitmaps;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (token != mPreviewToken) {
                            return;
                        }
                        mPageCount = count;
                        if (count <= 0 || result.isEmpty()) {
                            mPreviewInfo.setText(getString(R.string.share_preview_unavailable));
                            return;
                        }
                        mThumbStrip.removeAllViews();
                        mThumbCells.clear();
                        for (int i = 0; i < result.size(); i++) {
                            addThumb(result.get(i), i);
                        }
                        mThumbScroll.setVisibility(View.VISIBLE);
                        String text = getString(R.string.share_preview_pages, count);
                        if (count > result.size()) {
                            text = text + "\n" + getString(R.string.share_preview_more, result.size());
                        } else {
                            text = text + "\n" + getString(R.string.share_preview_select_hint);
                        }
                        mPreviewInfo.setText(text);
                    }
                });
            }
        });
    }

    private void renderImagePreview(final Item item) {
        final long token = mPreviewToken;
        mPreviewInfo.setText(getString(R.string.share_preview_loading));
        mThumbScroll.setVisibility(View.GONE);
        final int target = dp(180);
        if (mPreviewExecutor == null) {
            return;
        }
        mPreviewExecutor.execute(new Runnable() {
            @Override
            public void run() {
                Bitmap bitmap = null;
                try {
                    BitmapFactory.Options bounds = new BitmapFactory.Options();
                    bounds.inJustDecodeBounds = true;
                    BitmapFactory.decodeByteArray(item.bytes, 0, item.bytes.length, bounds);
                    int sample = 1;
                    while (bounds.outWidth / (sample * 2) >= target
                            && bounds.outHeight / (sample * 2) >= target) {
                        sample *= 2;
                    }
                    BitmapFactory.Options decode = new BitmapFactory.Options();
                    decode.inSampleSize = sample;
                    bitmap = BitmapFactory.decodeByteArray(item.bytes, 0, item.bytes.length, decode);
                } catch (Throwable ignored) {
                    // 无法解码时退化为通用提示
                }
                final Bitmap result = bitmap;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (token != mPreviewToken) {
                            return;
                        }
                        mPageCount = 1;
                        if (result == null) {
                            mPreviewInfo.setText(getString(R.string.share_preview_unavailable));
                            mThumbScroll.setVisibility(View.GONE);
                            return;
                        }
                        mPreviewInfo.setText(getString(R.string.share_preview_pages, 1));
                        mThumbStrip.removeAllViews();
                        mThumbCells.clear();
                        ImageView view = new ImageView(ShareActivity.this);
                        view.setImageBitmap(result);
                        view.setAdjustViewBounds(true);
                        view.setScaleType(ImageView.ScaleType.FIT_CENTER);
                        mThumbStrip.addView(view, new LinearLayout.LayoutParams(
                                dp(180), ViewGroup.LayoutParams.WRAP_CONTENT));
                        mThumbScroll.setVisibility(View.VISIBLE);
                    }
                });
            }
        });
    }

    private void addThumb(Bitmap bitmap, final int index) {
        LinearLayout cell = new LinearLayout(this);
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setGravity(Gravity.CENTER_HORIZONTAL);
        cell.setPadding(dp(4), dp(4), dp(4), dp(4));
        cell.setBackground(Ui.outline(this, Ui.CARD, Ui.DIVIDER, 8));

        ImageView image = new ImageView(this);
        image.setImageBitmap(bitmap);
        image.setAdjustViewBounds(true);
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        cell.addView(image, new LinearLayout.LayoutParams(
                dp(96), ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView number = new TextView(this);
        number.setText(String.valueOf(index + 1));
        number.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        number.setTextColor(Ui.TEXT_MUTED);
        number.setPadding(0, dp(4), 0, 0);
        cell.addView(number);

        final int page = index + 1;
        cell.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onThumbClicked(page);
            }
        });

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(8);
        mThumbStrip.addView(cell, lp);
        mThumbCells.add(cell);
    }

    /** 点按缩略图：第一次选起始页，第二次选结束页。 */
    private void onThumbClicked(int page) {
        if (mAnchor < 0) {
            mAnchor = page;
            setPageRange(page, page);
        } else {
            setPageRange(Math.min(mAnchor, page), Math.max(mAnchor, page));
            mAnchor = -1;
        }
    }

    private void setPageRange(int from, int to) {
        mPageFromInput.setText(String.valueOf(from));
        mPageToInput.setText(String.valueOf(to));
        updatePageSelection();
    }

    private void clearPageRange() {
        mAnchor = -1;
        mPageFromInput.setText("");
        mPageToInput.setText("");
        mPageSelectedView.setText("");
        updateThumbHighlight(-1, -1);
    }

    private void updatePageSelection() {
        String fromRaw = mPageFromInput.getText().toString().trim();
        String toRaw = mPageToInput.getText().toString().trim();
        int from = fromRaw.isEmpty() ? -1 : parseSafeInt(fromRaw);
        int to = toRaw.isEmpty() ? -1 : parseSafeInt(toRaw);
        if (from < 0 && to < 0) {
            mPageSelectedView.setText("");
            updateThumbHighlight(-1, -1);
            return;
        }
        if (from < 0) {
            from = 1;
        }
        if (to < 0) {
            to = from;
        }
        int lo = Math.min(from, to);
        int hi = Math.max(from, to);
        String label = lo == hi ? String.valueOf(lo) : lo + "-" + hi;
        mPageSelectedView.setText(getString(R.string.share_pages_selected, label));
        updateThumbHighlight(lo, hi);
    }

    private void updateThumbHighlight(int from, int to) {
        for (int i = 0; i < mThumbCells.size(); i++) {
            int page = i + 1;
            boolean selected = from > 0 && page >= from && page <= to;
            mThumbCells.get(i).setBackground(selected
                    ? Ui.outline(this, Ui.PRIMARY_SOFT, Ui.PRIMARY, 8)
                    : Ui.outline(this, Ui.CARD, Ui.DIVIDER, 8));
        }
    }

    /**
     * 读取页码输入并生成服务端 {@code pages} 字段。
     *
     * @return 空串表示全部页；{@code null} 表示输入非法（已给出提示）
     */
    private String parsePageRange(boolean showError) {
        String fromRaw = mPageFromInput.getText().toString().trim();
        String toRaw = mPageToInput.getText().toString().trim();
        if (fromRaw.isEmpty() && toRaw.isEmpty()) {
            return "";
        }
        int from = fromRaw.isEmpty() ? 0 : parseSafeInt(fromRaw);
        int to = toRaw.isEmpty() ? 0 : parseSafeInt(toRaw);
        boolean badFormat = (!fromRaw.isEmpty() && from < 1) || (!toRaw.isEmpty() && to < 1);
        if (badFormat) {
            if (showError) {
                Toast.makeText(this, getString(R.string.share_err_pages_format, Math.max(mPageCount, 1)),
                        Toast.LENGTH_LONG).show();
            }
            return null;
        }
        if (mPageCount > 0 && (from > mPageCount || to > mPageCount)) {
            if (showError) {
                Toast.makeText(this, getString(R.string.share_err_pages_range, mPageCount),
                        Toast.LENGTH_LONG).show();
            }
            return null;
        }
        if (from > 0 && to > 0) {
            return Math.min(from, to) + "-" + Math.max(from, to);
        }
        if (from > 0) {
            return String.valueOf(from);
        }
        return "1-" + to;
    }

    private static int parseSafeInt(String value) {
        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static boolean isImageExtension(String extension) {
        return ".png".equals(extension) || ".jpg".equals(extension) || ".jpeg".equals(extension);
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
        preparePreview();

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

        // 页码范围：仅单个文件时生效（批量文件各页数不同，统一按全部页处理）
        String pages = "";
        if (!mTextMode && mItems.size() == 1 && mPagesEnabled) {
            pages = parsePageRange(true);
            if (pages == null) {
                return; // parsePageRange 已经给出提示
            }
        }

        String base = ServerStore.normalizeUrl(selectedServerUrl());
        if (base == null) {
            // ServerStore 只保存 https 地址，这里只是兜底（不放开 HTTPS-only 策略）
            setResultLine(prefixErr(getString(R.string.share_err_insecure_url)), true);
            return;
        }

        // 打印方向：纵向 / 横向（工作线程不能访问控件，这里先取好）
        String orientation = (mOrientationGroup != null
                && mOrientationGroup.getCheckedRadioButtonId() == R.id.share_orientation_landscape)
                ? "landscape" : "portrait";

        beginUpload(base, copies, pages, orientation, queue, problems);
    }

    private void beginUpload(final String baseUrl, final int copies, final String pages,
            final String orientation, final List<Item> queue, final List<String> problems) {
        mUploading = true;
        mPrintButton.setEnabled(false);
        mCopiesInput.setEnabled(false);
        mServerSpinner.setEnabled(false);
        mPageFromInput.setEnabled(false);
        mPageToInput.setEnabled(false);
        setOrientationEnabled(false);
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
                            result.add(submitFile(baseUrl, cookie, copies, pages, orientation, item));
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
        mPageFromInput.setEnabled(true);
        mPageToInput.setEnabled(true);
        setOrientationEnabled(true);

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

    /**
     * 判断条目是否为图片（PNG / JPG），这类文件需要先在本机转成 PDF。
     */
    private static boolean isImageItem(Item item) {
        if (item == null) {
            return false;
        }
        String extension = item.extension != null ? item.extension : resolveExtension(item.name, item.mime);
        if (TextUtils.isEmpty(extension)) {
            extension = extensionForMime(item.mime == null ? "" : item.mime);
        }
        return isImageExtension(extension);
    }

    /**
     * 图片 → 单页 PDF：用系统 {@link PdfDocument} 把图片按比例居中画到 A4 页面。
     * 返回一个新的 {@link Item}，除文件名/扩展名/MIME 改为 PDF 外，其余沿用原条目。
     */
    private Item toPdfItem(Item item, String orientation) throws IOException {
        Bitmap bitmap = decodeScaledBitmap(item.bytes, MAX_IMAGE_SIDE);
        if (bitmap == null) {
            throw new IOException("decode failed");
        }
        try {
            byte[] pdf = imageToPdf(bitmap, orientation);
            Item out = new Item();
            out.uri = item.uri;
            out.name = replaceExtension(item.name, ".pdf");
            out.mime = "application/pdf";
            out.extension = ".pdf";
            out.bytes = pdf;
            out.size = pdf.length;
            return out;
        } finally {
            bitmap.recycle();
        }
    }

    /** 按最长边上限解码图片（inSampleSize 降采样），避免大图占用过多内存。 */
    private static Bitmap decodeScaledBitmap(byte[] data, int maxSide) {
        if (data == null || data.length == 0) {
            return null;
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            return null;
        }
        int sample = 1;
        int longest = Math.max(bounds.outWidth, bounds.outHeight);
        while (longest / sample > maxSide) {
            sample *= 2;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sample;
        return BitmapFactory.decodeByteArray(data, 0, data.length, options);
    }

    /** 把一张位图按比例居中绘制到 A4 单页 PDF（可横/竖），返回 PDF 字节。 */
    private static byte[] imageToPdf(Bitmap bitmap, String orientation) throws IOException {
        boolean landscape = "landscape".equals(orientation);
        int pageWidth = landscape ? PDF_PAGE_HEIGHT : PDF_PAGE_WIDTH;
        int pageHeight = landscape ? PDF_PAGE_WIDTH : PDF_PAGE_HEIGHT;
        PdfDocument document = new PdfDocument();
        try {
            PdfDocument.PageInfo info = new PdfDocument.PageInfo.Builder(
                    pageWidth, pageHeight, 1).create();
            PdfDocument.Page page = document.startPage(info);
            Canvas canvas = page.getCanvas();
            canvas.drawColor(Color.WHITE);

            float availableWidth = pageWidth - PDF_PAGE_MARGIN * 2f;
            float availableHeight = pageHeight - PDF_PAGE_MARGIN * 2f;
            float scale = Math.min(availableWidth / bitmap.getWidth(),
                    availableHeight / bitmap.getHeight());
            float drawWidth = bitmap.getWidth() * scale;
            float drawHeight = bitmap.getHeight() * scale;
            float left = (pageWidth - drawWidth) / 2f;
            float top = (pageHeight - drawHeight) / 2f;
            RectF dst = new RectF(left, top, left + drawWidth, top + drawHeight);
            Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG);
            canvas.drawBitmap(bitmap, null, dst, paint);

            document.finishPage(page);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            document.writeTo(out);
            return out.toByteArray();
        } finally {
            document.close();
        }
    }

    /** 把文件名的扩展名替换为新的扩展名（如 photo.jpg → photo.pdf）。 */
    private static String replaceExtension(String name, String newExtension) {
        String base = name == null ? "" : name;
        int dot = base.lastIndexOf('.');
        if (dot > 0) {
            base = base.substring(0, dot);
        }
        if (TextUtils.isEmpty(base)) {
            base = "image";
        }
        return base + newExtension;
    }

    private Result submitFile(String baseUrl, String cookie, int copies, String pages,
            String orientation, Item item) {
        Item upload = item;
        // 图片在客户端转成单页 PDF 再上传：打印主机用 Office/WPS 转图片不稳定，
        // 转成 PDF 后服务端只需处理 PDF，链路更可靠。方向决定 PDF 页面是横版还是竖版。
        if (isImageItem(item)) {
            try {
                upload = toPdfItem(item, orientation);
            } catch (Throwable t) {
                String message = TextUtils.isEmpty(t.getMessage())
                        ? t.getClass().getSimpleName() : t.getMessage();
                return Result.failure(item.name, getString(R.string.share_err_convert, message));
            }
        }
        HttpURLConnection conn = null;
        try {
            MultipartBody body = buildMultipart(upload, copies, pages, orientation);
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
     * {@code color}（固定 mono）/ {@code paperSize}（固定 A4）/
     * {@code orientation}（portrait / landscape）/ {@code printer}（空 = 默认打印机）。
     * 文件部分不带 {@code Content-Type}，由服务端按扩展名与文件头校验。
     *
     * <p>先算出总长度再一次性写出，目的是能给出准确的 {@code Content-Length}
     * （服务端 multer 也能据此拒绝超大请求）。
     */
    private MultipartBody buildMultipart(Item item, int copies, String pages, String orientation) {
        String boundary = "----WebPrintAndroid"
                + Long.toHexString(System.currentTimeMillis())
                + Long.toHexString(Double.doubleToLongBits(Math.random()));
        Charset utf8 = Charset.forName("UTF-8");
        String pageValue = pages == null ? "" : pages;
        String orientationValue = "landscape".equals(orientation) ? "landscape" : "portrait";

        ByteArrayOutputStream head = new ByteArrayOutputStream();
        try {
            for (String[] field : new String[][] {
                    {"copies", String.valueOf(copies)},
                    {"pages", pageValue},
                    {"color", "mono"},
                    {"paperSize", "A4"},
                    {"orientation", orientationValue},
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
