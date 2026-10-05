package com.webprint.client;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.util.TypedValue;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 统一的视觉规范与轻量控件工厂。
 *
 * <p>本客户端不引入 AndroidX / Material，界面全部用框架控件在 Java 里搭建。
 * 为了避免各页面各写一套颜色与圆角，这里集中定义主色、灰阶、圆角卡片与按钮样式。
 */
final class Ui {

    static final int PRIMARY = 0xFF1A73E8;
    static final int PRIMARY_DARK = 0xFF1557B0;
    static final int PRIMARY_SOFT = 0xFFE8F0FE;
    static final int TEXT = 0xFF212121;
    static final int TEXT_MUTED = 0xFF616161;
    static final int TEXT_FAINT = 0xFF9E9E9E;
    static final int DIVIDER = 0xFFE8EAED;
    static final int BG = 0xFFF5F6F8;
    static final int CARD = 0xFFFFFFFF;
    static final int DANGER = 0xFFD32F2F;
    static final int SUCCESS = 0xFF2E7D32;

    private Ui() {
    }

    static int dp(Context context, int value) {
        float density = context.getResources().getDisplayMetrics().density;
        return (int) (value * density + 0.5f);
    }

    /** 纯色圆角背景。 */
    static GradientDrawable rounded(Context context, int color, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setShape(GradientDrawable.RECTANGLE);
        drawable.setColor(color);
        drawable.setCornerRadius(dp(context, radiusDp));
        return drawable;
    }

    /** 描边圆角背景。 */
    static GradientDrawable outline(Context context, int fill, int stroke, int radiusDp) {
        GradientDrawable drawable = rounded(context, fill, radiusDp);
        drawable.setStroke(dp(context, 1), stroke);
        return drawable;
    }

    /** 卡片容器：白底、圆角、内边距。 */
    static LinearLayout card(Context context) {
        LinearLayout box = new LinearLayout(context);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackground(rounded(context, CARD, 12));
        int pad = dp(context, 16);
        box.setPadding(pad, pad, pad, pad);
        return box;
    }

    /** 卡片在竖向 LinearLayout 里的布局参数（卡片之间留白）。 */
    static LinearLayout.LayoutParams cardParams(Context context) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = dp(context, 12);
        return lp;
    }

    /** 区块小标题。 */
    static TextView sectionTitle(Context context, String text) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setTextColor(TEXT);
        return view;
    }

    /** 表单字段说明文字。 */
    static TextView fieldLabel(Context context, String text) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        view.setTextColor(TEXT_MUTED);
        view.setPadding(0, dp(context, 14), 0, dp(context, 4));
        return view;
    }

    /** 实心主按钮（白字）。 */
    static Button primaryButton(Context context, String text) {
        Button button = baseButton(context, text);
        button.setTextColor(0xFFFFFFFF);
        button.setBackground(pressable(context, PRIMARY, PRIMARY_DARK));
        button.setPadding(dp(context, 22), dp(context, 10), dp(context, 22), dp(context, 10));
        return button;
    }

    /** 描边次按钮（主色字）。 */
    static Button ghostButton(Context context, String text) {
        Button button = baseButton(context, text);
        button.setTextColor(PRIMARY);
        button.setBackground(pressableOutline(context));
        button.setPadding(dp(context, 18), dp(context, 10), dp(context, 18), dp(context, 10));
        return button;
    }

    private static Button baseButton(Context context, String text) {
        Button button = new Button(context);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        button.setMinHeight(dp(context, 44));
        return button;
    }

    private static StateListDrawable pressable(Context context, int normal, int pressed) {
        StateListDrawable drawable = new StateListDrawable();
        drawable.addState(new int[] {android.R.attr.state_pressed}, rounded(context, pressed, 10));
        drawable.addState(new int[0], rounded(context, normal, 10));
        return drawable;
    }

    private static StateListDrawable pressableOutline(Context context) {
        StateListDrawable drawable = new StateListDrawable();
        drawable.addState(new int[] {android.R.attr.state_pressed},
                outline(context, PRIMARY_SOFT, PRIMARY, 10));
        drawable.addState(new int[0], outline(context, 0xFFFFFFFF, PRIMARY, 10));
        return drawable;
    }
}
