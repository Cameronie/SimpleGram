package com.cam.simplegram;

import android.net.Uri;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Decides which addresses SimpleGram opens itself and which go to the browser. */
final class Links {
    static final String HOME = "https://www.instagram.com/";
    private static final Pattern CODE = Pattern.compile("^[A-Za-z0-9_-]{5,40}$");
    private static final Pattern URL_IN_TEXT = Pattern.compile("https?://[^\\s\"'<>]+", Pattern.CASE_INSENSITIVE);

    private Links() {}

    static String host(Uri uri) {
        String h = uri == null ? null : uri.getHost();
        return h == null ? "" : h.toLowerCase(Locale.ROOT);
    }

    /** The Instagram web app itself. */
    static boolean isInstagram(Uri uri) {
        if (uri == null || !"https".equals(uri.getScheme())) return false;
        if (uri.getUserInfo() != null || uri.getPort() != -1) return false;
        String h = host(uri);
        return h.equals("www.instagram.com") || h.equals("instagram.com") || h.equals("m.instagram.com");
    }

    /** Pages that must stay inside the app for sign-in and account settings to work. */
    static boolean staysInApp(Uri uri) {
        if (isInstagram(uri)) return true;
        if (uri == null || !"https".equals(uri.getScheme()) || uri.getUserInfo() != null) return false;
        String h = host(uri);
        return h.equals("accountscenter.instagram.com")
                || h.equals("www.facebook.com") || h.equals("m.facebook.com") || h.equals("facebook.com")
                || h.equals("auth.meta.com") || h.equals("accounts.meta.com");
    }

    /** Instagram's outbound link wrapper: return the real destination. */
    static Uri unwrapOutbound(Uri uri) {
        String h = host(uri);
        if (!h.equals("l.instagram.com") && !h.equals("l.facebook.com")) return uri;
        String target = uri.getQueryParameter("u");
        if (target == null) return uri;
        Uri t = Uri.parse(target);
        String s = t.getScheme();
        return ("https".equals(s) || "http".equals(s)) ? t : uri;
    }

    /** Normalises a link from another app into an Instagram address, or null. */
    static String normalize(String raw) {
        if (raw == null) return null;
        Uri uri = Uri.parse(raw.trim());
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) return null;
        if (uri.getUserInfo() != null || uri.getPort() != -1) return null;
        String h = host(uri);
        if (!h.equals("www.instagram.com") && !h.equals("instagram.com") && !h.equals("m.instagram.com")) return null;
        String path = uri.getEncodedPath();
        if (path == null || path.isEmpty()) path = "/";
        if (path.contains("..")) return null;
        String query = uri.getEncodedQuery();
        return "https://www.instagram.com" + path + (query == null ? "" : "?" + query);
    }

    /** First Instagram link inside shared text, or null. */
    static String fromText(String text) {
        if (text == null) return null;
        Matcher m = URL_IN_TEXT.matcher(text);
        while (m.find()) {
            String n = normalize(m.group());
            if (n != null) return n;
        }
        return null;
    }

    static boolean isReelsTab(Uri uri) {
        if (!isInstagram(uri)) return false;
        String p = uri.getPath();
        return "/reels".equals(p) || "/reels/".equals(p);
    }

    static String commentsUrl(String code) {
        if (code == null || !CODE.matcher(code).matches()) return null;
        return "https://www.instagram.com/p/" + code + "/comments/";
    }

    /** Media files come only from Instagram's own content servers. */
    static boolean isMediaFile(Uri uri) {
        if (uri == null || !"https".equals(uri.getScheme()) || uri.getUserInfo() != null) return false;
        String h = host(uri);
        return h.endsWith(".cdninstagram.com") || h.equals("cdninstagram.com")
                || h.endsWith(".fbcdn.net") || h.equals("fbcdn.net");
    }
}
