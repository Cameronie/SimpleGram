package com.cam.simplegram;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

import java.util.HashSet;
import java.util.Set;

/** Saves photos and videos to Downloads/SimpleGram and reports when they finish. */
final class Downloads {
    interface Reporter {
        void report(String message);
    }

    private final Context context;
    private final Reporter reporter;
    private final Set<Long> pending = new HashSet<>();
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (!pending.remove(id)) return;
            reporter.report(succeeded(id)
                    ? "Saved to Downloads/SimpleGram"
                    : "Download failed. Instagram's link may have expired — open the post again and retry.");
        }
    };

    Downloads(Context context, Reporter reporter) {
        this.context = context;
        this.reporter = reporter;
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            context.registerReceiver(receiver, filter);
        }
    }

    void release() {
        try {
            context.unregisterReceiver(receiver);
        } catch (IllegalArgumentException ignored) {
            // Already unregistered.
        }
    }

    /** Returns false when the address is not an Instagram media file. */
    boolean enqueue(String url, String name, boolean video, String userAgent) {
        Uri uri = Uri.parse(url);
        if (!Links.isMediaFile(uri)) return false;
        String file = safeName(name, video);
        DownloadManager.Request r = new DownloadManager.Request(uri)
                .setTitle(file)
                .setMimeType(video ? "video/mp4" : "image/jpeg")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "SimpleGram/" + file);
        if (userAgent != null) r.addRequestHeader("User-Agent", userAgent);
        r.addRequestHeader("Referer", Links.HOME);
        DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        try {
            pending.add(dm.enqueue(r));
        } catch (RuntimeException e) {
            // Android's Download Manager is disabled or restricted on this phone.
            return false;
        }
        return true;
    }

    private boolean succeeded(long id) {
        DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(id))) {
            if (c == null || !c.moveToFirst()) return false;
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            return status == DownloadManager.STATUS_SUCCESSFUL;
        } catch (RuntimeException e) {
            return false;
        }
    }

    static String safeName(String name, boolean video) {
        String ext = video ? ".mp4" : ".jpg";
        String base = name == null ? "" : name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (base.endsWith(".mp4") || base.endsWith(".jpg")) base = base.substring(0, base.length() - 4);
        if (base.isEmpty()) base = "SimpleGram";
        if (base.length() > 90) base = base.substring(0, 90);
        return base + "_" + (System.currentTimeMillis() % 100000) + ext;
    }
}
