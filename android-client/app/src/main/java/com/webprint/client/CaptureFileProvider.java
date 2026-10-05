package com.webprint.client;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/**
 * 极简 {@link ContentProvider}，只用于把 {@code content://com.webprint.client.fileprovider/captures/<文件名>}
 * 映射到应用私有目录 {@code files/captures/} 下的文件。
 *
 * <p>为什么不用 AndroidX 的 {@code FileProvider}：本工程显式设置
 * {@code android.useAndroidX=false} 且不引入任何 support/AndroidX 依赖，
 * 而网页的「拍照上传」需要给相机应用一个可写的 content:// URI，故自带约百行实现。
 *
 * <p>安全边界：只能访问 {@code files/captures/} 目录内的普通文件，
 * 路径经过 canonical 前缀校验，{@code ..} 等穿越写法会被拒绝。
 */
public class CaptureFileProvider extends ContentProvider {

    /** 必须与 AndroidManifest.xml 中 provider 的 authorities 一致。 */
    public static final String AUTHORITY = "com.webprint.client.fileprovider";

    /** URI 的第一段路径，对应 {@code files/captures} 目录。 */
    private static final String PATH_CAPTURES = "captures";

    /** 构造写入相机照片用的 URI。 */
    public static Uri buildCaptureUri(String fileName) {
        return new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(PATH_CAPTURES)
                .appendPath(fileName)
                .build();
    }

    private File capturesDir() {
        return new File(getContext().getFilesDir(), PATH_CAPTURES);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public String getType(Uri uri) {
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
        if (uri.getPathSegments().size() != 2) {
            return null;
        }
        if (!PATH_CAPTURES.equals(uri.getPathSegments().get(0))) {
            return null;
        }
        String name = uri.getPathSegments().get(1);
        if (name.isEmpty() || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0
                || "..".equals(name) || ".".equals(name)) {
            return null;
        }
        File dir = capturesDir();
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
     * 相机应用有时会查询文件大小等信息；这里返回 null 表示“不支持查询”，
     * 相机应用会退化为直接写文件。
     */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs,
            String sortOrder) {
        return null;
    }
}
