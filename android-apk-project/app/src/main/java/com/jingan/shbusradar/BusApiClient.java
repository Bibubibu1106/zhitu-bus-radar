package com.jingan.shbusradar;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.location.Address;
import android.location.Geocoder;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.zip.GZIPInputStream;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

public class BusApiClient {
    private static final String BASE_API = "https://web.chelaile.net.cn/api/";
    private static final String SIGN_SALT = "qwihrnbtmj";
    private static final String AES_KEY = "422556651C7F7B2B5C266EED06068230";
    private static final String[] CHANNELS = new String[]{
        "webapp_alipay_fuwu",
        "webapp_meizu_map"
    };
    private static final String QWEATHER_HOST = "mk487vpakf.re.qweatherapi.com";
    private static final String QWEATHER_KEY = "cf7b27f979ec43d08e7d98792f2115c4";

    private static String cachedUserId = null;
    private static String cachedSubwayNetJson = null;
    private static Bitmap cachedBusIcon = null;

    public static synchronized String getUserId(Context ctx) {
        if (cachedUserId != null) return cachedUserId;
        if (ctx != null) {
            String saved = ctx.getSharedPreferences("sh_bus_prefs", Context.MODE_PRIVATE)
                .getString("che_uid", null);
            if (saved != null && !saved.isEmpty()) {
                cachedUserId = saved;
                return cachedUserId;
            }
        }
        String gen = "browser_" + Long.toString(System.currentTimeMillis(), 36) + "_"
            + UUID.randomUUID().toString().replace("-", "").substring(0, 4);
        cachedUserId = gen;
        if (ctx != null) {
            ctx.getSharedPreferences("sh_bus_prefs", Context.MODE_PRIVATE)
                .edit().putString("che_uid", gen).apply();
        }
        return cachedUserId;
    }

    public static String dispatch(Context ctx, String action, String payloadJson) {
        try {
            JSONObject req = (payloadJson != null && !payloadJson.isEmpty())
                ? new JSONObject(payloadJson) : new JSONObject();
            String cityId = req.optString("cityId", "034");

            if ("search".equals(action)) {
                String keyword = req.optString("keyword", "").trim();
                int count = req.optInt("count", 12);
                LinkedHashMap<String, Object> params = new LinkedHashMap<>();
                params.put("key", keyword);
                params.put("count", String.valueOf(count));
                return executeWithFallback(ctx, cityId, "basesearch/client/clientSearch.action", params, null);
            }

            if ("lineDetail".equals(action)) {
                return fetchLineDetailRaw(
                    ctx,
                    cityId,
                    req.optString("lineId", ""),
                    req.optString("lineName", ""),
                    req.optString("direction", ""),
                    req.optString("stationName", ""),
                    req.optString("nextStationName", ""),
                    req.optString("lineNo", ""),
                    req.optString("targetOrder", ""),
                    req.optString("stationId", "")
                );
            }

            if ("nearlines".equals(action)) {
                double lat = req.optDouble("lat", 31.2335);
                double lng = req.optDouble("lng", 121.4542);
                boolean isGcj = req.optBoolean("isGcj", false);
                double[] gcj = isGcj ? new double[]{lat, lng} : wgs84ToGcj02(lat, lng);

                LinkedHashMap<String, Object> signed = new LinkedHashMap<>();
                signed.put("cityState", "2");
                signed.put("cryptoSign", computeCryptoSign(signed));

                LinkedHashMap<String, String> extra = new LinkedHashMap<>();
                String latStr = String.format(Locale.US, "%.6f", gcj[0]);
                String lngStr = String.format(Locale.US, "%.6f", gcj[1]);
                extra.put("lat", latStr);
                extra.put("lng", lngStr);
                extra.put("geo_lat", latStr);
                extra.put("geo_lng", lngStr);
                extra.put("gpstype", "gcj");

                return executeWithFallback(ctx, cityId, "bus/stop!encryptedNearlines.action", signed, extra);
            }

            if ("stationDetail".equals(action)) {
                String stationId = req.optString("stationId", "");
                String destSId = req.optString("destSId", "-1");
                LinkedHashMap<String, Object> signed = new LinkedHashMap<>();
                signed.put("stationId", stationId);
                signed.put("destSId", destSId.isEmpty() ? "-1" : destSId);
                signed.put("cryptoSign", computeCryptoSign(signed));
                return executeWithFallback(ctx, cityId, "bus/stop!encryptedStnDetail.action", signed, null);
            }

            if ("timetable".equals(action)) {
                String lineId = req.optString("lineId", "");
                LinkedHashMap<String, Object> params = new LinkedHashMap<>();
                params.put("lineId", lineId);
                return executeWithFallback(ctx, cityId, "bus/line!depTimeTable.action", params, null);
            }

            if ("subwayStation".equals(action)) {
                String stationId = req.optString("stationId", "");
                LinkedHashMap<String, Object> params = new LinkedHashMap<>();
                params.put("stationId", stationId);
                return executeWithFallback(ctx, cityId, "subwayNew/client/stationInfo.action", params, null);
            }

            if ("subwayLines".equals(action)) {
                return fetchShanghaiSubwayNetwork(ctx);
            }

            if ("cityList".equals(action)) {
                return fetchNationwideCityList(ctx, req);
            }

            if ("geocode".equals(action)) {
                String query = req.optString("query", "").trim();
                String cityName = req.optString("cityName", "上海").trim();
                return geocodeLocation(ctx, cityName, query);
            }

            JSONObject err = new JSONObject();
            err.put("ok", false);
            err.put("error", "Unknown action: " + action);
            return err.toString();
        } catch (Exception e) {
            try {
                JSONObject err = new JSONObject();
                err.put("ok", false);
                err.put("error", e.getMessage() != null ? e.getMessage() : "Dispatch error");
                return err.toString();
            } catch (Exception ignored) {
                return "{\"ok\":false,\"error\":\"Dispatch exception\"}";
            }
        }
    }

