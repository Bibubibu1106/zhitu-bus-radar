// 申城实时公交 - 默认常驻配置、状态持久化与原生桥接通信层
(function () {
  const STORAGE_KEY = "sh_bus_radar_v3_state";

  // 默认初始城市与定位中心（支持切换全国 480+ 城市，每条常用路线独立保存所属 cityId）
  const DEFAULT_CITY = {
    cityId: "034",
    cityName: "上海"
  };

  const DEFAULT_LOCATION = {
    name: "静安区陕西北路",
    lat: 31.2335,
    lng: 121.4542,
    isGcj: false
  };

  // 不预先内置任何常用看板站点，由用户自行按站点添加
  const DEFAULT_FAVORITES = [];

  const HOT_CITIES = [
    { cityId: "034", cityName: "上海", pinyin: "shanghai", spotName: "静安区陕西北路", lat: 31.2335, lng: 121.4542 },
    { cityId: "027", cityName: "北京", pinyin: "beijing", spotName: "东城区王府井", lat: 39.9139, lng: 116.4117 },
    { cityId: "004", cityName: "杭州", pinyin: "hangzhou", spotName: "西湖区延安路", lat: 30.2592, lng: 120.1653 },
    { cityId: "011", cityName: "苏州", pinyin: "suzhou", spotName: "姑苏区观前街", lat: 31.3127, lng: 120.6258 },
    { cityId: "018", cityName: "南京", pinyin: "nanjing", spotName: "秦淮区新街口", lat: 32.0415, lng: 118.7841 },
    { cityId: "040", cityName: "广州", pinyin: "guangzhou", spotName: "天河区体育西路", lat: 23.1317, lng: 113.3214 },
    { cityId: "007", cityName: "成都", pinyin: "chengdu", spotName: "锦江区春熙路", lat: 30.6562, lng: 104.0818 },
    { cityId: "000", cityName: "武汉", pinyin: "wuhan", spotName: "江汉区江汉路", lat: 30.5792, lng: 114.2877 },
    { cityId: "003", cityName: "重庆", pinyin: "chongqing", spotName: "渝中区解放碑", lat: 29.5573, lng: 106.5771 },
    { cityId: "054", cityName: "无锡", pinyin: "wuxi", spotName: "梁溪区三阳广场", lat: 31.5762, lng: 120.3014 },
    { cityId: "045", cityName: "宁波", pinyin: "ningbo", spotName: "海曙区天一广场", lat: 29.8732, lng: 121.5518 },
    { cityId: "076", cityName: "西安", pinyin: "xian", spotName: "碑林区钟楼", lat: 34.2594, lng: 108.9470 },
    { cityId: "066", cityName: "长沙", pinyin: "changsha", spotName: "芙蓉区五一广场", lat: 28.1953, lng: 112.9764 },
    { cityId: "009", cityName: "青岛", pinyin: "qingdao", spotName: "市南区五四广场", lat: 36.0642, lng: 120.3826 },
    { cityId: "006", cityName: "天津", pinyin: "tianjin", spotName: "和平区滨江道", lat: 39.1235, lng: 117.1981 },
    { cityId: "028", cityName: "合肥", pinyin: "hefei", spotName: "庐阳区淮河路步行街", lat: 31.8669, lng: 117.2892 },
    { cityId: "015", cityName: "郑州", pinyin: "zhengzhou", spotName: "二七区二七广场", lat: 34.7524, lng: 113.6654 },
    { cityId: "020", cityName: "福州", pinyin: "fuzhou", spotName: "鼓楼区东街口", lat: 26.0829, lng: 119.3001 },
    { cityId: "012", cityName: "济南", pinyin: "jinan", spotName: "历下区泉城广场", lat: 36.6612, lng: 117.0207 },
    { cityId: "022", cityName: "南昌", pinyin: "nanchang", spotName: "东湖区八一广场", lat: 28.6744, lng: 115.9042 }
  ];

  const SHANGHAI_PRESET_SPOTS = [
    { name: "静安区陕西北路", lat: 31.2335, lng: 121.4542, isGcj: false },
    { name: "静安寺", lat: 31.2238, lng: 121.4458, isGcj: false },
    { name: "人民广场", lat: 31.2304, lng: 121.4737, isGcj: false },
    { name: "徐家汇", lat: 31.1947, lng: 121.4379, isGcj: false },
    { name: "陆家嘴", lat: 31.2397, lng: 121.4998, isGcj: false }
  ];

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          city: parsed.city && parsed.city.cityId ? parsed.city : { ...DEFAULT_CITY },
          location: parsed.location || { ...DEFAULT_LOCATION },
          favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
          settings: Object.assign({
            alertStops: 2,
            alertMinutes: 3,
            autoRefreshSec: 15,
            nightDnd: true,
            themeMode: "auto" // auto | light | night
          }, parsed.settings || {})
        };
      }
    } catch (e) {}
    return {
      city: { ...DEFAULT_CITY },
      location: { ...DEFAULT_LOCATION },
      favorites: DEFAULT_FAVORITES.map(x => ({ ...x })),
      settings: {
        alertStops: 2,
        alertMinutes: 3,
        autoRefreshSec: 15,
        nightDnd: true,
        themeMode: "auto"
      }
    };
  }

  function saveState(st) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        city: st.city,
        location: st.location,
        favorites: st.favorites,
        settings: st.settings
      }));
    } catch (e) {}
  }

  // Native Bridge Async Promise Dispatcher
  let seq = 1;
  const pendingCalls = {};

  window.__onNativeApiCallback = function (reqId, resStr) {
    const entry = pendingCalls[reqId];
    if (!entry) return;
    delete pendingCalls[reqId];
    clearTimeout(entry.timer);
    try {
      entry.resolve(JSON.parse(resStr));
    } catch (e) {
      entry.resolve({ ok: false, error: "数据解析异常" });
    }
  };

  function callBusApi(action, payload) {
    return new Promise((resolve) => {
      const reqObj = Object.assign({}, payload || {});
      if (!reqObj.cityId && window.AppUI && typeof window.AppUI.getState === "function") {
        const st = window.AppUI.getState();
        if (st && st.city && st.city.cityId) {
          reqObj.cityId = st.city.cityId;
        }
        if (!reqObj.cityName && st && st.city && st.city.cityName) {
          reqObj.cityName = st.city.cityName;
        }
      }
      if (window.AndroidBridge && typeof window.AndroidBridge.callBusApiAsync === "function") {
        const reqId = "req_" + (seq++) + "_" + Date.now();
        const timer = setTimeout(() => {
          if (pendingCalls[reqId]) {
            delete pendingCalls[reqId];
            resolve({ ok: false, error: "请求超时，请检查网络" });
          }
        }, 9500);
        pendingCalls[reqId] = { resolve, timer };
        window.AndroidBridge.callBusApiAsync(reqId, action, JSON.stringify(reqObj));
      } else {
        resolve(buildBrowserPreviewFallback(action, reqObj));
      }
    });
  }

  function buildBrowserPreviewFallback(action, req) {
    if (action === "lineDetail") {
      const lid = req.lineId || "21283604817";
      const map = {
        "21283604817": {
          line: { lineId: "21283604817", lineNo: "r96669", name: "24", direction: 1, startSn: "长寿新村", endSn: "豆市街复兴东路", firstTime: "05:00", lastTime: "23:20", price: "2元" },
          otherlines: [{ lineId: "21283604816" }],
          stations: [
            { order: 1, sId: "021-1825", sn: "长寿新村", metros: [{ lineNo: "13" }, { lineNo: "7" }] },
            { order: 2, sId: "021-10", sn: "宜昌路西康路", metros: [{ lineNo: "3" }, { lineNo: "4" }, { lineNo: "7" }] },
            { order: 3, sId: "021-17138", sn: "陕西北路宜昌路", metros: [] },
            { order: 4, sId: "021-17139", sn: "陕西北路普陀路", metros: [{ lineNo: "13" }, { lineNo: "7" }] },
            { order: 5, sId: "021-8330", sn: "陕西北路安远路", metros: [{ lineNo: "13" }, { lineNo: "7" }] },
            { order: 6, sId: "021-5890", sn: "陕西北路海防路", metros: [] },
            { order: 7, sId: "021-8560", sn: "陕西北路新闸路", metros: [] },
            { order: 8, sId: "021-5707", sn: "陕西北路北京西路", metros: [] },
            { order: 9, sId: "021-3732", sn: "陕西北路南京西路", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "2" }] },
            { order: 10, sId: "021-5873", sn: "陕西南路延安中路", metros: [] },
            { order: 11, sId: "021-6133", sn: "陕西南路淮海中路", metros: [{ lineNo: "10" }, { lineNo: "12" }, { lineNo: "1" }] },
            { order: 12, sId: "021-729", sn: "陕西南路永嘉路", metros: [{ lineNo: "10" }] },
            { order: 13, sId: "021-7113", sn: "建国西路陕西南路", metros: [] },
            { order: 14, sId: "021-2577", sn: "建国中路瑞金二路", metros: [{ lineNo: "9" }] },
            { order: 15, sId: "021-3769", sn: "建国东路重庆南路", metros: [{ lineNo: "13" }, { lineNo: "9" }] },
            { order: 16, sId: "021-5704", sn: "建国东路肇周路", metros: [] },
            { order: 17, sId: "021-5189", sn: "建国新路西藏南路", metros: [{ lineNo: "10" }, { lineNo: "8" }, { lineNo: "9" }] },
            { order: 18, sId: "021-15452", sn: "老西门（复兴东路）", metros: [{ lineNo: "10" }, { lineNo: "8" }] },
            { order: 19, sId: "021-15496", sn: "复兴东路光启路（豫园）", metros: [] },
            { order: 20, sId: "021-6414", sn: "豆市街复兴东路", metros: [] }
          ],
          buses: [
            { busId: "b24_1", order: 8, specialOrder: 8, state: 0, distanceToWaitStn: 420, travels: [{ order: 9, travelTime: 135 }] },
            { busId: "b24_2", order: 5, specialOrder: 5, state: 1, distanceToWaitStn: 1680, travels: [{ order: 9, travelTime: 540 }] }
          ]
        },
        "21283604816": {
          line: { lineId: "21283604816", lineNo: "r96669", name: "24", direction: 0, startSn: "豆市街复兴东路", endSn: "长寿新村", firstTime: "05:00", lastTime: "23:00", price: "2元" },
          otherlines: [{ lineId: "21283604817" }],
          stations: [
            { order: 1, sId: "021-6414", sn: "豆市街复兴东路", metros: [] },
            { order: 2, sId: "021-15496", sn: "复兴东路光启路（豫园）", metros: [] },
            { order: 3, sId: "021-15452", sn: "老西门（复兴东路）", metros: [{ lineNo: "10" }, { lineNo: "8" }] },
            { order: 4, sId: "021-2435", sn: "复兴中路吉安路", metros: [{ lineNo: "10" }, { lineNo: "8" }] },
            { order: 5, sId: "021-8022", sn: "复兴中路黄陂南路", metros: [{ lineNo: "10" }, { lineNo: "13" }] },
            { order: 6, sId: "021-8218", sn: "复兴中路重庆南路", metros: [{ lineNo: "10" }, { lineNo: "13" }] },
            { order: 7, sId: "021-5494", sn: "瑞金二路复兴中路", metros: [] },
            { order: 8, sId: "021-7867", sn: "瑞金一路淮海中路", metros: [{ lineNo: "13" }, { lineNo: "1" }] },
            { order: 9, sId: "021-5386", sn: "瑞金一路延安中路", metros: [{ lineNo: "13" }] },
            { order: 10, sId: "021-5006", sn: "石门一路南京西路", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "2" }] },
            { order: 11, sId: "021-3466", sn: "南京西路陕西北路", metros: [] },
            { order: 12, sId: "021-2506", sn: "西康路新闸路", metros: [] },
            { order: 13, sId: "021-8373", sn: "西康路康定路", metros: [{ lineNo: "7" }] },
            { order: 14, sId: "021-8284", sn: "西康路海防路", metros: [] },
            { order: 15, sId: "021-6968", sn: "西康路长寿路", metros: [{ lineNo: "13" }, { lineNo: "7" }] },
            { order: 16, sId: "021-6859", sn: "澳门路常德路", metros: [{ lineNo: "13" }, { lineNo: "7" }] },
            { order: 17, sId: "021-1825", sn: "长寿新村", metros: [{ lineNo: "13" }, { lineNo: "7" }] }
          ],
          buses: [
            { busId: "b24_r1", order: 10, specialOrder: 10, state: 0, distanceToWaitStn: 680, travels: [{ order: 11, travelTime: 240 }] },
            { busId: "b24_r2", order: 7, specialOrder: 7, state: 1, distanceToWaitStn: 2450, travels: [{ order: 11, travelTime: 780 }] }
          ]
        },
        "21283605072": {
          line: { lineId: "21283605072", lineNo: "r96799", name: "20", direction: 0, startSn: "汉口路四川中路", endSn: "中山公园（万航渡路）", firstTime: "05:00", lastTime: "23:30", price: "2元" },
          otherlines: [{ lineId: "21283605071" }],
          stations: [
            { order: 1, sId: "021-5531", sn: "汉口路四川中路", metros: [{ lineNo: "10" }, { lineNo: "2" }] },
            { order: 2, sId: "021-5872", sn: "九江路江西中路", metros: [{ lineNo: "10" }, { lineNo: "2" }] },
            { order: 3, sId: "021-3498", sn: "九江路福建中路", metros: [{ lineNo: "10" }, { lineNo: "2" }] },
            { order: 4, sId: "021-6729", sn: "九江路黄河路", metros: [{ lineNo: "1" }, { lineNo: "2" }, { lineNo: "8" }] },
            { order: 5, sId: "021-8699", sn: "南京西路黄河路", metros: [{ lineNo: "1" }, { lineNo: "2" }, { lineNo: "8" }] },
            { order: 6, sId: "021-955", sn: "南京西路成都北路", metros: [{ lineNo: "2" }] },
            { order: 7, sId: "021-4384", sn: "上海电视台", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "2" }] },
            { order: 8, sId: "021-7830", sn: "南京西路石门一路", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "2" }] },
            { order: 9, sId: "021-3466", sn: "南京西路陕西北路", metros: [] },
            { order: 10, sId: "021-2076", sn: "静安寺", metros: [{ lineNo: "14" }, { lineNo: "2" }, { lineNo: "7" }] },
            { order: 11, sId: "021-1102", sn: "北京西路乌鲁木齐北路", metros: [{ lineNo: "14" }, { lineNo: "2" }] },
            { order: 12, sId: "021-3235", sn: "愚园路乌鲁木齐北路", metros: [{ lineNo: "14" }] },
            { order: 13, sId: "021-3894", sn: "愚园路镇宁路", metros: [{ lineNo: "11" }, { lineNo: "2" }] },
            { order: 14, sId: "021-3628", sn: "愚园路江苏路", metros: [{ lineNo: "11" }, { lineNo: "2" }] },
            { order: 15, sId: "021-5015", sn: "愚园路安西路", metros: [{ lineNo: "11" }] },
            { order: 16, sId: "021-4577", sn: "愚园路定西路", metros: [{ lineNo: "2" }] },
            { order: 17, sId: "021-15448", sn: "中山公园（长宁路）", metros: [{ lineNo: "2" }, { lineNo: "3" }, { lineNo: "4" }] },
            { order: 18, sId: "021-401", sn: "凯旋路汇川路", metros: [{ lineNo: "2" }, { lineNo: "3" }, { lineNo: "4" }] },
            { order: 19, sId: "021-15449", sn: "中山公园（万航渡路）", metros: [] }
          ],
          buses: [
            { busId: "b20_1", order: 9, specialOrder: 9, state: 1, distanceToWaitStn: 35, travels: [{ order: 9, travelTime: 20 }] },
            { busId: "b20_2", order: 6, specialOrder: 6, state: 0, distanceToWaitStn: 1520, travels: [{ order: 9, travelTime: 420 }] }
          ]
        },
        "21283605071": {
          line: { lineId: "21283605071", lineNo: "r96799", name: "20", direction: 1, startSn: "中山公园（万航渡路）", endSn: "汉口路四川中路", firstTime: "05:00", lastTime: "23:15", price: "2元" },
          otherlines: [{ lineId: "21283605072" }],
          stations: [
            { order: 1, sId: "021-15449", sn: "中山公园（万航渡路）", metros: [] },
            { order: 2, sId: "021-11102", sn: "华阳路长宁路", metros: [] },
            { order: 3, sId: "021-5015", sn: "愚园路安西路", metros: [{ lineNo: "11" }] },
            { order: 4, sId: "021-3628", sn: "愚园路江苏路", metros: [{ lineNo: "11" }, { lineNo: "2" }] },
            { order: 5, sId: "021-3894", sn: "愚园路镇宁路", metros: [{ lineNo: "2" }] },
            { order: 6, sId: "021-3235", sn: "愚园路乌鲁木齐北路", metros: [{ lineNo: "14" }] },
            { order: 7, sId: "021-2076", sn: "静安寺", metros: [{ lineNo: "14" }, { lineNo: "2" }, { lineNo: "7" }] },
            { order: 8, sId: "021-3466", sn: "南京西路陕西北路", metros: [] },
            { order: 9, sId: "021-4384", sn: "上海电视台", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "2" }] },
            { order: 10, sId: "021-955", sn: "南京西路成都北路", metros: [{ lineNo: "13" }] },
            { order: 11, sId: "021-8699", sn: "南京西路黄河路", metros: [{ lineNo: "1" }, { lineNo: "2" }, { lineNo: "8" }] },
            { order: 12, sId: "021-5667", sn: "九江路浙江中路", metros: [{ lineNo: "1" }, { lineNo: "8" }] },
            { order: 13, sId: "021-5531", sn: "汉口路四川中路", metros: [{ lineNo: "10" }, { lineNo: "2" }] }
          ],
          buses: [
            { busId: "b20_r1", order: 7, specialOrder: 7, state: 0, distanceToWaitStn: 510, travels: [{ order: 8, travelTime: 180 }] }
          ]
        },
        "21283604206": {
          line: { lineId: "21283604206", lineNo: "r96353", name: "41", direction: 1, startSn: "沪太新村", endSn: "龙恒东路龙华西路", firstTime: "05:00", lastTime: "23:10", price: "2元" },
          otherlines: [{ lineId: "21283604205" }],
          stations: [
            { order: 1, sId: "021-4425", sn: "沪太新村", metros: [] },
            { order: 2, sId: "021-1985", sn: "宜川路延长西路", metros: [] },
            { order: 3, sId: "021-5061", sn: "延长西路沪太路", metros: [] },
            { order: 4, sId: "021-145", sn: "沪太路华阴路", metros: [] },
            { order: 5, sId: "021-7336", sn: "沪太路中山北路", metros: [] },
            { order: 6, sId: "021-15410", sn: "恒丰路天目西路（上海火车站）", metros: [{ lineNo: "1" }] },
            { order: 7, sId: "021-4490", sn: "恒丰路汉中路", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "1" }] },
            { order: 8, sId: "021-200", sn: "石门二路山海关路", metros: [{ lineNo: "13" }, { lineNo: "2" }] },
            { order: 9, sId: "021-4420", sn: "北京西路泰兴路", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "2" }] },
            { order: 10, sId: "021-3732", sn: "陕西北路南京西路", metros: [{ lineNo: "12" }] },
            { order: 11, sId: "021-5873", sn: "陕西南路延安中路", metros: [] },
            { order: 12, sId: "021-6133", sn: "陕西南路淮海中路", metros: [{ lineNo: "10" }, { lineNo: "12" }, { lineNo: "1" }] },
            { order: 13, sId: "021-729", sn: "陕西南路永嘉路", metros: [{ lineNo: "10" }] },
            { order: 14, sId: "021-1161", sn: "陕西南路建国西路", metros: [{ lineNo: "12" }, { lineNo: "9" }] },
            { order: 15, sId: "021-3812", sn: "肇嘉浜路大木桥路", metros: [{ lineNo: "12" }, { lineNo: "9" }] },
            { order: 16, sId: "021-3635", sn: "瑞金南路斜土路", metros: [{ lineNo: "9" }] },
            { order: 17, sId: "021-2545", sn: "瑞金南路瞿溪路", metros: [] },
            { order: 18, sId: "021-791", sn: "中山南二路大木桥路", metros: [{ lineNo: "12" }, { lineNo: "4" }] },
            { order: 19, sId: "021-3406", sn: "中山南二路东安路", metros: [{ lineNo: "12" }, { lineNo: "4" }, { lineNo: "7" }] },
            { order: 20, sId: "021-8705", sn: "龙华路宛平南路", metros: [{ lineNo: "12" }, { lineNo: "7" }] },
            { order: 21, sId: "021-2175", sn: "龙华路华容路", metros: [{ lineNo: "11" }, { lineNo: "12" }] },
            { order: 22, sId: "021-24275", sn: "龙恒东路龙华西路", metros: [{ lineNo: "11" }, { lineNo: "12" }] }
          ],
          buses: [
            { busId: "b41_1", order: 8, specialOrder: 8, state: 0, distanceToWaitStn: 720, travels: [{ order: 10, travelTime: 240 }] },
            { busId: "b41_2", order: 5, specialOrder: 5, state: 1, distanceToWaitStn: 2100, travels: [{ order: 10, travelTime: 660 }] }
          ]
        },
        "21283604205": {
          line: { lineId: "21283604205", lineNo: "r96353", name: "41", direction: 0, startSn: "龙恒东路龙华西路", endSn: "沪太新村", firstTime: "05:00", lastTime: "23:10", price: "2元" },
          otherlines: [{ lineId: "21283604206" }],
          stations: [
            { order: 1, sId: "021-24275", sn: "龙恒东路龙华西路", metros: [{ lineNo: "11" }, { lineNo: "12" }] },
            { order: 2, sId: "021-8283", sn: "龙华", metros: [{ lineNo: "11" }, { lineNo: "12" }] },
            { order: 3, sId: "021-2175", sn: "龙华路华容路", metros: [{ lineNo: "12" }] },
            { order: 4, sId: "021-7746", sn: "宛平南路龙华路", metros: [{ lineNo: "12" }, { lineNo: "7" }] },
            { order: 5, sId: "021-3406", sn: "中山南二路东安路", metros: [{ lineNo: "12" }, { lineNo: "4" }, { lineNo: "7" }] },
            { order: 6, sId: "021-1458", sn: "中山南二路船厂路", metros: [] },
            { order: 7, sId: "021-791", sn: "中山南二路大木桥路", metros: [{ lineNo: "12" }, { lineNo: "4" }] },
            { order: 8, sId: "021-2545", sn: "瑞金南路瞿溪路", metros: [] },
            { order: 9, sId: "021-917", sn: "打浦桥", metros: [{ lineNo: "9" }] },
            { order: 10, sId: "021-1660", sn: "瑞金医院", metros: [{ lineNo: "9" }] },
            { order: 11, sId: "021-5494", sn: "瑞金二路复兴中路", metros: [] },
            { order: 12, sId: "021-7867", sn: "瑞金一路淮海中路", metros: [{ lineNo: "13" }, { lineNo: "1" }] },
            { order: 13, sId: "021-3613", sn: "石门一路延安中路", metros: [{ lineNo: "12" }, { lineNo: "13" }] },
            { order: 14, sId: "021-5006", sn: "石门一路南京西路", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "2" }] },
            { order: 15, sId: "021-200", sn: "石门二路山海关路", metros: [{ lineNo: "13" }] },
            { order: 16, sId: "021-4490", sn: "恒丰路汉中路", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "1" }] },
            { order: 17, sId: "021-7336", sn: "沪太路中山北路", metros: [] },
            { order: 18, sId: "021-6441", sn: "沪太路洛川中路", metros: [] },
            { order: 19, sId: "021-1586", sn: "沪太路新村路", metros: [] },
            { order: 20, sId: "021-4425", sn: "沪太新村", metros: [] }
          ],
          buses: [
            { busId: "b41_r1", order: 12, specialOrder: 12, state: 0, distanceToWaitStn: 640, travels: [{ order: 14, travelTime: 220 }] }
          ]
        },
        "21283604420": {
          line: { lineId: "21283604420", lineNo: "r96463", name: "104", direction: 1, startSn: "上海火车站（南广场）", endSn: "龙华", firstTime: "05:00", lastTime: "23:15", price: "2元" },
          otherlines: [{ lineId: "21283604421" }],
          stations: [
            { order: 1, sId: "021-15293", sn: "上海火车站（南广场）", metros: [{ lineNo: "1" }, { lineNo: "3" }, { lineNo: "4" }] },
            { order: 2, sId: "021-4490", sn: "恒丰路汉中路", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "1" }] },
            { order: 3, sId: "021-2972", sn: "新闸路泰兴路", metros: [{ lineNo: "13" }, { lineNo: "2" }] },
            { order: 4, sId: "021-71", sn: "新闸路江宁路", metros: [] },
            { order: 5, sId: "021-5707", sn: "陕西北路北京西路", metros: [] },
            { order: 6, sId: "021-3732", sn: "陕西北路南京西路", metros: [{ lineNo: "12" }] },
            { order: 7, sId: "021-5873", sn: "陕西南路延安中路", metros: [] },
            { order: 8, sId: "021-6133", sn: "陕西南路淮海中路", metros: [{ lineNo: "1" }, { lineNo: "10" }, { lineNo: "12" }] },
            { order: 9, sId: "021-729", sn: "陕西南路永嘉路", metros: [{ lineNo: "10" }] },
            { order: 10, sId: "021-3812", sn: "肇嘉浜路大木桥路", metros: [{ lineNo: "12" }, { lineNo: "9" }] },
            { order: 11, sId: "021-4922", sn: "小木桥路斜土路", metros: [] },
            { order: 12, sId: "021-8753", sn: "小木桥路中山南二路", metros: [{ lineNo: "12" }, { lineNo: "4" }] },
            { order: 13, sId: "021-3406", sn: "中山南二路东安路", metros: [{ lineNo: "12" }, { lineNo: "4" }, { lineNo: "7" }] },
            { order: 14, sId: "021-7054", sn: "中山南二路宛平南路", metros: [] },
            { order: 15, sId: "021-872", sn: "上海游泳馆", metros: [{ lineNo: "11" }, { lineNo: "3" }] },
            { order: 16, sId: "021-8283", sn: "龙华", metros: [{ lineNo: "12" }] }
          ],
          buses: [
            { busId: "b104_1", order: 4, specialOrder: 4, state: 0, distanceToWaitStn: 890, travels: [{ order: 6, travelTime: 300 }] }
          ]
        },
        "21283604421": {
          line: { lineId: "21283604421", lineNo: "r96463", name: "104", direction: 0, startSn: "龙华", endSn: "上海火车站（南广场）", firstTime: "05:00", lastTime: "23:15", price: "2元" },
          otherlines: [{ lineId: "21283604420" }],
          stations: [
            { order: 1, sId: "021-8283", sn: "龙华", metros: [{ lineNo: "12" }] },
            { order: 2, sId: "021-476", sn: "天钥桥路中山南二路", metros: [{ lineNo: "11" }] },
            { order: 3, sId: "021-3406", sn: "中山南二路东安路", metros: [{ lineNo: "12" }, { lineNo: "4" }, { lineNo: "7" }] },
            { order: 4, sId: "021-1458", sn: "中山南二路船厂路", metros: [] },
            { order: 5, sId: "021-5566", sn: "大木桥路中山南二路", metros: [{ lineNo: "12" }, { lineNo: "4" }] },
            { order: 6, sId: "021-4795", sn: "大木桥路斜土路", metros: [{ lineNo: "12" }, { lineNo: "4" }] },
            { order: 7, sId: "021-3812", sn: "肇嘉浜路大木桥路", metros: [{ lineNo: "12" }, { lineNo: "9" }] },
            { order: 8, sId: "021-1660", sn: "瑞金医院", metros: [{ lineNo: "9" }] },
            { order: 9, sId: "021-7867", sn: "瑞金一路淮海中路", metros: [{ lineNo: "13" }, { lineNo: "1" }] },
            { order: 10, sId: "021-3613", sn: "石门一路延安中路", metros: [{ lineNo: "12" }, { lineNo: "13" }] },
            { order: 11, sId: "021-200", sn: "石门二路山海关路", metros: [{ lineNo: "13" }] },
            { order: 12, sId: "021-4490", sn: "恒丰路汉中路", metros: [{ lineNo: "12" }, { lineNo: "13" }, { lineNo: "1" }] },
            { order: 13, sId: "021-15293", sn: "上海火车站（南广场）", metros: [{ lineNo: "1" }, { lineNo: "3" }, { lineNo: "4" }] }
          ],
          buses: [
            { busId: "b104_r1", order: 9, specialOrder: 9, state: 0, distanceToWaitStn: 480, travels: [{ order: 10, travelTime: 180 }] }
          ]
        },
        "21283604093": {
          line: { lineId: "21283604093", lineNo: "r96294", name: "206", direction: 0, startSn: "西康路南京西路", endSn: "临汾路阳泉路（彭浦新村）", firstTime: "05:05", lastTime: "22:30", price: "2元" },
          otherlines: [{ lineId: "21283604094" }],
          stations: [
            { order: 1, sId: "021-8966", sn: "西康路南京西路", metros: [] },
            { order: 2, sId: "021-2506", sn: "西康路新闸路", metros: [] },
            { order: 3, sId: "021-8374", sn: "江宁路海防路", metros: [] }
          ],
          buses: [
            { busId: "b206_1", order: 1, specialOrder: 1, state: 0, distanceToWaitStn: 310, travels: [{ order: 1, travelTime: 180 }] }
          ]
        },
        "21283604966": {
          line: { lineId: "21283604966", lineNo: "r96745", name: "37", direction: 0, startSn: "扬州路齐齐哈尔路", endSn: "愚园路胶州路", firstTime: "05:30", lastTime: "23:00", price: "2元" },
          otherlines: [{ lineId: "21283604967" }],
          stations: [
            { order: 15, sId: "021-7830", sn: "南京西路石门一路", metros: [{ lineNo: "2" }, { lineNo: "12" }, { lineNo: "13" }] },
            { order: 16, sId: "021-3466", sn: "南京西路陕西北路", metros: [] },
            { order: 17, sId: "021-2076", sn: "静安寺", metros: [{ lineNo: "2" }, { lineNo: "7" }] }
          ],
          buses: [
            { busId: "b37_1", order: 14, specialOrder: 14, state: 0, distanceToWaitStn: 980, travels: [{ order: 16, travelTime: 310 }] }
          ]
        }
      };
      return { ok: true, data: map[lid] || map["21283604817"] };
    }
    if (action === "nearlines") {
      return {
        ok: true,
        data: {
          nearLines: [
            {
              sn: "陕西北路南京西路", sId: "021-3732", distance: 86,
              lines: [
                { line: { lineId: "21283604817", name: "24", endSn: "豆市街复兴东路" }, stnStates: [{ value: 1, travelTime: 135, distanceToDest: 420 }] },
                { line: { lineId: "21283604120", name: "104", endSn: "上海火车站（南广场）" }, stnStates: [{ value: 2, travelTime: 300, distanceToDest: 920 }] }
              ]
            },
            {
              sn: "南京西路陕西北路", sId: "021-3466", distance: 142,
              lines: [
                { line: { lineId: "21283605072", name: "20", endSn: "中山公园（万航渡路）" }, stnStates: [{ value: 0, travelTime: 25, distanceToDest: 35 }] },
                { line: { lineId: "21283604816", name: "24", endSn: "长寿新村" }, stnStates: [{ value: 1, travelTime: 240, distanceToDest: 680 }] },
                { line: { lineId: "21283604966", name: "37", endSn: "愚园路胶州路" }, stnStates: [{ value: 2, travelTime: 310, distanceToDest: 980 }] }
              ]
            }
          ]
        }
      };
    }
    if (action === "timetable") {
      return {
        ok: true,
        data: {
          tip: "首站历史发车时刻表（仅供参考）",
          timetable: [
            { fTime: "06:00", eTime: "10:00", depIntervalTips: "7分钟/班", forecastDesc: "下一班预计 6 分钟后从首站发车", times: ["07:00", "07:07", "07:14", "07:21", "07:28", "07:35"] },
            { fTime: "10:00", eTime: "16:30", depIntervalTips: "10分钟/班", times: ["10:00", "10:10", "10:20", "10:30", "10:40", "10:50"] }
          ]
        }
      };
    }
    if (action === "stationDetail") {
      const sid = req.stationId || "021-3732";
      if (sid === "021-3732") {
        return {
          ok: true,
          data: {
            lines: [
              { line: { lineId: "21283604817", lineNo: "r96669", direction: 1, name: "24", startSn: "长寿新村", endSn: "豆市街复兴东路" }, stnStates: [{ value: 1, travelTime: 135, distanceToDest: 420 }] },
              { line: { lineId: "21283604206", lineNo: "r96353", direction: 1, name: "41", startSn: "沪太新村", endSn: "龙恒东路龙华西路" }, stnStates: [{ value: 2, travelTime: 240, distanceToDest: 720 }] },
              { line: { lineId: "21283604420", lineNo: "r96463", direction: 1, name: "104", startSn: "上海火车站（南广场）", endSn: "龙华" }, stnStates: [{ value: 2, travelTime: 300, distanceToDest: 890 }] },
              { line: { lineId: "21283603867", lineNo: "r96176", direction: 1, name: "23", startSn: "忻康里", endSn: "中山南一路西藏南路" }, stnStates: [{ value: 3, travelTime: 420, distanceToDest: 1350 }] },
              { line: { lineId: "21283604572", lineNo: "r96541", direction: 1, name: "738", startSn: "陕西北路南京西路", endSn: "祁安路环镇南路" }, stnStates: [{ value: 0, travelTime: 40, distanceToDest: 50 }] }
            ]
          }
        };
      }
      return {
        ok: true,
        data: {
          lines: [
            { line: { lineId: "21283605072", lineNo: "r96799", direction: 0, name: "20", startSn: "汉口路四川中路", endSn: "中山公园（万航渡路）" }, stnStates: [{ value: 0, travelTime: 25, distanceToDest: 35 }] },
            { line: { lineId: "21283604816", lineNo: "r96669", direction: 0, name: "24", startSn: "豆市街复兴东路", endSn: "长寿新村" }, stnStates: [{ value: 1, travelTime: 240, distanceToDest: 680 }] },
            { line: { lineId: "21283604966", lineNo: "r96745", direction: 0, name: "37", startSn: "扬州路齐齐哈尔路", endSn: "愚园路胶州路" }, stnStates: [{ value: 2, travelTime: 310, distanceToDest: 980 }] }
          ]
        }
      };
    }
    if (action === "subwayStation") {
      return {
        ok: true,
        data: {
          sn: req.stationName || "南京西路",
          sId: req.stationId || "12360",
          operateTime: [
            {
              code: "2号线", color: "140,194,32",
              times: [
                { dirName: "开往 浦东1号2号航站楼", startTime: "05:58", endTime: "22:30" },
                { dirName: "开往 国家会展中心", startTime: "05:39", endTime: "23:32" }
              ]
            },
            {
              code: "12号线", color: "1,121,96",
              times: [
                { dirName: "开往 七莘路", startTime: "06:13", endTime: "23:13" },
                { dirName: "开往 金海路", startTime: "06:04", endTime: "23:04" }
              ]
            },
            {
              code: "13号线", color: "232,149,193",
              times: [
                { dirName: "开往 张江路", startTime: "06:04", endTime: "23:04" },
                { dirName: "开往 金运路", startTime: "06:12", endTime: "23:12" }
              ]
            }
          ]
        }
      };
    }
    if (action === "subwayLines") {
      return {
        ok: true,
        data: {
          l: [
            { name: "2号线", lid: "310100025693", color: "140,194,32", st: [{ name: "中山公园", sid: "12362" }, { name: "江苏路", sid: "12363" }, { name: "静安寺", sid: "12361" }, { name: "南京西路", sid: "12360" }, { name: "人民广场", sid: "12329" }, { name: "南京东路", sid: "12358" }, { name: "陆家嘴", sid: "12357" }] },
            { name: "12号线", lid: "310100025711", color: "1,121,96", st: [{ name: "嘉善路", sid: "12332" }, { name: "陕西南路", sid: "12331" }, { name: "南京西路", sid: "12360" }, { name: "汉中路", sid: "12327" }, { name: "曲阜路", sid: "12326" }] },
            { name: "13号线", lid: "310100024524", color: "232,149,193", st: [{ name: "长寿路", sid: "12609" }, { name: "江宁路", sid: "12610" }, { name: "汉中路", sid: "12327" }, { name: "自然博物馆", sid: "12611" }, { name: "南京西路", sid: "12360" }, { name: "淮海中路", sid: "12612" }] },
            { name: "7号线", lid: "310100024542", color: "243,112,32", st: [{ name: "镇坪路", sid: "12480" }, { name: "长寿路", sid: "12609" }, { name: "昌平路", sid: "12481" }, { name: "静安寺", sid: "12361" }, { name: "常熟路", sid: "12482" }] },
            { name: "1号线", lid: "310100025685", color: "230,0,42", st: [{ name: "上海火车站", sid: "12328" }, { name: "汉中路", sid: "12327" }, { name: "新闸路", sid: "12330" }, { name: "人民广场", sid: "12329" }, { name: "一大会址·黄陂南路", sid: "12333" }, { name: "陕西南路", sid: "12331" }] }
          ]
        }
      };
    }
    if (action === "cityList") {
      return {
        ok: true,
        data: {
          cityList: HOT_CITIES.map((c, i) => ({
            cityId: c.cityId,
            cityName: c.cityName,
            pinyin: c.pinyin,
            isHot: i < 12 ? 1 : 0,
            isGpsCity: i === 0 ? 1 : 0
          }))
        }
      };
    }
    return {
      ok: true,
      data: {
        lines: [
          { lineId: "21283604817", name: "24", startSn: "长寿新村", endSn: "豆市街复兴东路" },
          { lineId: "21283604206", name: "41", startSn: "沪太新村", endSn: "龙恒东路龙华西路" },
          { lineId: "21283604420", name: "104", startSn: "上海火车站（南广场）", endSn: "龙华" }
        ],
        stations: [
          { sId: "021-3732", sn: "陕西北路南京西路" },
          { sId: "021-3466", sn: "南京西路陕西北路" },
          { sId: "021-8560", sn: "陕西北路新闸路" }
        ]
      }
    };
  }

  function formatRouteDisplayName(name) {
    if (!name) return "";
    const s = String(name).trim();
    if (/^\d+$/.test(s)) return s + "路";
    return s;
  }

  function formatDistance(meters) {
    if (meters === undefined || meters === null || meters < 0) return "";
    if (meters >= 1000) return (meters / 1000).toFixed(1) + "公里";
    return Math.round(meters) + "米";
  }

  // 从 encryptedLineDetail 返回的 buses 中计算距离 targetOrder 最近的两班车
  function computeUpcomingBuses(buses, targetOrder) {
    if (!Array.isArray(buses) || !targetOrder) return [];
    const candidates = [];
    for (let i = 0; i < buses.length; i++) {
      const b = buses[i];
      const bOrder = (b.specialOrder !== undefined && b.specialOrder > 0) ? b.specialOrder : b.order;
      if (!bOrder || bOrder > targetOrder) continue;
      const bState = Number(b.state || 0); // 1=已到站, 0=开往该站途中
      let stopsAway = targetOrder - bOrder + (bState === 0 ? 1 : 0);
      if (bOrder === targetOrder && bState === 1) stopsAway = 0;

      let travelSec = -1;
      if (Array.isArray(b.travels) && b.travels.length > 0 && b.travels[0].travelTime >= 0) {
        travelSec = b.travels[0].travelTime;
      }
      const distM = (b.distanceToWaitStn !== undefined && b.distanceToWaitStn >= 0)
        ? b.distanceToWaitStn : -1;
      const effectiveSec = travelSec >= 0 ? travelSec : stopsAway * 150;

      candidates.push({
        busId: b.busId || "",
        licence: b.licence || "",
        order: bOrder,
        state: bState,
        stopsAway,
        travelSec,
        effectiveSec,
        etaMin: Math.max(0, Math.round(effectiveSec / 60)),
        distM
      });
    }
    candidates.sort((a, b) => a.stopsAway - b.stopsAway || a.effectiveSec - b.effectiveSec);
    return candidates;
  }

  window.BusStore = {
    DEFAULT_CITY,
    DEFAULT_LOCATION,
    DEFAULT_FAVORITES,
    HOT_CITIES,
    SHANGHAI_PRESET_SPOTS,
    loadState,
    saveState,
    callBusApi,
    formatRouteDisplayName,
    formatDistance,
    computeUpcomingBuses
  };
})();
