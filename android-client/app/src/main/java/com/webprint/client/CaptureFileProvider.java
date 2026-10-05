package com.webprint.client;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * 极简 {@link ContentProvider}，把应用私有目录下的文件暴露成 content:// URI：
 *
 * <ul>
 *   <li>{@code content://com.webprint.client.fileprovider/captures/<文件名>}
 *       → {@code files/captures/}：供网页「拍照上传」写入相机照片；</li>
 *   <li>{@code content://com.webprint.client.fileprovider/updates/<文件名>}
 *       → {@code files/updates/}：供「检查更新」把下载好的 APK 交给系统安装器。</li>
 * </ul>
 *
 * <p>为什么不用 AndroidX 的 {@code FileProvider}：本工程显式设置
 * {@code android.useAndroidX=false} 且不引入任何 support/AndroidX 依赖，
 * 而相机写入、APK 安装都需要 content:// URI，故自带实现。
 *
 * <p>安全边界：只能访问上述两个目录内的普通文件，路径经过 canonical 前缀校验，
 * {@code ..} 等穿越写法会被拒绝。
 */
public class CaptureFileProvider extends ContentProvider {

    /** 必须与 AndroidManifest.xml 中 provider 的 authorities 一致。 */
    public static final String AUTHORITY = "com.webprint.client.fileprovider";

    /** URI 的第一段路径，对应 {@code files/captures} 目录。 */
    private static final String PATH_CAPTURES = "captures";
    /** URI 的第一段路径，对应 {@code files/updates} 目录。 */
    private static final String PATH_UPDATES = "updates";

    /** 安装包 MIME。 */
    private static final String MIME_APK = "application/vnd.android.package-archive";

    /** 构造写入相机照片用的 URI。 */
    public static Uri buildCaptureUri(String fileName) {
        return buildUri(PATH_CAPTURES, fileName);
    }

    /** 构造把更新 APK 交给系统安装器用的 URI。 */
    public static Uri buildUpdateUri(String fileName) {
        return buildUri(PATH_UPDATES, fileName);
    }

    private static Uri buildUri(String root, String fileName) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(root)
                .appendPath(fileName)
                .build();
    }

    private File rootDir(String root) {
        return new File(getContext().getFilesDir(), root);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
        if (uri != null && uri.getPathSegments().size() >= 1
                && PATH_UPDATES.equals(uri.getPathSegments().get(0))) {
            return MIME_APK;
        }
        return "image/jpeg";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = resolve(uri);
        if (file == null) {
            throw new FileNotFoundException("不允许访问的路径: " + uri);
        }
        int flags;
        if ("r".equals(mode)) {
            flags = ParcelFileDescriptor.MODE_READ_ONLY;
        } else if ("rw".equals(mode) || "rwt".equals(mode)) {
            flags = ParcelFileDescriptor.MODE_READ_WRITE;
        } else {
            // 默认按写入处理（相机应用通常用 "w"）
            flags = ParcelFileDescriptor.MODE_WRITE_ONLY
                    | ParcelFileDescriptor.MODE_CREATE
                    | ParcelFileDescriptor.MODE_TRUNCATE;
        }
        return ParcelFileDescriptor.open(file, flags);
    }

    /** 把 URI 解析为目录内的文件；越界或非法则返回 {@code null}。 */
    private File resolve(Uri uri) {
        if (uri == null || uri.getPathSegments().size() != 2) {
            return null;
        }
        String root = uri.getPathSegments().get(0);
        if (!PATH_CAPTURES.equals(root) && !PATH_UPDATES.equals(root)) {
            return null;
        }
        String name = uri.getPathSegments().get(1);
        if (name.isEmpty() || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0
                || "..".equals(name) || ".".equals(name)) {
            return null;
        }
        File dir = rootDir(root);
        File file = new File(dir, name);
        try {
            String dirPath = dir.getCanonicalPath();
            String filePath = file.getCanonicalPath();
            if (!filePath.startsWith(dirPath + File.separator)) {
                return null; // 目录穿越，拒绝
            }
            return file;
        } catch (IOException e) {
            return null;
        }
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("不支持插入操作");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("不支持删除操作");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("不支持更新操作");
    }

    /**
     * 返回文件的显示名与大小。系统安装器（PackageInstaller）会查询这些列，
     * 相机应用也会用它读取文件名；查不到（URI 非法）时返回 {@code null}，
     * 由调用方退化为直接操作流。
     */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs,
            String sortOrder) {
        File file = resolve(uri);
        if (file == null || !file.isFile()) {
            return null;
        }
        String[] columns = projection != null ? projection
                : new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        MatrixCursor.RowBuilder row = cursor.newRow();
        for (String column : columns) {
            if (OpenableColumns.DISPLAY_NAME.equals(column)) {
                row.add(file.getName());
            } else if (OpenableColumns.SIZE.equals(column)) {
                row.add(file.length());
            } else {
                row.add(null);
            }
        }
        return cursor;
    }
}
