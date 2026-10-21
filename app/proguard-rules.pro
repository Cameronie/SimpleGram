# Keep the fallback JavaScript bridge methods reachable by name.
-keepclassmembers class com.cam.simplegram.MainActivity$LegacyBridge {
    @android.webkit.JavascriptInterface <methods>;
}
