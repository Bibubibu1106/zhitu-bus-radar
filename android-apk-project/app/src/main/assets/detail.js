// 申城实时公交 - 全线动态站牌轴、同站多线、发车时刻表与定位切换弹窗
(function () {
  const S = window.BusStore;

  const detailCtx = {
    open: false,
    cityId: "034",
    cityName: "上海",
    lineId: "",
    oppositeLineId: "",
    lineNo: "",
    lineName: "",
    direction: "0",
    startSn: "",
    endSn: "",
    firstTime: "",
    lastTime: "",
    price: "",
    stationId: "",
    stationName: "",
    nextStationName: "",
    targetOrder: 1,
    stations: [],
    buses: [],
    depDesc: "",
    lineDesc: ""
  };

  function esc(str) {
    return String(str === undefined || str === null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  async function openLineDetailModal(params) {
    window.AppUI.tick();
    const curCity = (window.AppUI && window.AppUI.getState) ? window.AppUI.getState().city : { cityId: "034", cityName: "上海" };
    detailCtx.open = true;
    detailCtx.cityId = params.cityId || curCity.cityId || "034";
    detailCtx.cityName = params.cityName || curCity.cityName || "上海";
    detailCtx.lineId = params.lineId || "";
    detailCtx.lineName = params.lineName || "";
    detailCtx.direction = params.direction !== undefined ? String(params.direction) : "";
    detailCtx.lineNo = params.lineNo || "";
    detailCtx.stationId = params.stationId || "";
    detailCtx.stationName = params.stationName || "";
    detailCtx.nextStationName = params.nextStationName || "";
    detailCtx.targetOrder = Number(params.targetOrder || 0);

    document.getElementById("lineModalMask").classList.add("open");
    document.getElementById("lineSheetTitle").textContent =
      S.formatRouteDisplayName(detailCtx.lineName || "加载中");
    document.getElementById("lineSheetSub").textContent = "正在同步全线实时车辆位置…";
    document.getElementById("lineSheetBody").innerHTML =
      '<div style="padding:28px 0;text-align:center;color:var(--text-muted);font-size:0.84rem;">正在连接实时公交信号…</div>';

    await refreshLineDetailModal(false);
  }

  async function refreshLineDetailModal(manual) {
    if (!detailCtx.open || !detailCtx.lineId) return;
    if (manual) window.AppUI.tick();

    const res = await S.callBusApi("lineDetail", {
      cityId: detailCtx.cityId,
      lineId: detailCtx.lineId,
      lineName: detailCtx.lineName,
      direction: detailCtx.direction,
      stationName: detailCtx.stationName,
      nextStationName: detailCtx.nextStationName,
      lineNo: detailCtx.lineNo,
      targetOrder: detailCtx.targetOrder > 0 ? String(detailCtx.targetOrder) : "",
      stationId: detailCtx.stationId
    });

    if (!res.ok || !res.data) {
      const safeErr = (window.AppUI && window.AppUI.formatSafeError) ? window.AppUI.formatSafeError(res.error) : "当前网络未连接";
      document.getElementById("lineSheetSub").textContent = safeErr + " · 请检查网络后点击右上角刷新";
      document.getElementById("lineSheetBody").innerHTML =
        `<div class="card" style="padding:22px 14px;text-align:center;color:var(--text-muted);font-size:0.84rem;">${esc(safeErr)}，恢复联网后点击右上角「刷新」即可同步全线车况</div>`;
      if (manual) window.AppUI.showToast(safeErr);
      return;
    }

    const d = res.data;
    const ln = d.line || {};
    const sts = Array.isArray(d.stations) ? d.stations : [];
    const other = Array.isArray(d.otherlines) ? d.otherlines : [];

    detailCtx.lineName = ln.name || detailCtx.lineName;
    detailCtx.lineNo = ln.lineNo || detailCtx.lineNo;
    detailCtx.direction = ln.direction !== undefined ? String(ln.direction) : detailCtx.direction;
    detailCtx.startSn = ln.startSn || "";
    detailCtx.endSn = ln.endSn || "";
    detailCtx.firstTime = ln.firstTime || "";
    detailCtx.lastTime = ln.lastTime || "";
    detailCtx.price = ln.price || "";
    detailCtx.oppositeLineId = other.length > 0 ? (other[0].lineId || "") : "";
    detailCtx.stations = sts;
    detailCtx.buses = Array.isArray(d.buses) ? d.buses : [];
    detailCtx.depDesc = d.depDesc || "";
    detailCtx.lineDesc = ln.desc || "";

    // 若尚未选定候车站或切向后需自动就近匹配当前定位/陕西北路
    let matchedSt = null;
    if (detailCtx.targetOrder > 0 && sts[detailCtx.targetOrder - 1] &&
        (!detailCtx.stationName || sts[detailCtx.targetOrder - 1].sn === detailCtx.stationName)) {
      matchedSt = sts[detailCtx.targetOrder - 1];
    } else if (detailCtx.stationId) {
      matchedSt = sts.find(s => s.sId === detailCtx.stationId);
    }
    if (!matchedSt && detailCtx.stationName) {
      matchedSt = findReverseStationMatch(sts, detailCtx.stationName);
    }
    if (!matchedSt && sts.length > 0) {
      matchedSt = pickNearestStopOnLine(sts);
    }

    if (matchedSt) {
      const needRefetch = (detailCtx.targetOrder !== matchedSt.order || detailCtx.stationId !== matchedSt.sId);
      detailCtx.targetOrder = matchedSt.order;
      detailCtx.stationId = matchedSt.sId;
      detailCtx.stationName = matchedSt.sn;
      detailCtx.nextStationName = sts[matchedSt.order] ? sts[matchedSt.order].sn : "";
      if (needRefetch && (!paramsHadValidTravels(detailCtx.buses, detailCtx.targetOrder))) {
        const res2 = await S.callBusApi("lineDetail", {
          cityId: detailCtx.cityId,
          lineId: detailCtx.lineId,
          lineName: detailCtx.lineName,
          direction: detailCtx.direction,
          stationName: detailCtx.stationName,
          nextStationName: detailCtx.nextStationName,
          lineNo: detailCtx.lineNo,
          targetOrder: String(detailCtx.targetOrder),
          stationId: detailCtx.stationId
        });
        if (res2.ok && res2.data && Array.isArray(res2.data.buses)) {
          detailCtx.buses = res2.data.buses;
          detailCtx.depDesc = res2.data.depDesc || detailCtx.depDesc;
        }
      }
    }

    renderLineDetailContent();
    if (manual) window.AppUI.showToast("已刷新全线实时车况");
  }

  function paramsHadValidTravels(buses, order) {
    if (!Array.isArray(buses) || buses.length === 0) return true;
    return buses.some(b => Array.isArray(b.travels) && b.travels.some(t => t.order === order));
  }

  function findReverseStationMatch(sts, refName) {
    if (!refName || !Array.isArray(sts) || sts.length === 0) return null;
    const exact = sts.find(s => s.sn === refName);
    if (exact) return exact;
    // 提取路口路名关键词（如“陕西北路南京西路”->["陕西北路","南京西路"]，自动匹配反向“南京西路陕西北路”或“石门一路南京西路”）
    const tokens = (refName.match(/[\u4e00-\u9fa5]{2,5}(?:路|街|寺|站|村|桥|园)/g) || []);
    if (tokens.length > 0) {
      let bestSt = null;
      let bestScore = 0;
      sts.forEach(s => {
        let score = 0;
        tokens.forEach(tk => {
          if (s.sn && s.sn.indexOf(tk) >= 0) score += 2;
          else if (s.sn && tk.length >= 3 && s.sn.indexOf(tk.slice(0, 2)) >= 0) score += 1;
        });
        if (score > bestScore) {
          bestScore = score;
          bestSt = s;
        }
      });
      if (bestSt && bestScore >= 2) return bestSt;
    }
    return null;
  }

  function pickNearestStopOnLine(sts) {
    const loc = window.AppUI.getState().location;
    let best = sts[Math.floor(sts.length / 2)] || sts[0];
    let bestDist = Infinity;
    for (let i = 0; i < sts.length; i++) {
      const s = sts[i];
      const sLat = s.wgsLat && s.wgsLat > 1 ? s.wgsLat : s.lat;
      const sLng = s.wgsLng && s.wgsLng > 1 ? s.wgsLng : s.lng;
      if (!sLat || !sLng) continue;
      const d = Math.hypot((sLat - loc.lat) * 111000, (sLng - loc.lng) * 95000);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  function renderLineDetailContent() {
    const routeTitle = S.formatRouteDisplayName(detailCtx.lineName);
    document.getElementById("lineSheetTitle").textContent =
      routeTitle + (detailCtx.endSn ? " → " + detailCtx.endSn : "");
    const metaParts = [];
    if (detailCtx.firstTime && detailCtx.lastTime) metaParts.push("首末班 " + detailCtx.firstTime + "-" + detailCtx.lastTime);
    if (detailCtx.price) metaParts.push("票价 " + detailCtx.price);
    metaParts.push("全线在途 " + detailCtx.buses.length + " 辆");
    document.getElementById("lineSheetSub").textContent = metaParts.join(" · ");

    const upcoming = S.computeUpcomingBuses(detailCtx.buses, detailCtx.targetOrder);
    const favKey = detailCtx.cityId + "__" + detailCtx.lineId + "__" + detailCtx.stationId;
    const isFav = window.AppUI.isFavoriteKey(favKey);
    const watchState = window.AppUI.getWatchState();
    const isWatchingThis = watchState.active && watchState.watchKey === favKey;

    let etaHtml = "";
    if (upcoming.length > 0) {
      const b1 = upcoming[0];
      const mainStr = (b1.stopsAway === 0 || (b1.travelSec >= 0 && b1.travelSec <= 45))
        ? "即将进站"
        : ("约 " + Math.max(1, b1.etaMin) + " 分钟");
      const subStr = "距候车站「" + esc(detailCtx.stationName) + "」还有 " + b1.stopsAway + " 站" +
        (b1.distM > 0 ? " · " + S.formatDistance(b1.distM) : "");
      const secondStr = upcoming[1]
        ? ("下班车：还有 " + upcoming[1].stopsAway + " 站 / 约 " + Math.max(1, upcoming[1].etaMin) + " 分钟")
        : "后续班次等待首站发车";
      etaHtml = `
        <div class="card" style="padding:12px 14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <div>
              <div style="font-size:0.75rem;color:var(--text-muted);">当前候车站（点击下方任意站可切换）</div>
              <div style="font-size:0.96rem;font-weight:900;margin-top:2px;">${esc(detailCtx.stationName)}</div>
              <div style="font-size:0.74rem;color:var(--text-sub);margin-top:3px;">${subStr}</div>
              <div style="font-size:0.71rem;color:var(--text-muted);margin-top:2px;">${secondStr}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:1.32rem;font-weight:900;color:var(--accent);">${mainStr}</div>
            </div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:9px;border-top:1px solid var(--card-border);">
            <button class="chip-btn ${isWatchingThis ? 'watching' : 'primary'}" onclick="window.DetailMod.toggleWatchFromDetail()">
              ${isWatchingThis ? '盯梢提醒中 · 停止' : '到站震动盯梢'}
            </button>
            <button class="chip-btn" onclick="window.DetailMod.togglePinFromDetail()">
              ${isFav ? '已存常用看板' : '+ 加入常用看板'}
            </button>
            ${detailCtx.oppositeLineId ? `<button class="chip-btn" onclick="window.DetailMod.flipDirection()">换向</button>` : ''}
            <button class="chip-btn" onclick="window.DetailMod.openTimetableModal()">时刻表</button>
            <button class="chip-btn" onclick="window.DetailMod.openSameStationModal('${esc(detailCtx.stationId)}','${esc(detailCtx.stationName)}','${esc(detailCtx.cityId)}','${esc(detailCtx.cityName)}')">本站全部线路</button>
          </div>
        </div>`;
    } else {
      const emptyTip = detailCtx.depDesc || detailCtx.lineDesc || "当前方向暂无已发车班次，请留意首站发车预测";
      etaHtml = `
        <div class="card" style="padding:12px 14px;margin-bottom:10px;">
          <div style="font-size:0.92rem;font-weight:800;">候车站：${esc(detailCtx.stationName)}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-top:4px;">${esc(emptyTip)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">
            <button class="chip-btn ${isWatchingThis ? 'watching' : 'primary'}" onclick="window.DetailMod.toggleWatchFromDetail()">
              ${isWatchingThis ? '盯梢中 · 停止' : '开启发车盯梢'}
            </button>
            <button class="chip-btn" onclick="window.DetailMod.togglePinFromDetail()">
              ${isFav ? '已置顶看板' : '+ 置顶到首页'}
            </button>
            ${detailCtx.oppositeLineId ? `<button class="chip-btn" onclick="window.DetailMod.flipDirection()">换向</button>` : ''}
            <button class="chip-btn" onclick="window.DetailMod.openTimetableModal()">时刻表</button>
          </div>
        </div>`;
    }

    // Group live buses by station order and state (state=1: arrived at station; state=0: on road between order-1 and order)
    const arrivedMap = {};
    const onRoadMap = {};
    detailCtx.buses.forEach(b => {
      const ord = (b.specialOrder && b.specialOrder > 0) ? b.specialOrder : b.order;
      if (!ord) return;
      if (Number(b.state) === 1) {
        if (!arrivedMap[ord]) arrivedMap[ord] = [];
        arrivedMap[ord].push(b);
      } else {
        if (!onRoadMap[ord]) onRoadMap[ord] = [];
        onRoadMap[ord].push(b);
      }
    });

    const metroColorMap = {
      "1": "230,0,42", "2": "130,185,20", "3": "217,172,0", "4": "95,45,155",
      "5": "148,77,154", "6": "216,21,115", "7": "235,105,25", "8": "0,152,212",
      "9": "75,168,222", "10": "155,130,190", "11": "138,34,52", "12": "0,132,102",
      "13": "224,108,162", "14": "115,112,38", "15": "168,142,98", "16": "45,168,148",
      "17": "178,102,102", "18": "178,132,68"
    };

    function renderMiniBusSvg() {
      return `<svg width="36" height="20" viewBox="0 0 36 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="31" height="14" rx="4" fill="#3B82F6"/>
        <path d="M2 8H33V12C33 14.2 31.2 16 29 16H6C3.8 16 2 14.2 2 12V8Z" fill="#2563EB"/>
        <rect x="5" y="4.2" width="6" height="4.8" rx="1.2" fill="#E0F2FE"/>
        <rect x="13" y="4.2" width="6" height="4.8" rx="1.2" fill="#E0F2FE"/>
        <rect x="21" y="4.2" width="5.5" height="4.8" rx="1.2" fill="#E0F2FE"/>
        <path d="M28 4.2H31.2C32.2 4.2 33 5 33 6V9H28V4.2Z" fill="#BAE6FD"/>
        <circle cx="32.2" cy="13.2" r="1.4" fill="#FACC15"/>
        <circle cx="9" cy="16.2" r="2.8" fill="#334155"/>
        <circle cx="9" cy="16.2" r="1.2" fill="#E2E8F0"/>
        <circle cx="25" cy="16.2" r="2.8" fill="#334155"/>
        <circle cx="25" cy="16.2" r="1.2" fill="#E2E8F0"/>
      </svg>`;
    }

    function renderTargetSignSvg() {
      return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="2.5" y="2" width="11" height="7.5" rx="1.5" stroke="#FFFFFF" stroke-width="1.6"/>
        <line x1="4.8" y1="4.8" x2="11.2" y2="4.8" stroke="#FEF08A" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="4.8" y1="7.2" x2="9.2" y2="7.2" stroke="#FFFFFF" stroke-width="1.3" stroke-linecap="round"/>
        <line x1="8" y1="9.5" x2="8" y2="14.5" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round"/>
      </svg>`;
    }

    let listHtml = '<div class="timeline-list">';
    detailCtx.stations.forEach((st, idx) => {
      const isTarget = st.order === detailCtx.targetOrder;
      const isAfterTarget = st.order > detailCtx.targetOrder;
      const onRoadBuses = onRoadMap[st.order] || [];
      const atStnBuses = arrivedMap[st.order] || [];
      const isAmberSeg = (st.order === detailCtx.targetOrder) || onRoadBuses.length > 0;

      const cls = isTarget
        ? "stn-item target"
        : (isAfterTarget ? "stn-item after-target" : "stn-item");

      const metros = Array.isArray(st.metros) ? st.metros : [];
      const metroBadges = metros.slice(0, 3).map(m => {
        const no = String(m.lineNo || "").replace(/[^0-9]/g, "");
        const rgb = m.color || metroColorMap[no] || "37,99,235";
        const label = m.lineNo ? (m.lineNo + "号线") : (m.fullName || "").replace("地铁", "");
        return `<span class="metro-pill" style="background:rgba(${rgb},0.15);color:rgb(${rgb});">${esc(label)}</span>`;
      }).join("");

      const segHtml = idx > 0
        ? `<div class="stn-seg-line ${isAmberSeg ? 'seg-amber' : (isAfterTarget ? 'seg-after' : '')}"><span class="stn-seg-arrow">▾</span></div>`
        : "";

      const nodeHtml = isTarget
        ? `<div class="stn-target-sign">${renderTargetSignSvg()}</div>`
        : `<div class="stn-node ${isAmberSeg ? 'node-amber' : (isAfterTarget ? 'node-after' : '')}"></div>`;

      const onRoadBusHtml = onRoadBuses.length > 0
        ? `<div class="bus-fig-wrap on-road">${renderMiniBusSvg()}<span class="bus-fig-badge">${onRoadBuses.length > 1 ? ('行驶×' + onRoadBuses.length) : '行驶中'}</span></div>`
        : "";

      const atStnBusHtml = atStnBuses.length > 0
        ? `<div class="bus-fig-wrap at-station">${renderMiniBusSvg()}<span class="bus-fig-badge">${atStnBuses.length > 1 ? ('到站×' + atStnBuses.length) : '已到站'}</span></div>`
        : "";

      listHtml += `
        <div class="${cls}" id="stnRow_${st.order}" onclick="window.DetailMod.selectTargetStation(${st.order})">
          ${segHtml}
          ${onRoadBusHtml}
          ${atStnBusHtml}
          ${nodeHtml}
          <div style="flex:1;padding-right:6px;">
            <span class="stn-title">${st.order} ${esc(st.sn)}</span>${metroBadges}
          </div>
        </div>`;
    });
    listHtml += '</div>';

    document.getElementById("lineSheetBody").innerHTML = etaHtml + listHtml;
    const targetEl = document.getElementById("stnRow_" + detailCtx.targetOrder);
    if (targetEl) {
      setTimeout(() => {
        try { targetEl.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
      }, 60);
    }
  }

  async function selectTargetStation(order) {
    const st = detailCtx.stations.find(s => s.order === order);
    if (!st) return;
    window.AppUI.tick();
    detailCtx.targetOrder = st.order;
    detailCtx.stationId = st.sId;
    detailCtx.stationName = st.sn;
    detailCtx.nextStationName = detailCtx.stations[st.order] ? detailCtx.stations[st.order].sn : "";
    await refreshLineDetailModal(false);
  }

  async function flipDirection() {
    if (!detailCtx.oppositeLineId) return;
    window.AppUI.tick();
    detailCtx.lineId = detailCtx.oppositeLineId;
    detailCtx.direction = "";
    detailCtx.nextStationName = "";
    detailCtx.stationId = "";
    detailCtx.targetOrder = 0;
    await refreshLineDetailModal(false);
  }

  function togglePinFromDetail() {
    window.AppUI.tick();
    const entry = {
      key: detailCtx.cityId + "__" + detailCtx.lineId + "__" + detailCtx.stationId,
      cityId: detailCtx.cityId,
      cityName: detailCtx.cityName,
      lineId: detailCtx.lineId,
      oppositeLineId: detailCtx.oppositeLineId || "",
      lineNo: detailCtx.lineNo || "",
      lineName: detailCtx.lineName || "",
      direction: detailCtx.direction || "0",
      startSn: detailCtx.startSn || "",
      endSn: detailCtx.endSn || "",
      stationId: detailCtx.stationId || "",
      stationName: detailCtx.stationName || "",
      nextStationName: detailCtx.nextStationName || "",
      targetOrder: detailCtx.targetOrder || 1
    };
    const added = window.AppUI.toggleFavoriteEntry(entry);
    window.AppUI.showToast(added ? "已加入常用看板" : "已从常用看板移除");
    renderLineDetailContent();
  }

  function toggleWatchFromDetail() {
    window.AppUI.toggleWatchForItem({
      key: detailCtx.cityId + "__" + detailCtx.lineId + "__" + detailCtx.stationId,
      cityId: detailCtx.cityId,
      lineId: detailCtx.lineId,
      lineName: detailCtx.lineName,
      direction: detailCtx.direction,
      endSn: detailCtx.endSn,
      stationId: detailCtx.stationId,
      stationName: detailCtx.stationName,
      nextStationName: detailCtx.nextStationName,
      lineNo: detailCtx.lineNo,
      targetOrder: detailCtx.targetOrder
    });
    setTimeout(renderLineDetailContent, 150);
  }

  function closeLineDetailModal() {
    detailCtx.open = false;
    document.getElementById("lineModalMask").classList.remove("open");
  }

  async function openTimetableModal() {
    if (!detailCtx.lineId) return;
    window.AppUI.tick();
    openAuxSheet(S.formatRouteDisplayName(detailCtx.lineName) + " · 首站发车时刻表", "正在加载时刻表…");
    const res = await S.callBusApi("timetable", { cityId: detailCtx.cityId, lineId: detailCtx.lineId });
    if (!res.ok || !res.data || !Array.isArray(res.data.timetable) || res.data.timetable.length === 0) {
      document.getElementById("auxSheetBody").innerHTML =
        '<div style="padding:20px 0;text-align:center;color:var(--text-muted);font-size:0.83rem;">该线路暂未公开固定时刻表，请以实时车辆位置为准</div>';
      return;
    }
    let html = `<div style="font-size:0.76rem;color:var(--text-muted);margin-bottom:10px;">${esc(res.data.tip || "首站计划发车间隔参考")}</div>`;
    res.data.timetable.forEach(seg => {
      const times = Array.isArray(seg.times) ? seg.times.join(" · ") : "";
      html += `
        <div class="card" style="padding:11px 12px;margin-bottom:8px;">
          <div style="display:flex;justify-content:space-between;font-size:0.83rem;font-weight:800;">
            <span>${esc(seg.fTime || "")} - ${esc(seg.eTime || "")}</span>
            <span style="color:var(--accent);">${esc(seg.depIntervalTips || "")}</span>
          </div>
          ${seg.forecastDesc ? `<div style="font-size:0.75rem;color:#0284c7;margin-top:4px;font-weight:700;">${esc(seg.forecastDesc)}</div>` : ''}
          ${times ? `<div style="font-size:0.75rem;color:var(--text-sub);margin-top:6px;line-height:1.6;">${esc(times)}</div>` : ''}
        </div>`;
    });
    document.getElementById("auxSheetBody").innerHTML = html;
  }

  let currentStationSheetCtx = { cityId: "034", cityName: "上海", stationId: "", stationName: "", lines: [] };

  async function openSameStationModal(stationId, stationName, optCityId, optCityName) {
    if (!stationId) return;
    window.AppUI.tick();
    const curCity = (window.AppUI && window.AppUI.getState) ? window.AppUI.getState().city : { cityId: "034", cityName: "上海" };
    const cityId = optCityId || curCity.cityId || "034";
    const cityName = optCityName || curCity.cityName || "上海";
    openAuxSheet(stationName + " · 站台途经公交", "正在查询本站所有实时公交…");
    const res = await S.callBusApi("stationDetail", { cityId, stationId, destSId: "-1" });
    const lines = (res.ok && res.data && Array.isArray(res.data.lines)) ? res.data.lines : [];
    if (lines.length === 0) {
      document.getElementById("auxSheetBody").innerHTML =
        '<div style="padding:20px 0;text-align:center;color:var(--text-muted);font-size:0.83rem;">暂未查询到本站途经线路</div>';
      return;
    }
    currentStationSheetCtx = { cityId, cityName, stationId, stationName, lines };
    renderStationLinesSheet();
  }

  function renderStationLinesSheet() {
    const { cityId, cityName, stationId, stationName, lines } = currentStationSheetCtx;
    let html = `<div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:9px;">点击左侧线路可<strong>临时查看</strong>全线车况；点右侧按钮可将该站线路加入/移出<strong>常用看板</strong></div>`;
    lines.forEach((item, idx) => {
      const ln = item.line || {};
      const key = cityId + "__" + ln.lineId + "__" + stationId;
      const isFav = window.AppUI.isFavoriteKey(key);
      const stnState = window.AppUI.extractBestStnState(item.stnStates);
      html += `
        <div class="near-line-row" style="gap:8px;">
          <div style="flex:1;min-width:0;" onclick="window.DetailMod.jumpLineFromAux('${esc(ln.lineId)}','${esc(ln.name)}','${esc(stationId)}','${esc(stationName)}','${esc(cityId)}','${esc(cityName)}')">
            <div>
              <span class="route-badge" style="font-size:0.80rem;padding:2px 8px;">${esc(S.formatRouteDisplayName(ln.name))}</span>
              <span style="font-size:0.78rem;color:var(--text-sub);margin-left:6px;font-weight:700;">开往 ${esc(ln.endSn || "")}</span>
            </div>
            <div style="font-size:0.72rem;color:var(--text-muted);margin-top:3px;">
              实时：<strong style="color:${stnState.arriving ? '#d97706' : 'var(--accent)'};">${esc(stnState.label)}</strong>
              ${stnState.sub ? ` · ${esc(stnState.sub)}` : ''}
            </div>
          </div>
          <button class="chip-btn ${isFav ? 'watching' : 'primary'}" style="flex-shrink:0;" onclick="window.DetailMod.toggleFavFromStationSheet(${idx})">
            ${isFav ? '✓ 已存常用' : '+ 常用'}
          </button>
        </div>`;
    });
    document.getElementById("auxSheetBody").innerHTML = html;
  }

  async function toggleFavFromStationSheet(idx) {
    const { cityId, cityName, stationId, stationName, lines } = currentStationSheetCtx;
    const item = lines[idx];
    if (!item || !item.line) return;
    window.AppUI.tick();
    const ln = item.line;
    const key = cityId + "__" + ln.lineId + "__" + stationId;
    if (window.AppUI.isFavoriteKey(key)) {
      window.AppUI.toggleFavoriteEntry({ key });
      window.AppUI.showToast("已从常用看板移除 " + S.formatRouteDisplayName(ln.name));
      renderStationLinesSheet();
      return;
    }
    // 补全该线路在本站的精确站序 targetOrder 与反向 lineId
    let targetOrder = Number(item.targetOrder || 0);
    let oppositeLineId = "";
    let nextStationName = "";
    const detailRes = await S.callBusApi("lineDetail", { cityId, lineId: ln.lineId });
    if (detailRes.ok && detailRes.data) {
      const sts = Array.isArray(detailRes.data.stations) ? detailRes.data.stations : [];
      const other = Array.isArray(detailRes.data.otherlines) ? detailRes.data.otherlines : [];
      if (other.length > 0) oppositeLineId = other[0].lineId || "";
      const stMatch = sts.find(s => s.sId === stationId || s.sn === stationName);
      if (stMatch) {
        targetOrder = stMatch.order;
        nextStationName = sts[stMatch.order] ? sts[stMatch.order].sn : "";
      }
    }
    window.AppUI.toggleFavoriteEntry({
      key,
      cityId,
      cityName,
      lineId: ln.lineId,
      oppositeLineId,
      lineNo: ln.lineNo || "",
      lineName: ln.name || "",
      direction: ln.direction !== undefined ? String(ln.direction) : "0",
      startSn: ln.startSn || "",
      endSn: ln.endSn || "",
      stationId,
      stationName,
      nextStationName,
      targetOrder: targetOrder || 1
    });
    window.AppUI.showToast("已将「" + stationName + " · " + S.formatRouteDisplayName(ln.name) + "」加入常用看板");
    renderStationLinesSheet();
  }

  async function openMetroStationModal(stationId, stationName) {
    window.AppUI.tick();
    openAuxSheet("地铁「" + stationName + "」站 · 首末班时刻", "正在同步上海申通地铁站点运营时刻…");
    const res = await S.callBusApi("subwayStation", { stationId, stationName });
    const opList = (res.ok && res.data && Array.isArray(res.data.operateTime)) ? res.data.operateTime : [];
    if (opList.length === 0) {
      document.getElementById("auxSheetBody").innerHTML =
        '<div style="padding:20px 0;text-align:center;color:var(--text-muted);font-size:0.83rem;">暂未查询到该地铁站首末班数据</div>';
      return;
    }
    let html = `<div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:10px;">上海地铁各方向首末班发车时刻（高峰间隔约 2.5~4 分钟，平峰约 5~8 分钟）</div>`;
    opList.forEach(line => {
      const rgb = line.color ? `rgb(${line.color})` : "#2563eb";
      const rows = (line.times || []).map(t => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px dashed var(--card-border);font-size:0.79rem;">
          <span style="font-weight:700;color:var(--text-main);">${esc(t.dirName)}</span>
          <span style="color:var(--text-sub);font-weight:700;">首 ${esc(t.startTime)} · 末 ${esc(t.endTime)}</span>
        </div>`).join("");
      html += `
        <div class="card" style="padding:12px 14px;margin-bottom:9px;">
          <div style="margin-bottom:6px;">
            <span style="display:inline-block;padding:2px 9px;border-radius:8px;background:${rgb};color:#fff;font-size:0.8rem;font-weight:900;">${esc(line.code)}</span>
          </div>
          ${rows}
        </div>`;
    });
    document.getElementById("auxSheetBody").innerHTML = html;
  }

  function jumpLineFromAux(lineId, lineName, stationId, stationName, cityId, cityName) {
    closeAuxSheet();
    openLineDetailModal({ lineId, lineName, stationId, stationName, cityId, cityName });
  }

  function openAuxSheet(title, loadingMsg) {
    document.getElementById("auxModalMask").classList.add("open");
    document.getElementById("auxSheetTitle").textContent = title;
    document.getElementById("auxSheetBody").innerHTML =
      `<div style="padding:22px 0;text-align:center;color:var(--text-muted);font-size:0.83rem;">${esc(loadingMsg)}</div>`;
  }

  function closeAuxSheet() {
    document.getElementById("auxModalMask").classList.remove("open");
  }

  window.DetailMod = {
    isOpen: () => detailCtx.open,
    isAuxOpen: () => document.getElementById("auxModalMask").classList.contains("open"),
    openLineDetailModal,
    refreshLineDetailModal,
    closeLineDetailModal,
    selectTargetStation,
    flipDirection,
    togglePinFromDetail,
    toggleWatchFromDetail,
    openTimetableModal,
    openSameStationModal,
    toggleFavFromStationSheet,
    openMetroStationModal,
    jumpLineFromAux,
    openAuxSheet,
    closeAuxSheet
  };
})();