    public static String fetchLineDetailRaw(
        Context ctx,
        String cityId,
        String lineId,
        String lineName,
        String direction,
        String stationName,
        String nextStationName,
        String lineNo,
        String targetOrder,
        String stationId
    ) {
        LinkedHashMap<String, Object> signed = new LinkedHashMap<>();
        if (lineId != null && !lineId.isEmpty()) signed.put("lineId", lineId);
        if (lineName != null && !lineName.isEmpty()) signed.put("lineName", lineName);
        if (direction != null && !direction.isEmpty()) signed.put("direction", direction);
        if (stationName != null && !stationName.isEmpty()) signed.put("stationName", stationName);
        if (nextStationName != null && !nextStationName.isEmpty()) signed.put("nextStationName", nextStationName);
        if (lineNo != null && !lineNo.isEmpty()) signed.put("lineNo", lineNo);
        if (targetOrder != null && !targetOrder.isEmpty()) signed.put("targetOrder", targetOrder);
        if (stationId != null && !stationId.isEmpty()) signed.put("stationId", stationId);
        signed.put("vc", 1000000);
        signed.put("hpGnv", "1");
        signed.put("cryptoSign", computeCryptoSign(signed));

        return executeWithFallback(ctx, cityId != null && !cityId.isEmpty() ? cityId : "034",
            "bus/line!encryptedLineDetail.action", signed, null);
    }

