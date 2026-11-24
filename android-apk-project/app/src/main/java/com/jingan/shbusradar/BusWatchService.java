package com.jingan.shbusradar;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class BusWatchService extends Service {
    public static final String ACTION_START_WATCH = "com.jingan.shbusradar.ACTION_START_WATCH";
    public static final String ACTION_STOP_WATCH = "com.jingan.shbusradar.ACTION_STOP_WATCH";

    public static final String CHANNEL_WATCH_ONGOING = "sh_bus_watch_ongoing";
    public static final String CHANNEL_ARRIVAL_ALERT = "sh_bus_arrival_alert";

    private static final int WATCH_NOTIFY_ID = 9201;
    private static final int ALERT_NOTIFY_ID = 9202;

    private static volatile boolean isWatching = false;
    private static volatile String watchedKey = "";
    private static volatile String watchedCityId = "034";
    private static volatile String watchedLineId = "";
    private static volatile String watchedLineName = "";
    private static volatile String watchedDirection = "0";
    private static volatile String watchedEndSn = "";
    private static volatile String watchedStationId = "";
    private static volatile String watchedStationName = "";
    private static volatile String watchedNextStationName = "";
    private static volatile String watchedLineNo = "";
    private static volatile int watchedTargetOrder = 1;
    private static volatile int alertStopsThreshold = 2;
    private static volatile int alertMinutesThreshold = 3;
    private static volatile boolean nightDndEnabled = true;
    private static volatile boolean hasTriggeredArrivalAlert = false;
    private static volatile long arrivedTimestampMs = 0L;
    private static volatile String latestStatusSummary = "正在连接实时公交信号…";

    private Handler handler;
    private ExecutorService pollExecutor;

    public static JSONObject getCurrentWatchStateJson() {
        JSONObject obj = new JSONObject();
        try {
            obj.put("active", isWatching);
            obj.put("watchKey", watchedKey);
            obj.put("lineId", watchedLineId);
            obj.put("lineName", watchedLineName);
            obj.put("endSn", watchedEndSn);
            obj.put("stationId", watchedStationId);
            obj.put("stationName", watchedStationName);
            obj.put("targetOrder", watchedTargetOrder);
            obj.put("alertStops", alertStopsThreshold);
            obj.put("alertMinutes", alertMinutesThreshold);
            obj.put("alerted", hasTriggeredArrivalAlert);
            obj.put("summary", latestStatusSummary);
        } catch (Exception ignored) {}
        return obj;
    }

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            if (!isWatching) return;
            if (pollExecutor != null && !pollExecutor.isShutdown()) {
                pollExecutor.execute(new Runnable() {
                    @Override
                    public void run() {
                        performSingleWatchPoll();
                    }
                });
            }
            if (handler != null && isWatching) {
                handler.postDelayed(this, 15000L);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannels(this);
        handler = new Handler(Looper.getMainLooper());
        pollExecutor = Executors.newSingleThreadExecutor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopWatchingInternal();
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_STOP_WATCH.equals(action)) {
            stopWatchingInternal();
            MainActivity.notifyWebWatchStateChanged();
            return START_NOT_STICKY;
        }

        if (ACTION_START_WATCH.equals(action)) {
            watchedKey = intent.getStringExtra("watchKey") != null ? intent.getStringExtra("watchKey") : "";
            watchedCityId = intent.getStringExtra("cityId") != null && !intent.getStringExtra("cityId").isEmpty()
                ? intent.getStringExtra("cityId") : "034";
            watchedLineId = intent.getStringExtra("lineId") != null ? intent.getStringExtra("lineId") : "";
            watchedLineName = intent.getStringExtra("lineName") != null ? intent.getStringExtra("lineName") : "";
            watchedDirection = intent.getStringExtra("direction") != null ? intent.getStringExtra("direction") : "0";
            watchedEndSn = intent.getStringExtra("endSn") != null ? intent.getStringExtra("endSn") : "";
            watchedStationId = intent.getStringExtra("stationId") != null ? intent.getStringExtra("stationId") : "";
            watchedStationName = intent.getStringExtra("stationName") != null ? intent.getStringExtra("stationName") : "";
            watchedNextStationName = intent.getStringExtra("nextStationName") != null ? intent.getStringExtra("nextStationName") : "";
            watchedLineNo = intent.getStringExtra("lineNo") != null ? intent.getStringExtra("lineNo") : "";
            watchedTargetOrder = intent.getIntExtra("targetOrder", 1);
            alertStopsThreshold = Math.max(1, intent.getIntExtra("alertStops", 2));
            alertMinutesThreshold = Math.max(1, intent.getIntExtra("alertMinutes", 3));
            nightDndEnabled = intent.getBooleanExtra("nightDnd", true);

            isWatching = true;
            hasTriggeredArrivalAlert = false;
            arrivedTimestampMs = 0L;
            latestStatusSummary = "盯梢已开启 · 正在获取最近班次位置…";

            Notification ongoing = buildOngoingNotification(
                formatRouteTitle() + " · 候车：" + watchedStationName,
                latestStatusSummary
            );
            startForeground(WATCH_NOTIFY_ID, ongoing);

            handler.removeCallbacks(pollRunnable);
            handler.post(pollRunnable);
            MainActivity.notifyWebWatchStateChanged();
            return START_STICKY;
        }

        return START_NOT_STICKY;
    }

    private String formatRouteTitle() {
        String name = watchedLineName;
        if (name != null && !name.endsWith("路") && !name.endsWith("线") && name.matches("^\\d+$")) {
            name = name + "路";
        }
        return name + (watchedEndSn.isEmpty() ? "" : (" → " + watchedEndSn));
    }

    private void performSingleWatchPoll() {
        if (!isWatching || watchedLineId.isEmpty()) return;
        try {
            String raw = BusApiClient.fetchLineDetailRaw(
                this,
                watchedCityId,
                watchedLineId,
                watchedLineName,
                watchedDirection,
                watchedStationName,
                watchedNextStationName,
                watchedLineNo,
                String.valueOf(watchedTargetOrder),
                watchedStationId
            );
            JSONObject resp = new JSONObject(raw);
            if (!resp.optBoolean("ok", false)) {
                updateOngoingText("网络波动重试中 · 每15秒自动刷新");
                return;
            }
            JSONObject data = resp.optJSONObject("data");
            if (data == null) return;

            JSONArray buses = data.optJSONArray("buses");
            JSONObject lineObj = data.optJSONObject("line");

            // 查找距离目标站最近且尚未过站 (order <= watchedTargetOrder) 的公交车
            JSONObject nearest = null;
            int bestStopsAway = Integer.MAX_VALUE;
            int bestTravelSec = Integer.MAX_VALUE;

            if (buses != null) {
                for (int i = 0; i < buses.length(); i++) {
                    JSONObject b = buses.getJSONObject(i);
                    int bOrder = b.optInt("specialOrder", b.optInt("order", 999));
                    if (bOrder > watchedTargetOrder) continue;

                    int bState = b.optInt("state", 0); // 1=已到该站, 0=开往该站途中
                    int stopsAway = watchedTargetOrder - bOrder + (bState == 0 ? 1 : 0);
                    if (bOrder == watchedTargetOrder && bState == 1) {
                        stopsAway = 0;
                    }

                    int travelSec = -1;
                    JSONArray travels = b.optJSONArray("travels");
                    if (travels != null && travels.length() > 0) {
                        travelSec = travels.getJSONObject(0).optInt("travelTime", -1);
                    }
                    int effectiveSec = travelSec >= 0 ? travelSec : (stopsAway * 150);

                    if (stopsAway < bestStopsAway || (stopsAway == bestStopsAway && effectiveSec < bestTravelSec)) {
                        bestStopsAway = stopsAway;
                        bestTravelSec = effectiveSec;
                        nearest = b;
                    }
                }
            }

            if (nearest != null) {
                int distM = nearest.optInt("distanceToWaitStn", -1);
                if (distM < 0) distM = nearest.optInt("distanceToSc", -1);
                int etaMin = Math.max(0, (int) Math.round(bestTravelSec / 60.0));

                String distText = distM > 0 ? (distM >= 1000
                    ? String.format(java.util.Locale.US, "%.1f公里", distM / 1000.0)
                    : (distM + "米")) : "";

                String statusLine;
                if (bestStopsAway == 0 || bestTravelSec <= 45) {
                    statusLine = "车辆即将进站" + (distText.isEmpty() ? "" : (" (" + distText + ")")) + " · 请留意来车";
                } else {
                    statusLine = "还有 " + bestStopsAway + " 站 · 约 " + Math.max(1, etaMin) + " 分钟"
                        + (distText.isEmpty() ? "" : (" · " + distText));
                }
                latestStatusSummary = statusLine;
                updateOngoingText(statusLine + (hasTriggeredArrivalAlert ? " [已提醒]" : " · 每15秒刷新"));

                boolean shouldAlert = (bestStopsAway <= alertStopsThreshold) || (etaMin <= alertMinutesThreshold);
                if (shouldAlert && !hasTriggeredArrivalAlert) {
                    hasTriggeredArrivalAlert = true;
                    fireArrivalAlertNotification(statusLine);
                }

                if (bestStopsAway == 0) {
                    if (arrivedTimestampMs == 0L) {
                        arrivedTimestampMs = System.currentTimeMillis();
                    } else if (System.currentTimeMillis() - arrivedTimestampMs > 150000L) {
                        // 车辆到站超过 2.5 分钟后自动结束盯梢，避免后台遗留耗电
                        handler.post(new Runnable() {
                            @Override
                            public void run() {
                                stopWatchingInternal();
                                MainActivity.notifyWebWatchStateChanged();
                            }
                        });
                        return;
                    }
                }
            } else {
                String desc = lineObj != null ? lineObj.optString("desc", "暂未发车") : "暂未发车";
                String depDesc = data.optString("depDesc", "");
                latestStatusSummary = (desc.isEmpty() ? "等待首站发车" : desc)
                    + (depDesc.isEmpty() ? "" : (" · " + depDesc));
                updateOngoingText(latestStatusSummary);
            }

            MainActivity.notifyWebWatchStateChanged();
        } catch (Exception ignored) {}
    }

    private void updateOngoingText(String text) {
        if (!isWatching) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(WATCH_NOTIFY_ID, buildOngoingNotification(
                formatRouteTitle() + " · 候车：" + watchedStationName,
                text
            ));
        }
    }

    private void fireArrivalAlertNotification(String detailLine) {
        boolean silent = isNightDndNow();
        if (!silent) {
            triggerDoubleVibration(this);
        }

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent contentPi = PendingIntent.getActivity(
            this, 10, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, BusWatchService.class);
        stopIntent.setAction(ACTION_STOP_WATCH);
        PendingIntent stopPi = PendingIntent.getService(
            this, 11, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Bitmap bmp = BusApiClient.getNotificationBusIconBitmap();
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, silent ? CHANNEL_WATCH_ONGOING : CHANNEL_ARRIVAL_ALERT);
        } else {
            builder = new Notification.Builder(this);
            builder.setPriority(silent ? Notification.PRIORITY_LOW : Notification.PRIORITY_HIGH);
        }

        String title = formatRouteTitle() + " 快到站啦！";
        String body = "候车站「" + watchedStationName + "」：" + detailLine + "，请准备上车。";

        Notification.Action stopAction = new Notification.Action.Builder(
            Icon.createWithBitmap(bmp), "已上车/停止盯梢", stopPi
        ).build();

        builder.setSmallIcon(Icon.createWithBitmap(bmp))
            .setLargeIcon(bmp)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(contentPi)
            .addAction(stopAction)
            .setAutoCancel(true);

        nm.notify(ALERT_NOTIFY_ID, builder.build());
    }

    private Notification buildOngoingNotification(String title, String body) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent contentPi = PendingIntent.getActivity(
            this, 1, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, BusWatchService.class);
        stopIntent.setAction(ACTION_STOP_WATCH);
        PendingIntent stopPi = PendingIntent.getService(
            this, 2, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Bitmap bmp = BusApiClient.getNotificationBusIconBitmap();
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_WATCH_ONGOING);
        } else {
            builder = new Notification.Builder(this);
        }

        Notification.Action stopAction = new Notification.Action.Builder(
            Icon.createWithBitmap(bmp), "停止盯梢", stopPi
        ).build();

        builder.setSmallIcon(Icon.createWithBitmap(bmp))
            .setLargeIcon(bmp)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setOngoing(true)
            .setContentIntent(contentPi)
            .addAction(stopAction);

        return builder.build();
    }

    private boolean isNightDndNow() {
        if (!nightDndEnabled) return false;
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        return (hour >= 23 || hour < 7);
    }

    public static void triggerDoubleVibration(Context ctx) {
        try {
            Vibrator vib = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            if (vib == null || !vib.hasVibrator()) return;
            long[] pattern = new long[]{0, 260, 140, 320};
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib.vibrate(VibrationEffect.createWaveform(pattern, -1));
            } else {
                vib.vibrate(pattern, -1);
            }
        } catch (Exception ignored) {}
    }

    public static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            if (nm == null) return;

            NotificationChannel ongoing = new NotificationChannel(
                CHANNEL_WATCH_ONGOING,
                "等车实时盯梢状态栏",
                NotificationManager.IMPORTANCE_LOW
            );
            ongoing.setDescription("等车期间每15秒刷新剩余站数与预计分钟数，上车后可一键关闭");
            ongoing.enableVibration(false);
            ongoing.setSound(null, null);
            nm.createNotificationChannel(ongoing);

            NotificationChannel alert = new NotificationChannel(
                CHANNEL_ARRIVAL_ALERT,
                "公交快到站强提醒",
                NotificationManager.IMPORTANCE_HIGH
            );
            alert.setDescription("公交距离上车站小于设定站数或分钟数时震动弹窗提醒");
            alert.enableVibration(true);
            alert.setVibrationPattern(new long[]{0, 260, 140, 320});
            nm.createNotificationChannel(alert);
        }
    }

    private void stopWatchingInternal() {
        isWatching = false;
        watchedKey = "";
        latestStatusSummary = "未开启盯梢";
        if (handler != null) {
            handler.removeCallbacks(pollRunnable);
        }
        try {
            stopForeground(true);
        } catch (Exception ignored) {}
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.cancel(WATCH_NOTIFY_ID);
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        isWatching = false;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        if (pollExecutor != null) pollExecutor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
