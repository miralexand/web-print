package com.webprint.client;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.hardware.Camera;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.EnumMap;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;

/**
 * 全屏扫码页。
 *
 * <p>使用框架自带的、已废弃但无需任何第三方库的 {@link Camera} API 获取 NV21 预览帧，
 * 交给 ZXing core（纯 Java）解码。UI 全部由 Java 代码搭建。
 *
 * <p>结果：解码成功时 {@code setResult(RESULT_OK)} 并带上
 * {@link #EXTRA_SCAN_RESULT} 原始文本；用户取消则 {@code RESULT_CANCELED}。
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback {

    /** 扫码结果（二维码原始文本）的 extra key。 */
    public static final String EXTRA_SCAN_RESULT = "scan_result";

    private static final long DECODE_INTERVAL_MS = 220L;
    private static final int REQ_CAMERA_PERMISSION = 2001;
    /** 期望的预览分辨率，接近 720p 时解码速度与识别率比较均衡。 */
    private static final int TARGET_WIDTH = 1280;
    private static final int TARGET_HEIGHT = 720;

    private SurfaceView mPreviewView;
    private SurfaceHolder mHolder;

    private Camera mCamera;
    private Camera.Size mPreviewSize;

    private HandlerThread mDecodeThread;
    private Handler mDecodeHandler;

    private volatile boolean mDecoding;
    private volatile boolean mPaused;
    private volatile boolean mDecodeRequested;
    private boolean mFinished;
    private long mLastDecodeAt;

    private final MultiFormatReader mReader = new MultiFormatReader();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 相机预览时保持屏幕常亮，并隐藏状态栏
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN);
        }
        if (getActionBar() != null) {
            getActionBar().hide();
        }

        // 只解码二维码，缩小搜索空间
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        mReader.setHints(hints);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        mPreviewView = new SurfaceView(this);
        mHolder = mPreviewView.getHolder();
        mHolder.addCallback(this);
        // 部分老设备（API < 11 的兼容写法）需要显式声明不使用前置缓冲
        mHolder.setType(SurfaceHolder.SURFACE_TYPE_PUSH_BUFFERS);
        root.addView(mPreviewView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        View overlay = new PreviewOverlay(this);
        overlay.setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        root.addView(overlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView hint = new TextView(this);
        hint.setText(getString(R.string.scan_hint));
        hint.setTextColor(Color.WHITE);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        hint.setGravity(Gravity.CENTER);
        hint.setBackgroundColor(0x88000000);
        hint.setPadding(dp(16), dp(10), dp(16), dp(10));
        FrameLayout.LayoutParams hintLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        hintLp.topMargin = dp(40);
        root.addView(hint, hintLp);

        Button cancel = new Button(this);
        cancel.setText(getString(R.string.scan_cancel));
        cancel.setAllCaps(false);
        cancel.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                setResult(RESULT_CANCELED);
                finish();
            }
        });
        FrameLayout.LayoutParams cancelLp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cancelLp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        cancelLp.bottomMargin = dp(40);
        root.addView(cancel, cancelLp);

        setContentView(root);

        if (!hasCameraPermission()) {
            requestCameraPermission();
        }
    }

    // ------------------------------------------------------------------
    // 权限
    // ------------------------------------------------------------------

    private boolean hasCameraPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true; // 安装时已授权
        }
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestCameraPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_CAMERA_PERMISSION);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_CAMERA_PERMISSION) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            startCamera(); // 拿到权限后再开相机
        } else {
            Toast.makeText(this, R.string.scan_permission_denied, Toast.LENGTH_LONG).show();
            setResult(RESULT_CANCELED);
            finish();
        }
    }

    // ------------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------------

    @Override
    protected void onResume() {
        super.onResume();
        mPaused = false;
        if (hasCameraPermission()) {
            startCamera();
        }
    }

    @Override
    protected void onPause() {
        mPaused = true;
        stopCamera();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        stopCamera();
        mReader.reset();
        if (mDecodeThread != null) {
            mDecodeThread.quit();
            mDecodeThread = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------------
    // SurfaceHolder.Callback
    // ------------------------------------------------------------------

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        if (hasCameraPermission()) {
            startCamera();
        }
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        if (mCamera != null) {
            // 尺寸变化后重启预览，避免画面拉伸或黑屏
            stopPreviewQuietly();
            startPreviewQuietly();
        } else if (hasCameraPermission()) {
            startCamera();
        }
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        stopCamera();
    }

    // ------------------------------------------------------------------
    // 相机
    // ------------------------------------------------------------------

    private synchronized void startCamera() {
        if (mCamera != null || mPaused || mFinished) {
            return;
        }
        try {
            mCamera = Camera.open();
        } catch (Exception e) {
            mCamera = null;
            Toast.makeText(this, R.string.scan_no_camera, Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        try {
            Camera.Parameters params = mCamera.getParameters();
            mPreviewSize = choosePreviewSize(params.getSupportedPreviewSizes());
            if (mPreviewSize != null) {
                params.setPreviewSize(mPreviewSize.width, mPreviewSize.height);
            }
            params.setPreviewFormat(android.graphics.ImageFormat.NV21);

            // 对焦
            List<String> focusModes = params.getSupportedFocusModes();
            if (focusModes != null) {
                if (focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                    params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
                } else if (focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO)) {
                    params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO);
                } else if (focusModes.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                    params.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
                }
            }
            // 关掉闪光灯
            List<String> flashModes = params.getSupportedFlashModes();
            if (flashModes != null && flashModes.contains(Camera.Parameters.FLASH_MODE_OFF)) {
                params.setFlashMode(Camera.Parameters.FLASH_MODE_OFF);
            }
            // 关掉场景模式，避免某些机型把对焦锁死
            List<String> sceneModes = params.getSupportedSceneModes();
            if (sceneModes != null && sceneModes.contains(Camera.Parameters.SCENE_MODE_AUTO)) {
                params.setSceneMode(Camera.Parameters.SCENE_MODE_AUTO);
            }

            mCamera.setParameters(params);
            mCamera.setDisplayOrientation(displayOrientation());
            mCamera.setPreviewDisplay(mHolder);
            mCamera.setPreviewCallback(new Camera.PreviewCallback() {
                @Override
                public void onPreviewFrame(byte[] data, Camera camera) {
                    onFrame(data);
                }
            });
            startPreviewQuietly();
            ensureDecodeThread();
        } catch (Exception e) {
            // 参数不被支持等情况：释放相机并提示，避免残留占用
            Toast.makeText(this, R.string.scan_no_camera, Toast.LENGTH_LONG).show();
            stopCamera();
            finish();
        }
    }

    private void startPreviewQuietly() {
        if (mCamera == null) {
            return;
        }
        try {
            mCamera.startPreview();
        } catch (Exception ignored) {
            // 预览启动失败不致命，等下一次 surfaceChanged / onResume 再试
        }
    }

    private void stopPreviewQuietly() {
        if (mCamera == null) {
            return;
        }
        try {
            mCamera.setPreviewCallback(null);
        } catch (Exception ignored) {
        }
        try {
            mCamera.stopPreview();
        } catch (Exception ignored) {
        }
    }

    private synchronized void stopCamera() {
        if (mCamera != null) {
            stopPreviewQuietly();
            try {
                mCamera.release();
            } catch (Exception ignored) {
            }
            mCamera = null;
        }
        if (mDecodeThread != null) {
            mDecodeThread.quit();
            mDecodeThread = null;
            mDecodeHandler = null;
        }
        mDecodeRequested = false;
    }

    /** 竖屏预览需要旋转 90 度，横屏则用 0 度。 */
    private int displayOrientation() {
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        int degrees;
        switch (rotation) {
            case Surface.ROTATION_90:
                degrees = 90;
                break;
            case Surface.ROTATION_180:
                degrees = 180;
                break;
            case Surface.ROTATION_270:
                degrees = 270;
                break;
            default:
                degrees = 0;
                break;
        }
        Camera.CameraInfo info = new Camera.CameraInfo();
        Camera.getCameraInfo(0, info);
        int result;
        if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
            result = (info.orientation + degrees) % 360;
            result = (360 - result) % 360;
        } else {
            result = (info.orientation - degrees + 360) % 360;
        }
        return result;
    }

    /** 优先 1280x720；没有就取长边最接近 1280、短边最接近 720 的一档。 */
    private static Camera.Size choosePreviewSize(List<Camera.Size> sizes) {
        if (sizes == null || sizes.isEmpty()) {
            return null;
        }
        Camera.Size target = null;
        for (Camera.Size size : sizes) {
            if (size.width == TARGET_WIDTH && size.height == TARGET_HEIGHT) {
                return size;
            }
        }
        long bestScore = Long.MAX_VALUE;
        for (Camera.Size size : sizes) {
            long dw = Math.abs((long) size.width - TARGET_WIDTH);
            long dh = Math.abs((long) size.height - TARGET_HEIGHT);
            long score = dw + dh;
            if (score < bestScore) {
                bestScore = score;
                target = size;
            }
        }
        return target;
    }

    // ------------------------------------------------------------------
    // 解码
    // ------------------------------------------------------------------

    private void ensureDecodeThread() {
        if (mDecodeThread != null) {
            return;
        }
        mDecodeThread = new HandlerThread("qr-decode");
        mDecodeThread.start();
        mDecodeHandler = new Handler(mDecodeThread.getLooper());
    }

    private void onFrame(byte[] data) {
        if (mPaused || mFinished || data == null || mDecodeHandler == null) {
            return;
        }
        long now = System.currentTimeMillis();
        // 节流：不必每帧都解码，否则 CPU 白烧、对焦也变慢
        if (now - mLastDecodeAt < DECODE_INTERVAL_MS || mDecodeRequested) {
            return;
        }
        mLastDecodeAt = now;
        mDecodeRequested = true;
        final byte[] frame = data;
        final Camera.Size size = mPreviewSize;
        mDecodeHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    decode(frame, size);
                } finally {
                    mDecodeRequested = false;
                }
            }
        });
    }

    private void decode(byte[] data, Camera.Size size) {
        if (mDecoding || mFinished || mPaused || size == null) {
            return;
        }
        mDecoding = true;
        try {
            PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                    data, size.width, size.height, 0, 0, size.width, size.height, false);
            BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
            Result result = mReader.decodeWithState(bitmap);
            if (result != null) {
                onDecoded(result.getText());
            }
        } catch (Exception e) {
            // NotFoundException 属于正常情况：这一帧没有二维码
        } finally {
            mReader.reset();
            mDecoding = false;
        }
    }

    private void onDecoded(final String text) {
        // 只接受能规范化为 http/https 的地址，避免误扫其它二维码时白关页面
        final String normalized = ServerStore.normalizeUrl(text);
        if (normalized == null) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(ScanActivity.this, R.string.scan_failed_not_url,
                            Toast.LENGTH_SHORT).show();
                }
            });
            return;
        }
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (mFinished) {
                    return;
                }
                mFinished = true;
                Intent data = new Intent();
                data.putExtra(EXTRA_SCAN_RESULT, text.trim());
                setResult(RESULT_OK, data);
                finish();
            }
        });
    }

    @Override
    public void onBackPressed() {
        setResult(RESULT_CANCELED);
        finish();
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return (int) (value * density + 0.5f);
    }

    /** 取景框装饰：四周压暗，中间留出方框和四个角。 */
    private static final class PreviewOverlay extends View {

        private final Paint mDimPaint = new Paint();
        private final Paint mFramePaint = new Paint(Paint.ANTI_ALIAS_FLAG);

        PreviewOverlay(Context context) {
            super(context);
            mDimPaint.setColor(0x66000000);
            mFramePaint.setColor(0xFFFFFFFF);
            mFramePaint.setStyle(Paint.Style.STROKE);
            mFramePaint.setStrokeWidth(context.getResources().getDisplayMetrics().density * 3f);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            int w = getWidth();
            int h = getHeight();
            int side = (int) (Math.min(w, h) * 0.66f);
            int left = (w - side) / 2;
            int top = (h - side) / 2;
            int right = left + side;
            int bottom = top + side;

            canvas.drawRect(0, 0, w, top, mDimPaint);
            canvas.drawRect(0, bottom, w, h, mDimPaint);
            canvas.drawRect(0, top, left, bottom, mDimPaint);
            canvas.drawRect(right, top, w, bottom, mDimPaint);

            int corner = side / 6;
            canvas.drawLine(left, top, left + corner, top, mFramePaint);
            canvas.drawLine(left, top, left, top + corner, mFramePaint);
            canvas.drawLine(right - corner, top, right, top, mFramePaint);
            canvas.drawLine(right, top, right, top + corner, mFramePaint);
            canvas.drawLine(left, bottom - corner, left, bottom, mFramePaint);
            canvas.drawLine(left, bottom, left + corner, bottom, mFramePaint);
            canvas.drawLine(right - corner, bottom, right, bottom, mFramePaint);
            canvas.drawLine(right, bottom - corner, right, bottom, mFramePaint);
        }
    }
}