    private static String executeWithFallback(
        Context ctx,
        String cityId,
        String handler,
        LinkedHashMap<String, Object> dataParams,
        LinkedHashMap<String, String> extraQuery
    ) {
        String lastErr = "网络连接超时";
        String uid = getUserId(ctx);

        for (String src : CHANNELS) {
            HttpURLConnection conn = null;
            try {
                LinkedHashMap<String, String> allQuery = new LinkedHashMap<>();
                for (Map.Entry<String, Object> entry : dataParams.entrySet()) {
                    allQuery.put(entry.getKey(), String.valueOf(entry.getValue()));
                }
                allQuery.put("s", "h5");
                allQuery.put("v", "3.3.21");
                if (!allQuery.containsKey("vc")) {
                    allQuery.put("vc", "1");
                }
                allQuery.put("src", src);
                allQuery.put("userId", uid);
                allQuery.put("h5Id", uid);
                allQuery.put("unionId", "");
                allQuery.put("sign", "1");
                allQuery.put("cityId", cityId);
                if (extraQuery != null) {
                    allQuery.putAll(extraQuery);
                }

                StringBuilder qs = new StringBuilder();
                boolean first = true;
                for (Map.Entry<String, String> q : allQuery.entrySet()) {
                    if (!first) qs.append("&");
                    first = false;
                    qs.append(URLEncoder.encode(q.getKey(), "UTF-8"))
                      .append("=")
                      .append(URLEncoder.encode(q.getValue(), "UTF-8"));
                }

                URL url = new URL(BASE_API + handler + "?" + qs.toString());
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(4500);
                conn.setReadTimeout(5000);
                conn.setRequestProperty("Referer", "https://web.chelaile.net.cn/ch5/?src=" + src);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36");
                conn.setRequestProperty("Accept", "*/*");

                int code = conn.getResponseCode();
                InputStream is = (code >= 200 && code < 400) ? conn.getInputStream() : conn.getErrorStream();
                if (is == null) {
                    lastErr = "HTTP " + code;
                    continue;
                }
                String encoding = conn.getContentEncoding();
                if (encoding != null && encoding.toLowerCase(Locale.US).contains("gzip")) {
                    is = new GZIPInputStream(is);
                }
                BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
                reader.close();

                String raw = sb.toString();
                int idx1 = raw.indexOf("**YGKJ");
                int idx2 = raw.indexOf("YGKJ##");
                if (idx1 >= 0 && idx2 > idx1) {
                    raw = raw.substring(idx1 + 6, idx2);
                }
                JSONObject root = new JSONObject(raw);
                JSONObject jsonr = root.optJSONObject("jsonr");
                if (jsonr == null) {
                    lastErr = "响应格式异常";
                    continue;
                }
                String status = jsonr.optString("status", "");
                if (!"00".equals(status)) {
                    lastErr = jsonr.optString("errmsg", "接口状态 " + status);
                    continue;
                }
                Object dataObj = jsonr.opt("data");
                JSONObject unwrapped;
                if (dataObj instanceof JSONObject && ((JSONObject) dataObj).has("encryptResult")) {
                    String enc = ((JSONObject) dataObj).optString("encryptResult", "");
                    String decStr = aesEcbDecrypt(enc);
                    unwrapped = new JSONObject(decStr);
                } else if (dataObj instanceof JSONObject) {
                    unwrapped = (JSONObject) dataObj;
                } else {
                    unwrapped = new JSONObject();
                }

                JSONObject resp = new JSONObject();
                resp.put("ok", true);
                resp.put("channel", src);
                resp.put("data", unwrapped);
                return resp.toString();
            } catch (Exception e) {
                lastErr = friendlyErrorMessage(e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        try {
            JSONObject fail = new JSONObject();
            fail.put("ok", false);
            fail.put("error", lastErr);
            return fail.toString();
        } catch (Exception ignored) {
            return "{\"ok\":false,\"error\":\"网络未连接\"}";
        }
    }

    private static String friendlyErrorMessage(Throwable e) {
        if (e == null) return "网络未连接";
        String name = e.getClass().getSimpleName().toLowerCase(Locale.US);
        String msg = e.getMessage() != null ? e.getMessage().toLowerCase(Locale.US) : "";
        if (name.contains("unknownhost") || msg.contains("unable to resolve host") || msg.contains("no address")) {
            return "当前网络未连接";
        }
        if (name.contains("timeout") || msg.contains("timed out") || msg.contains("timeout")) {
            return "网络响应超时";
        }
        if (name.contains("connect") || msg.contains("refused") || msg.contains("unreachable") || msg.contains("network")) {
            return "请检查网络连接";
        }
        return "网络暂不可用";
    }

    private static String computeCryptoSign(LinkedHashMap<String, Object> map) {
        StringBuilder inner = new StringBuilder();
        boolean first = true;
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            if (!first) inner.append(",");
            first = false;
            inner.append("\"").append(escapeJsonString(entry.getKey())).append("\":");
            Object v = entry.getValue();
            if (v instanceof Number || v instanceof Boolean) {
                inner.append(v.toString());
            } else {
                inner.append("\"").append(escapeJsonString(String.valueOf(v))).append("\"");
            }
        }
        String transformed = inner.toString()
            .replace(":", "=")
            .replace(",", "&") + SIGN_SALT;
        return md5Hex(transformed);
    }

    private static String escapeJsonString(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    public static String md5Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    public static String aesEcbDecrypt(String base64Cipher) throws Exception {
        byte[] keyBytes = AES_KEY.getBytes(StandardCharsets.UTF_8);
        SecretKeySpec keySpec = new SecretKeySpec(keyBytes, "AES");
        Cipher cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
        cipher.init(Cipher.DECRYPT_MODE, keySpec);
        byte[] encrypted = Base64.decode(base64Cipher, Base64.DEFAULT);
        byte[] decrypted = cipher.doFinal(encrypted);
        return new String(decrypted, StandardCharsets.UTF_8);
    }

    /**
     * 标准 WGS-84 (手机 GPS) 转 GCJ-02 (国测局火星坐标，适配上海公交站牌精准距离)
     */
    public static double[] wgs84ToGcj02(double wgLat, double wgLon) {
        if (wgLon < 72.004 || wgLon > 137.8347 || wgLat < 0.8293 || wgLat > 55.8271) {
            return new double[]{wgLat, wgLon};
        }
        double a = 6378245.0;
        double ee = 0.00669342162296594323;
        double dLat = transformLat(wgLon - 105.0, wgLat - 35.0);
        double dLon = transformLon(wgLon - 105.0, wgLat - 35.0);
        double radLat = wgLat / 180.0 * Math.PI;
        double magic = Math.sin(radLat);
        magic = 1 - ee * magic * magic;
        double sqrtMagic = Math.sqrt(magic);
        dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
        dLon = (dLon * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
        return new double[]{wgLat + dLat, wgLon + dLon};
    }

    private static double transformLat(double x, double y) {
        double ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
        return ret;
    }

    private static double transformLon(double x, double y) {
        double ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
        ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
        return ret;
    }

    private static String fetchShanghaiSubwayNetwork(Context ctx) {
        if (cachedSubwayNetJson != null && !cachedSubwayNetJson.isEmpty()) {
            return cachedSubwayNetJson;
        }
        HttpURLConnection conn = null;
        try {
            URL url = new URL("https://web.chelaile.net.cn/metro/subway/034/034.87c538d6.json");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4500);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("Referer", "https://web.chelaile.net.cn/ch5/?src=webapp_meizu_map");
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile)");
            InputStream is = conn.getInputStream();
            if (conn.getContentEncoding() != null && conn.getContentEncoding().toLowerCase(Locale.US).contains("gzip")) {
                is = new GZIPInputStream(is);
            }
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            JSONObject data = new JSONObject(sb.toString());
            JSONObject resp = new JSONObject();
            resp.put("ok", true);
            resp.put("data", data);
            cachedSubwayNetJson = resp.toString();
            return cachedSubwayNetJson;
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"地铁线网加载失败\"}";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String fetchNationwideCityList(Context ctx, JSONObject req) {
        HttpURLConnection conn = null;
        try {
            StringBuilder u = new StringBuilder("https://web.chelaile.net.cn/wwd/ncitylist?src=webapp_alipay_fuwu&s=h5&v=3.3.21");
            if (req.has("lat") && req.has("lng")) {
                double lat = req.optDouble("lat", 31.2335);
                double lng = req.optDouble("lng", 121.4542);
                boolean isGcj = req.optBoolean("isGcj", false);
                double[] gcj = isGcj ? new double[]{lat, lng} : wgs84ToGcj02(lat, lng);
                String latStr = String.format(Locale.US, "%.6f", gcj[0]);
                String lngStr = String.format(Locale.US, "%.6f", gcj[1]);
                u.append("&lat=").append(latStr)
                 .append("&lng=").append(lngStr)
                 .append("&geo_lat=").append(latStr)
                 .append("&geo_lng=").append(lngStr)
                 .append("&gpstype=gcj");
            }
            conn = (HttpURLConnection) new URL(u.toString()).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4500);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("Referer", "https://web.chelaile.net.cn/ch5/?src=webapp_alipay_fuwu");
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14; Mobile)");
            InputStream is = conn.getInputStream();
            if (conn.getContentEncoding() != null && conn.getContentEncoding().toLowerCase(Locale.US).contains("gzip")) {
                is = new GZIPInputStream(is);
            }
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();

            String raw = sb.toString();
            int idx1 = raw.indexOf("**YGKJ");
            int idx2 = raw.indexOf("YGKJ##");
            if (idx1 >= 0 && idx2 > idx1) {
                raw = raw.substring(idx1 + 6, idx2);
            }
            JSONObject root = new JSONObject(raw);
            JSONObject data = root.optJSONObject("data");
            if (data == null && root.has("jsonr")) {
                data = root.optJSONObject("jsonr").optJSONObject("data");
            }
            JSONObject resp = new JSONObject();
            resp.put("ok", true);
            resp.put("data", data != null ? data : new JSONObject());
            return resp.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"" + friendlyErrorMessage(e) + "\"}";
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String geocodeLocation(Context ctx, String cityName, String query) {
        JSONArray arr = new JSONArray();
        if (query == null || query.isEmpty()) return "{\"ok\":true,\"data\":[]}";
        String cleanCity = (cityName == null || cityName.isEmpty()) ? "上海" : cityName.replace("市", "");
        String fullQuery = query.contains(cleanCity) ? query : (cleanCity + "市" + query);

        try {
            if (ctx != null) {
                Geocoder geocoder = new Geocoder(ctx, Locale.CHINA);
                List<Address> list = geocoder.getFromLocationName(fullQuery, 5);
                if (list != null) {
                    for (Address a : list) {
                        if (a.hasLatitude() && a.hasLongitude()) {
                            JSONObject item = new JSONObject();
                            String sub = a.getSubLocality() != null ? a.getSubLocality() : "";
                            String feat = a.getFeatureName() != null ? a.getFeatureName() : query;
                            item.put("name", (sub + " " + feat).trim());
                            item.put("detail", a.getAddressLine(0) != null ? a.getAddressLine(0) : fullQuery);
                            item.put("lat", a.getLatitude());
                            item.put("lng", a.getLongitude());
                            item.put("isGcj", false);
                            arr.put(item);
                        }
                    }
                }
            }
        } catch (Exception ignored) {}

        if (arr.length() == 0) {
            HttpURLConnection conn = null;
            try {
                String u = "https://" + QWEATHER_HOST + "/geo/v2/city/lookup?location="
                    + URLEncoder.encode(query, "UTF-8") + "&adm=" + URLEncoder.encode(cleanCity, "UTF-8")
                    + "&range=cn&key=" + QWEATHER_KEY;
                conn = (HttpURLConnection) new URL(u).openConnection();
                conn.setConnectTimeout(3500);
                conn.setReadTimeout(3500);
                InputStream is = conn.getInputStream();
                if (conn.getContentEncoding() != null && conn.getContentEncoding().toLowerCase(Locale.US).contains("gzip")) {
                    is = new GZIPInputStream(is);
                }
                BufferedReader r = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                String ln;
                while ((ln = r.readLine()) != null) sb.append(ln);
                r.close();
                JSONObject qj = new JSONObject(sb.toString());
                JSONArray locs = qj.optJSONArray("location");
                if (locs != null) {
                    for (int i = 0; i < locs.length(); i++) {
                        JSONObject l = locs.getJSONObject(i);
                        JSONObject item = new JSONObject();
                        item.put("name", l.optString("adm2", "") + l.optString("name", query));
                        item.put("detail", l.optString("adm1", cleanCity) + " " + l.optString("adm2", "") + " " + l.optString("name", ""));
                        item.put("lat", Double.parseDouble(l.optString("lat", "31.2335")));
                        item.put("lng", Double.parseDouble(l.optString("lon", "121.4542")));
                        item.put("isGcj", false);
                        arr.put(item);
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        try {
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("data", arr);
            return out.toString();
        } catch (Exception e) {
            return "{\"ok\":true,\"data\":[]}";
        }
    }

    public static synchronized Bitmap getNotificationBusIconBitmap() {
        if (cachedBusIcon != null) return cachedBusIcon;
        int size = 192;
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        // 都市蔚蓝圆角渐变底板
        LinearGradient grad = new LinearGradient(
            0, 0, size, size,
            new int[]{Color.parseColor("#60A5FA"), Color.parseColor("#2563EB")},
            null,
            Shader.TileMode.CLAMP
        );
        p.setShader(grad);
        canvas.drawRoundRect(new RectF(0, 0, size, size), 44f, 44f, p);
        p.setShader(null);

        // 右上方柠檬暖黄信号圆点
        p.setColor(Color.parseColor("#FEF08A"));
        canvas.drawCircle(142f, 40f, 15f, p);
        p.setColor(Color.parseColor("#FACC15"));
        canvas.drawCircle(142f, 40f, 9f, p);

        // 极简圆润奶油白巴士车身
        p.setColor(Color.WHITE);
        canvas.drawRoundRect(new RectF(36f, 48f, 156f, 144f), 22f, 22f, p);

        // 柠檬黄线路牌
        p.setColor(Color.parseColor("#F59E0B"));
        canvas.drawRoundRect(new RectF(72f, 57f, 120f, 69f), 6f, 6f, p);

        // 都市蔚蓝前挡风窗
        p.setColor(Color.parseColor("#2563EB"));
        canvas.drawRoundRect(new RectF(50f, 77f, 142f, 112f), 10f, 10f, p);

        // 柠檬黄前车灯
        p.setColor(Color.parseColor("#FACC15"));
        canvas.drawCircle(60f, 128f, 7.5f, p);
        canvas.drawCircle(132f, 128f, 7.5f, p);

        // 轮胎
        p.setColor(Color.parseColor("#334155"));
        canvas.drawRoundRect(new RectF(50f, 142f, 70f, 156f), 6f, 6f, p);
        canvas.drawRoundRect(new RectF(122f, 142f, 142f, 156f), 6f, 6f, p);

        cachedBusIcon = bmp;
        return bmp;
    }
}
