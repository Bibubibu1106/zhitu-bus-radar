package com.jingan.shbusradar;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.view.View;
import android.view.Window;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static MainActivity currentInstance = null;
    private WebView webView;
    private ExecutorService apiExecutor;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        currentInstance = this;
        apiExecutor = Executors.newFixedThreadPool(6);

        BusWatchService.ensureChannels(this);
        requestAppPermissions();

        applySystemBarColors(false);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#DBEAFE"));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setGeolocationEnabled(true);
        settings.setTextZoom(100);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }
        });
        webView.addJavascriptInterface(new AndroidBridge(this), "AndroidBridge");
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        currentInstance = this;
        notifyWebWatchStateChanged();
    }

    @Override
    protected void onDestroy() {
        if (currentInstance == this) {
            currentInstance = null;
        }
        if (apiExecutor != null) {
            apiExecutor.shutdownNow();
        }
        super.onDestroy();
    }

    private void applySystemBarColors(final boolean isNight) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Window w = getWindow();
                    if (w == null) return;
                    int bgColor = Color.parseColor(isNight ? "#1E293B" : "#DBEAFE");
                    w.setStatusBarColor(bgColor);
                    w.setNavigationBarColor(Color.parseColor(isNight ? "#0F172A" : "#FEFCE8"));
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        View decor = w.getDecorView();
                        int flags = decor.getSystemUiVisibility();
                        if (isNight) {
                            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                        } else {
                            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                        }
                        decor.setSystemUiVisibility(flags);
                    }
                } catch (Exception ignored) {}
            }
        });
    }

    private void requestAppPermissions() {
        if (Build.VERSION.SDK_INT >= 23) {
            if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") != PackageManager.PERMISSION_GRANTED
                || (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED)) {
                requestPermissions(new String[]{
                    "android.permission.POST_NOTIFICATIONS",
                    "android.permission.ACCESS_FINE_LOCATION",
                    "android.permission.ACCESS_COARSE_LOCATION"
                }, 201);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 202) {
            fetchNativeLocation();
        }
    }

    private void fetchNativeLocation() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 23) {
                        if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") != PackageManager.PERMISSION_GRANTED
                            && checkSelfPermission("android.permission.ACCESS_COARSE_LOCATION") != PackageManager.PERMISSION_GRANTED) {
                            requestPermissions(new String[]{
                                "android.permission.ACCESS_FINE_LOCATION",
                                "android.permission.ACCESS_COARSE_LOCATION"
                            }, 202);
                            return;
                        }
                    }
                    final LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
                    if (lm == null) {
                        deliverLocationError("定位服务未就绪");
                        return;
                    }

                    String[] providers = new String[]{
                        LocationManager.GPS_PROVIDER,
                        LocationManager.NETWORK_PROVIDER,
                        LocationManager.PASSIVE_PROVIDER
                    };

                    Location bestLoc = null;
                    long now = System.currentTimeMillis();
                    for (String p : providers) {
                        try {
                            if (lm.isProviderEnabled(p)) {
                                Location loc = lm.getLastKnownLocation(p);
                                if (loc != null && (now - loc.getTime() < 15 * 60 * 1000L)) {
                                    if (bestLoc == null || loc.getTime() > bestLoc.getTime()) {
                                        bestLoc = loc;
                                    }
                                }
                            }
                        } catch (Exception ignored) {}
                    }

                    if (bestLoc != null) {
                        resolveAndDeliverLocation(bestLoc.getLatitude(), bestLoc.getLongitude());
                        return;
                    }

                    final LocationListener listener = new LocationListener() {
                        @Override
                        public void onLocationChanged(Location location) {
                            if (location != null) {
                                try { lm.removeUpdates(this); } catch (Exception ignored) {}
                                resolveAndDeliverLocation(location.getLatitude(), location.getLongitude());
                            }
                        }
                        @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
                        @Override public void onProviderEnabled(String provider) {}
                        @Override public void onProviderDisabled(String provider) {}
                    };

                    boolean anyRequested = false;
                    for (String p : providers) {
                        try {
                            if (lm.isProviderEnabled(p)) {
                                lm.requestSingleUpdate(p, listener, Looper.getMainLooper());
                                anyRequested = true;
                            }
                        } catch (Exception ignored) {}
                    }

                    if (!anyRequested) {
                        // 回退读取历史最近坐标（不限时间）
                        for (String p : providers) {
                            try {
                                Location loc = lm.getLastKnownLocation(p);
                                if (loc != null) {
                                    resolveAndDeliverLocation(loc.getLatitude(), loc.getLongitude());
                                    return;
                                }
                            } catch (Exception ignored) {}
                        }
                        deliverLocationError("请检查手机GPS定位开关");
                    }
                } catch (Exception e) {
                    deliverLocationError("获取定位失败");
                }
            }
        });
    }

    private void resolveAndDeliverLocation(final double wgsLat, final double wgsLon) {
        apiExecutor.execute(new Runnable() {
            @Override
            public void run() {
                String roadLabel = "";
                try {
                    Geocoder geocoder = new Geocoder(MainActivity.this, Locale.CHINA);
                    List<Address> list = geocoder.getFromLocation(wgsLat, wgsLon, 1);
                    if (list != null && !list.isEmpty()) {
                        Address a = list.get(0);
                        String sub = a.getSubLocality() != null ? a.getSubLocality() : "";
                        String road = a.getThoroughfare() != null ? a.getThoroughfare()
                            : (a.getFeatureName() != null ? a.getFeatureName() : "");
                        roadLabel = (sub + road).trim();
                    }
                } catch (Exception ignored) {}

                double[] gcj = BusApiClient.wgs84ToGcj02(wgsLat, wgsLon);
                try {
                    final JSONObject payload = new JSONObject();
                    payload.put("ok", true);
                    payload.put("wgsLat", wgsLat);
                    payload.put("wgsLng", wgsLon);
                    payload.put("gcjLat", gcj[0]);
                    payload.put("gcjLng", gcj[1]);
                    payload.put("name", roadLabel);
                    evalJs("if(window.__onNativeLocation){window.__onNativeLocation(" + payload.toString() + ");}");
                } catch (Exception ignored) {}
            }
        });
    }

    private void deliverLocationError(final String msg) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("ok", false);
            payload.put("error", msg);
            evalJs("if(window.__onNativeLocation){window.__onNativeLocation(" + payload.toString() + ");}");
        } catch (Exception ignored) {}
    }

    public static void notifyWebWatchStateChanged() {
        MainActivity act = currentInstance;
        if (act != null) {
            final String stateStr = BusWatchService.getCurrentWatchStateJson().toString();
            act.evalJs("if(window.__onNativeWatchSync){window.__onNativeWatchSync(" + stateStr + ");}");
        }
    }

    private void evalJs(final String script) {
        if (webView != null) {
            webView.post(new Runnable() {
                @Override
                public void run() {
                    if (webView != null) {
                        webView.evaluateJavascript(script, null);
                    }
                }
            });
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            webView.evaluateJavascript(
                "(function(){ return window.__handleHardwareBack ? window.__handleHardwareBack() : false; })()",
                value -> {
                    if (!"true".equals(value)) {
                        MainActivity.super.onBackPressed();
                    }
                }
            );
        } else {
            super.onBackPressed();
        }
    }

    public class AndroidBridge {
        private final Context context;

        AndroidBridge(Context ctx) {
            this.context = ctx;
        }

        @JavascriptInterface
        public void callBusApiAsync(final String reqId, final String action, final String payloadJson) {
            apiExecutor.execute(new Runnable() {
                @Override
                public void run() {
                    String res = BusApiClient.dispatch(context, action, payloadJson);
                    String quotedId = JSONObject.quote(reqId);
                    String quotedRes = JSONObject.quote(res);
                    evalJs("if(window.__onNativeApiCallback){window.__onNativeApiCallback(" + quotedId + "," + quotedRes + ");}");
                }
            });
        }

        @JavascriptInterface
        public void requestNativeLocation() {
            fetchNativeLocation();
        }

        @JavascriptInterface
        public void startBusWatch(String configJson) {
            try {
                JSONObject cfg = new JSONObject(configJson);
                Intent intent = new Intent(context, BusWatchService.class);
                intent.setAction(BusWatchService.ACTION_START_WATCH);
                intent.putExtra("watchKey", cfg.optString("watchKey", ""));
                intent.putExtra("cityId", cfg.optString("cityId", "034"));
                intent.putExtra("lineId", cfg.optString("lineId", ""));
                intent.putExtra("lineName", cfg.optString("lineName", ""));
                intent.putExtra("direction", cfg.optString("direction", "0"));
                intent.putExtra("endSn", cfg.optString("endSn", ""));
                intent.putExtra("stationId", cfg.optString("stationId", ""));
                intent.putExtra("stationName", cfg.optString("stationName", ""));
                intent.putExtra("nextStationName", cfg.optString("nextStationName", ""));
                intent.putExtra("lineNo", cfg.optString("lineNo", ""));
                intent.putExtra("targetOrder", cfg.optInt("targetOrder", 1));
                intent.putExtra("alertStops", cfg.optInt("alertStops", 2));
                intent.putExtra("alertMinutes", cfg.optInt("alertMinutes", 3));
                intent.putExtra("nightDnd", cfg.optBoolean("nightDnd", true));

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent);
                } else {
                    context.startService(intent);
                }

                // 首次开启盯梢时若尚未加入省电白名单，自动弹出一次系统授权询问
                if (!isKeepAliveGranted()) {
                    boolean asked = context.getSharedPreferences("sh_bus_prefs", Context.MODE_PRIVATE)
                        .getBoolean("asked_keep_alive_once", false);
                    if (!asked) {
                        context.getSharedPreferences("sh_bus_prefs", Context.MODE_PRIVATE)
                            .edit().putBoolean("asked_keep_alive_once", true).apply();
                        openKeepAliveSettings();
                    }
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void stopBusWatch() {
            try {
                Intent intent = new Intent(context, BusWatchService.class);
                intent.setAction(BusWatchService.ACTION_STOP_WATCH);
                context.startService(intent);
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public String getWatchState() {
            return BusWatchService.getCurrentWatchStateJson().toString();
        }

        @JavascriptInterface
        public void sendTestNotification(String title, String body) {
            try {
                BusWatchService.triggerDoubleVibration(context);
                NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) return;
                Intent openIntent = new Intent(context, MainActivity.class);
                PendingIntent pi = PendingIntent.getActivity(
                    context, 20, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );
                Bitmap bmp = BusApiClient.getNotificationBusIconBitmap();
                Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Notification.Builder(context, BusWatchService.CHANNEL_ARRIVAL_ALERT)
                    : new Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH);
                b.setSmallIcon(Icon.createWithBitmap(bmp))
                    .setLargeIcon(bmp)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setStyle(new Notification.BigTextStyle().bigText(body))
                    .setContentIntent(pi)
                    .setAutoCancel(true);
                nm.notify(9299, b.build());
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void vibrateTick() {
            try {
                Vibrator vib = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
                if (vib != null && vib.hasVibrator()) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        vib.vibrate(VibrationEffect.createOneShot(22, VibrationEffect.DEFAULT_AMPLITUDE));
                    } else {
                        vib.vibrate(22);
                    }
                }
            } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public void setSystemTheme(boolean isNight) {
            applySystemBarColors(isNight);
        }

        @JavascriptInterface
        public boolean isKeepAliveGranted() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                    return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
                }
            } catch (Exception ignored) {}
            return false;
        }

        @JavascriptInterface
        public void openKeepAliveSettings() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                    return;
                }
            } catch (Exception ignored) {}
            try {
                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + getPackageName()));
                startActivity(intent);
            } catch (Exception ignored) {}
        }
    }
}
