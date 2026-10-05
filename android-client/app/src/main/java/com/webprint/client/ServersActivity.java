package com.webprint.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * 服务器列表管理页：查看、添加（手动 / 扫码）、切换、删除服务器地址。
 *
 * <p>整个界面用 Java 代码搭建，不引入任何布局 XML，以保持资源面尽可能小。
 * 结果约定：
 * <ul>
 *   <li>{@link #RESULT_OK} —— 用户明确选了某个服务器，或调用方要求“没服务器就提示添加”；</li>
 *   <li>{@link #RESULT_CANCELED} —— 用户直接返回，调用方不需要重新加载。</li>
 * </ul>
 */
public class ServersActivity extends Activity {

    private static final int REQ_SCAN = 1001;

    private ServerStore mStore;
    private ServerAdapter mAdapter;
    private ListView mListView;
    private TextView mEmptyView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        mStore = new ServerStore(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        root.addView(buildToolbar(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView hint = new TextView(this);
        hint.setText(getString(R.string.servers_hint));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hint.setTextColor(0xFF757575);
        int pad = dp(16);
        hint.setPadding(pad, dp(8), pad, dp(8));
        root.addView(hint, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        mEmptyView = new TextView(this);
        mEmptyView.setText(getString(R.string.servers_empty));
        mEmptyView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        mEmptyView.setTextColor(0xFF9E9E9E);
        mEmptyView.setGravity(Gravity.CENTER);
        mEmptyView.setLineSpacing(dp(4), 1.0f);
        mEmptyView.setPadding(dp(32), dp(48), dp(32), dp(32));

        mListView = new ListView(this);
        mListView.setDividerHeight(1);
        mAdapter = new ServerAdapter();
        mListView.setAdapter(mAdapter);
        mListView.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override
            public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
                mStore.setActive(position);
                // 明确选择：调用方收到 RESULT_OK 后会重新加载该服务器
                setResult(RESULT_OK);
                finish();
            }
        });
        mListView.setOnItemLongClickListener(new AdapterView.OnItemLongClickListener() {
            @Override
            public boolean onItemLongClick(AdapterView<?> parent, View view, int position, long id) {
                confirmDelete(position);
                return true;
            }
        });

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.addView(mEmptyView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        body.addView(mListView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        root.addView(body, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        refresh();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    // ------------------------------------------------------------------
    // 界面搭建
    // ------------------------------------------------------------------

    private View buildToolbar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(0xFFFFFFFF);
        bar.setPadding(dp(12), dp(10), dp(12), dp(10));

        TextView title = new TextView(this);
        title.setText(getString(R.string.servers_title));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTextColor(0xFF212121);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        bar.addView(title, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button manual = makeButton(getString(R.string.add_manual));
        manual.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showAddDialog();
            }
        });
        bar.addView(manual);

        Button scan = makeButton(getString(R.string.add_scan));
        scan.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivityForResult(new Intent(ServersActivity.this, ScanActivity.class), REQ_SCAN);
            }
        });
        LinearLayout.LayoutParams scanLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        scanLp.leftMargin = dp(8);
        bar.addView(scan, scanLp);

        return bar;
    }

    private Button makeButton(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        return button;
    }

    private void refresh() {
        mAdapter.reload();
        boolean empty = mAdapter.getCount() == 0;
        mEmptyView.setVisibility(empty ? View.VISIBLE : View.GONE);
        mListView.setVisibility(empty ? View.GONE : View.VISIBLE);
    }

    // ------------------------------------------------------------------
    // 添加 / 删除
    // ------------------------------------------------------------------

    private void showAddDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, dp(8), pad, 0);

        final EditText urlInput = new EditText(this);
        urlInput.setHint(getString(R.string.dialog_add_url_hint));
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setSingleLine(true);
        urlInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        box.addView(label(getString(R.string.dialog_add_url)));
        box.addView(urlInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final EditText nameInput = new EditText(this);
        nameInput.setHint(getString(R.string.dialog_add_name_hint));
        nameInput.setInputType(InputType.TYPE_CLASS_TEXT);
        nameInput.setSingleLine(true);
        nameInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        LinearLayout.LayoutParams nameLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nameLp.topMargin = dp(12);
        box.addView(label(getString(R.string.dialog_add_name)), nameLp);

        LinearLayout nameWrap = new LinearLayout(this);
        nameWrap.setOrientation(LinearLayout.VERTICAL);
        nameWrap.addView(nameInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        box.addView(nameWrap);

        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(getString(R.string.dialog_add_title))
                .setView(box)
                .setPositiveButton(getString(R.string.ok), null)
                .setNegativeButton(getString(R.string.cancel), null)
                .create();

        dialog.setOnShowListener(new DialogInterface.OnShowListener() {
            @Override
            public void onShow(DialogInterface d) {
                if (dialog.getWindow() != null) {
                    // 弹出键盘，方便直接输入 IP
                    dialog.getWindow().setSoftInputMode(
                            WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
                }
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(
                        new View.OnClickListener() {
                            @Override
                            public void onClick(View v) {
                                String raw = urlInput.getText().toString();
                                String name = nameInput.getText().toString().trim();
                                String normalized = ServerStore.normalizeUrl(raw);
                                if (normalized == null) {
                                    // 区分“空”与“格式错”，给出更准确的中文提示
                                    String message;
                                    if (TextUtils.isEmpty(raw.trim())) {
                                        message = getString(R.string.err_url_empty);
                                    } else if (!raw.toLowerCase(java.util.Locale.US).contains("://")
                                            && !raw.contains(".") && !raw.contains(":")) {
                                        message = getString(R.string.err_url_host);
                                    } else if (raw.contains("://")
                                            && !raw.toLowerCase(java.util.Locale.US)
                                                    .startsWith("http://")
                                            && !raw.toLowerCase(java.util.Locale.US)
                                                    .startsWith("https://")) {
                                        message = getString(R.string.err_url_scheme);
                                    } else {
                                        message = getString(R.string.err_url_invalid);
                                    }
                                    Toast.makeText(ServersActivity.this, message, Toast.LENGTH_LONG).show();
                                    return;
                                }
                                if (mStore.contains(normalized)) {
                                    Toast.makeText(ServersActivity.this, R.string.err_duplicate,
                                            Toast.LENGTH_LONG).show();
                                    return;
                                }
                                mStore.add(normalized, name);
                                refresh();
                                dialog.dismiss();
                            }
                        });
            }
        });
        dialog.show();
    }

    private TextView label(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        tv.setTextColor(0xFF616161);
        tv.setPadding(0, dp(6), 0, 0);
        return tv;
    }

    private void confirmDelete(final int position) {
        if (position < 0 || position >= mAdapter.getCount()) {
            return;
        }
        final ServerStore.Server server = mAdapter.getItem(position);
        String shown = server.displayName(getString(R.string.server_unnamed));
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.dialog_delete_title))
                .setMessage(getString(R.string.dialog_delete_message, shown + "\n" + server.url))
                .setPositiveButton(getString(R.string.delete), new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        mStore.remove(position);
                        refresh();
                        Toast.makeText(ServersActivity.this, R.string.toast_deleted,
                                Toast.LENGTH_SHORT).show();
                    }
                })
                .setNegativeButton(getString(R.string.cancel), null)
                .show();
    }

    // ------------------------------------------------------------------
    // 扫码结果
    // ------------------------------------------------------------------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_SCAN) {
            return;
        }
        if (resultCode != RESULT_OK || data == null) {
            return;
        }
        String payload = data.getStringExtra(ScanActivity.EXTRA_SCAN_RESULT);
        String normalized = ServerStore.normalizeUrl(payload);
        if (normalized == null) {
            // ScanActivity 已经过滤过非 URL 结果，这里只是二次兜底
            Toast.makeText(this, R.string.err_url_invalid, Toast.LENGTH_LONG).show();
            return;
        }
        if (mStore.contains(normalized)) {
            Toast.makeText(this, R.string.err_duplicate, Toast.LENGTH_LONG).show();
            return;
        }
        try {
            mStore.add(normalized, "");
        } catch (IllegalArgumentException e) {
            Toast.makeText(this, R.string.err_url_invalid, Toast.LENGTH_LONG).show();
            return;
        }
        refresh();
        Toast.makeText(this, getString(R.string.scan_added, normalized), Toast.LENGTH_SHORT).show();
    }

    // ------------------------------------------------------------------
    // 列表适配器
    // ------------------------------------------------------------------

    private final class ServerAdapter extends BaseAdapter {

        private final List<ServerStore.Server> mItems = new ArrayList<>();

        void reload() {
            mItems.clear();
            mItems.addAll(mStore.list());
            notifyDataSetChanged();
        }

        @Override
        public int getCount() {
            return mItems.size();
        }

        @Override
        public ServerStore.Server getItem(int position) {
            return mItems.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            LinearLayout row;
            if (convertView instanceof LinearLayout) {
                row = (LinearLayout) convertView;
            } else {
                row = new LinearLayout(ServersActivity.this);
                row.setOrientation(LinearLayout.VERTICAL);
                int pad = dp(16);
                row.setPadding(pad, dp(12), pad, dp(12));

                TextView name = new TextView(ServersActivity.this);
                name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
                name.setTypeface(Typeface.DEFAULT_BOLD);
                name.setTag("name");
                row.addView(name);

                TextView url = new TextView(ServersActivity.this);
                url.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
                url.setTextColor(0xFF757575);
                url.setPadding(0, dp(2), 0, 0);
                url.setTag("url");
                row.addView(url);
            }

            ServerStore.Server server = getItem(position);
            boolean active = position == mStore.getActiveIndex();
            row.setBackgroundDrawable(rowBackground(active));

            TextView nameView = (TextView) row.findViewWithTag("name");
            TextView urlView = (TextView) row.findViewWithTag("url");

            String title = server.displayName(getString(R.string.server_unnamed));
            if (active) {
                title = title + "  ·  " + getString(R.string.server_active_mark);
            }
            nameView.setText(title);
            nameView.setTextColor(active ? 0xFF1A73E8 : 0xFF212121);
            urlView.setText(server.url);
            return row;
        }
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return (int) (value * density + 0.5f);
    }

    /** 行背景：按压时高亮；当前服务器用淡蓝色底以示区分。 */
    private static Drawable rowBackground(boolean active) {
        int normal = active ? 0xFFE8F0FE : 0xFFFFFFFF;
        StateListDrawable drawable = new StateListDrawable();
        drawable.addState(new int[] {android.R.attr.state_pressed}, new ColorDrawable(0xFFDDDDDD));
        drawable.addState(new int[0], new ColorDrawable(normal));
        return drawable;
    }

    /** 返回键与标题栏行为一致：结束本页，不改变当前服务器。 */
    @Override
    public void onBackPressed() {
        setResult(RESULT_CANCELED);
        finish();
    }
}
