// 申城实时公交 - 首页常用看板、附近站点定位雷达、快速查线与设置中心
(function () {
  const S = window.BusStore;
  const state = S.loadState();

  let activePage = "home"; // home | settings
  let homeSubTab = "fav";  // fav | nearby
  let favLiveMap = {};     // key -> { loading, error, upcoming, depDesc, lineDesc, lineObj }
  let nearStopsData = [];
  let watchState = { active: false, watchKey: "", summary: "" };
  let autoTimer = null;
  let toastTimer = null;
  let searchDebounce = null;

  function esc(str) {
    return String(str === undefined || str === null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatSafeError(err) {
    const s = String(err || "").trim();
    if (!s) return "请检查网络";
    if (/unable to resolve|unknownhost|no address|network|connect|refused|unreachable/i.test(s)) {
      return "网络未连接";
    }
    if (/timeout|timed out|超时/i.test(s)) {
      return "请求超时";
    }
    if (/[a-zA-Z]{5,}/.test(s) || s.length > 8) {
      return "网络未连接";
    }
    return s;
  }

  function tick() {
    if (window.AndroidBridge && typeof window.AndroidBridge.vibrateTick === "function") {
      window.AndroidBridge.vibrateTick();
    }
  }

  function showToast(msg) {
    const bar = document.getElementById("toastBar");
    const txt = document.getElementById("toastText");
    if (!bar || !txt) return;
    txt.textContent = msg;
    bar.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { bar.classList.remove("show"); }, 2000);
  }

  function hideToast() {
    if (toastTimer) clearTimeout(toastTimer);
    document.getElementById("toastBar").classList.remove("show");
  }

  function applyTheme() {
    const mode = state.settings.themeMode || "auto";
    let isNight = false;
    if (mode === "night") {
      isNight = true;
    } else if (mode === "auto") {
      const h = new Date().getHours();
      isNight = (h >= 19 || h < 6);
    }
    document.body.classList.toggle("theme-night", isNight);
    if (window.AndroidBridge && typeof window.AndroidBridge.setSystemTheme === "function") {
      window.AndroidBridge.setSystemTheme(isNight);
    }
  }

  function extractBestStnState(stnStates) {
    if (!Array.isArray(stnStates) || stnStates.length === 0) {
      return { label: "等待发车", sub: "", arriving: false };
    }
    const valid = stnStates.filter(x => x && (x.travelTime >= 0 || x.value >= 0));
    if (valid.length === 0) {
      return { label: "暂未发车", sub: "", arriving: false };
    }
    valid.sort((a, b) => {
      const ta = a.travelTime >= 0 ? a.travelTime : a.value * 150;
      const tb = b.travelTime >= 0 ? b.travelTime : b.value * 150;
      return ta - tb;
    });
    const best = valid[0];
    const stops = best.value >= 0 ? best.value : 0;
    const sec = best.travelTime >= 0 ? best.travelTime : stops * 150;
    const distStr = best.distanceToDest > 0 ? S.formatDistance(best.distanceToDest) : "";
    if (stops === 0 && sec <= 55) {
      return { label: "即将进站", sub: distStr || "请留意来车", arriving: true };
    }
    const mins = Math.max(1, Math.round(sec / 60));
    return {
      label: mins + " 分钟",
      sub: "还有 " + stops + " 站" + (distStr ? " · " + distStr : ""),
      arriving: false
    };
  }

  async function refreshFavorites(manual) {
    if (manual) tick();
    renderHeaderLoc();
    const list = state.favorites;
    if (list.length === 0) {
      renderFavoritesList();
      return;
    }

    await Promise.all(list.map(async (item) => {
      const res = await S.callBusApi("lineDetail", {
        cityId: item.cityId || "034",
        lineId: item.lineId,
        lineName: item.lineName,
        direction: item.direction,
        stationName: item.stationName,
        nextStationName: item.nextStationName,
        lineNo: item.lineNo,
        targetOrder: String(item.targetOrder || 1),
        stationId: item.stationId
      });
      if (res.ok && res.data) {
        const d = res.data;
        const ln = d.line || {};
        const other = Array.isArray(d.otherlines) ? d.otherlines : [];
        if (other.length > 0 && other[0].lineId) item.oppositeLineId = other[0].lineId;
        if (ln.endSn) item.endSn = ln.endSn;
        favLiveMap[item.key] = {
          ok: true,
          upcoming: S.computeUpcomingBuses(d.buses || [], Number(item.targetOrder || 1)),
          depDesc: d.depDesc || "",
          lineDesc: ln.desc || "",
          updatedAt: Date.now()
        };
      } else {
        favLiveMap[item.key] = { ok: false, error: res.error || "连接异常" };
      }
    }));

    S.saveState(state);
    renderFavoritesList();
    updateRefreshStamp();
    if (manual) showToast("已更新实时公交到站时间");
  }

  function renderFavoritesList() {
    const box = document.getElementById("favListBox");
    if (!box) return;
    if (state.favorites.length === 0) {
      box.innerHTML = `
        <div class="card" style="padding:22px 16px;text-align:center;">
          <div style="font-size:0.92rem;font-weight:800;color:var(--text-main);margin-bottom:6px;">常用看板暂未添加站点线路</div>
          <div style="font-size:0.78rem;color:var(--text-muted);line-height:1.6;margin-bottom:14px;">
            你可以在上方搜索框搜公交站名（如「陕西北路南京西路」），或切到「附近站点」点选站台，将需要的公交线路勾选加入常用看板。
          </div>
          <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;">
            <button class="chip-btn primary" onclick="window.AppUI.switchHomeSubTab('nearby')">浏览附近站点添加</button>
            <button class="chip-btn" onclick="document.getElementById('searchInput').focus()">搜索公交站台</button>
          </div>
        </div>`;
      return;
    }

    // 按城市+站点分组渲染：每条路线独立记住所属城市 cityId
    const groups = [];
    const groupMap = {};
    state.favorites.forEach((item, idx) => {
      const cid = item.cityId || "034";
      const cname = item.cityName || "上海";
      const gKey = cid + "__" + (item.stationId || "") + "__" + (item.stationName || "常用站点");
      if (!groupMap[gKey]) {
        groupMap[gKey] = {
          cityId: cid,
          cityName: cname,
          stationId: item.stationId || "",
          stationName: item.stationName || "常用站点",
          entries: []
        };
        groups.push(groupMap[gKey]);
      }
      groupMap[gKey].entries.push({ item, idx });
    });

    const groupsHtml = groups.map(grp => {
      const rowsHtml = grp.entries.map(({ item, idx }) => {
        const live = favLiveMap[item.key];
        const isWatching = watchState.active && watchState.watchKey === item.key;
        let etaHtml = `<div class="eta-main idle">同步中…</div>`;

        if (live && live.ok) {
          if (live.upcoming && live.upcoming.length > 0) {
            const b1 = live.upcoming[0];
            const b2 = live.upcoming[1];
            const arriving = (b1.stopsAway === 0 || (b1.travelSec >= 0 && b1.travelSec <= 45));
            const mainTxt = arriving
              ? `<div class="eta-main arriving">即将进站</div>`
              : `<div class="eta-main">${Math.max(1, b1.etaMin)}<span class="eta-unit">分钟</span></div>`;
            const sub1 = `还有 ${b1.stopsAway} 站` + (b1.distM > 0 ? ` · ${S.formatDistance(b1.distM)}` : "");
            const sub2 = b2 ? `下班 ${Math.max(1, b2.etaMin)}分/${b2.stopsAway}站` : "";
            etaHtml = `${mainTxt}<div class="eta-sub">${esc(sub1)}</div>${sub2 ? `<div class="eta-sub" style="opacity:0.8;">${esc(sub2)}</div>` : ""}`;
          } else {
            const idleTxt = live.depDesc || live.lineDesc || "等待发车";
            etaHtml = `<div class="eta-main idle">${esc(idleTxt)}</div><div class="eta-sub">首站待发</div>`;
          }
        } else if (live && !live.ok) {
          etaHtml = `<div class="eta-main idle">离线待刷新</div><div class="eta-sub">${esc(formatSafeError(live.error))}</div>`;
        }

        return `
          <div style="padding:10px 0;border-top:1px solid var(--card-border);">
            <div class="bus-card-top" onclick="window.AppUI.openFavCard(${idx})" style="cursor:pointer;">
              <div style="flex:1;min-width:0;overflow:hidden;">
                <div style="display:flex;align-items:center;gap:7px;flex-wrap:nowrap;">
                  <span class="route-badge">${esc(S.formatRouteDisplayName(item.lineName))}</span>
                  <span style="font-size:0.82rem;font-weight:800;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">开往 ${esc(item.endSn || "")}</span>
                </div>
                ${item.nextStationName ? `<div class="stop-text" style="margin-top:5px;">下一站：${esc(item.nextStationName)}</div>` : ""}
              </div>
              <div class="eta-box">${etaHtml}</div>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px;">
              <div style="display:flex;gap:6px;">
                <button class="chip-btn" onclick="window.AppUI.openFavCard(${idx})">全线车况</button>
                ${item.oppositeLineId ? `<button class="chip-btn" onclick="window.AppUI.flipFavCard(${idx})">返程换向</button>` : ""}
              </div>
              <button class="chip-btn ${isWatching ? 'watching' : ''}" onclick="window.AppUI.toggleWatchFav(${idx})">
                ${isWatching ? "盯梢中 · 停止" : "到站提醒"}
              </button>
            </div>
          </div>`;
      }).join("");

      return `
        <div class="bus-card" style="padding:12px 14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding-bottom:8px;">
            <div style="font-size:0.92rem;font-weight:900;color:var(--text-main);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              <span class="dot dot-mint"></span><span class="metro-pill" style="margin-left:0;margin-right:5px;">${esc(grp.cityName)}</span>${esc(grp.stationName)} <span style="font-size:0.72rem;font-weight:600;color:var(--text-muted);">站</span>
            </div>
            ${grp.stationId ? `<button class="chip-btn" style="padding:3px 9px;font-size:0.72rem;color:var(--accent);" onclick="window.DetailMod.openSameStationModal('${esc(grp.stationId)}','${esc(grp.stationName)}','${esc(grp.cityId)}','${esc(grp.cityName)}')">+ 增删本站线路</button>` : ""}
          </div>
          ${rowsHtml}
        </div>`;
    }).join("");

    const footerAddHtml = `
      <div style="text-align:center;margin:6px 0 10px;">
        <button class="chip-btn" style="padding:7px 14px;" onclick="window.AppUI.switchHomeSubTab('nearby')">
          + 浏览附近公交站添加常用线路
        </button>
      </div>`;

    box.innerHTML = groupsHtml + footerAddHtml;
  }

  async function flipFavCard(idx) {
    const item = state.favorites[idx];
    if (!item || !item.oppositeLineId) return;
    tick();
    showToast("正在切换返程方向并匹配就近站点…");
    const cid = item.cityId || "034";
    const res = await S.callBusApi("lineDetail", { cityId: cid, lineId: item.oppositeLineId });
    if (!res.ok || !res.data || !Array.isArray(res.data.stations)) {
      showToast("切换方向失败，请稍后重试");
      return;
    }
    const d = res.data;
    const ln = d.line || {};
    const sts = d.stations;
    let targetSt = sts.find(s => s.sn === item.stationName);
    if (!targetSt) {
      let bestDist = Infinity;
      sts.forEach(s => {
        const sLat = s.wgsLat && s.wgsLat > 1 ? s.wgsLat : s.lat;
        const sLng = s.wgsLng && s.wgsLng > 1 ? s.wgsLng : s.lng;
        if (!sLat || !sLng) return;
        const dist = Math.hypot((sLat - state.location.lat) * 111000, (sLng - state.location.lng) * 95000);
        if (dist < bestDist) { bestDist = dist; targetSt = s; }
      });
    }
    if (!targetSt) targetSt = sts[0];
    const oldOpp = item.lineId;
    item.lineId = item.oppositeLineId;
    item.oppositeLineId = oldOpp;
    item.direction = ln.direction !== undefined ? String(ln.direction) : (item.direction === "0" ? "1" : "0");
    item.startSn = ln.startSn || "";
    item.endSn = ln.endSn || "";
    item.stationId = targetSt.sId;
    item.stationName = targetSt.sn;
    item.targetOrder = targetSt.order;
    item.nextStationName = sts[targetSt.order] ? sts[targetSt.order].sn : "";
    item.key = cid + "__" + item.lineId + "__" + item.stationId;
    S.saveState(state);
    await refreshFavorites(false);
    showToast("已切换至开往「" + item.endSn + "」方向");
  }

  async function refreshNearbyStops(manual) {
    if (manual) tick();
    const box = document.getElementById("nearbyListBox");
    if (nearStopsData.length === 0 && box) {
      box.innerHTML = `<div class="card" style="text-align:center;color:var(--text-muted);font-size:0.84rem;">正在扫描「${esc(state.location.name)}」周边实时公交站点…</div>`;
    }
    const res = await S.callBusApi("nearlines", {
      lat: state.location.lat,
      lng: state.location.lng,
      isGcj: !!state.location.isGcj
    });
    if (!res.ok || !res.data || !Array.isArray(res.data.nearLines)) {
      if (box) box.innerHTML = `<div class="card" style="text-align:center;color:var(--text-muted);font-size:0.84rem;">周边站点暂未加载：${esc(formatSafeError(res.error))}，请检查网络后点击刷新</div>`;
      return;
    }
    nearStopsData = res.data.nearLines;
    renderNearbyStops();
    updateRefreshStamp();
    if (manual) showToast("已刷新周边站点实时车况");
  }

  function renderNearbyStops() {
    const box = document.getElementById("nearbyListBox");
    if (!box) return;
    if (nearStopsData.length === 0) {
      box.innerHTML = `<div class="card" style="text-align:center;color:var(--text-muted);font-size:0.84rem;">当前坐标 1 公里内暂无公交站点</div>`;
      return;
    }
    box.innerHTML = nearStopsData.slice(0, 8).map(grp => {
      const lines = Array.isArray(grp.lines) ? grp.lines : [];
      const rows = lines.map(item => {
        const ln = item.line || {};
        const st = extractBestStnState(item.stnStates);
        return `
          <div class="near-line-row" onclick="window.DetailMod.openLineDetailModal({lineId:'${esc(ln.lineId)}',lineName:'${esc(ln.name)}',stationId:'${esc(grp.sId)}',stationName:'${esc(grp.sn)}'})">
            <div style="min-width:0;padding-right:8px;">
              <span class="route-badge" style="font-size:0.8rem;padding:2px 8px;">${esc(S.formatRouteDisplayName(ln.name))}</span>
              <span style="font-size:0.78rem;font-weight:700;color:var(--text-sub);margin-left:6px;">→ ${esc(ln.endSn || "")}</span>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:0.86rem;font-weight:900;color:${st.arriving ? '#d97706' : 'var(--accent)'};">${esc(st.label)}</div>
              ${st.sub ? `<div style="font-size:0.68rem;color:var(--text-muted);">${esc(st.sub)}</div>` : ""}
            </div>
          </div>`;
      }).join("");

      return `
        <div class="card" style="padding:13px 14px;">
          <div class="near-stop-header">
            <div class="near-stop-name"><span class="dot dot-sky"></span>${esc(grp.sn)}</div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="dist-tag">步行 ${S.formatDistance(grp.distance)}</span>
              <button class="chip-btn" style="padding:2px 8px;font-size:0.7rem;color:var(--accent);" onclick="window.DetailMod.openSameStationModal('${esc(grp.sId)}','${esc(grp.sn)}')">+ 选线路</button>
            </div>
          </div>
          ${rows}
        </div>`;
    }).join("");
  }

  // Search Input Handler (站点优先方便选线加常用，线路支持直接临时查看)
  function onSearchInput(val) {
    const q = String(val || "").trim();
    const panel = document.getElementById("searchResultBox");
    const clearBtn = document.getElementById("searchClearBtn");
    clearBtn.style.display = q ? "inline-block" : "none";
    if (!q) {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
      const res = await S.callBusApi("search", { keyword: q, count: 10 });
      if (!res.ok || !res.data) return;
      const lines = Array.isArray(res.data.lines) ? res.data.lines : [];
      const stations = Array.isArray(res.data.stations) ? res.data.stations : [];
      if (lines.length === 0 && stations.length === 0) {
        panel.style.display = "block";
        panel.innerHTML = `<div style="padding:10px;font-size:0.8rem;color:var(--text-muted);text-align:center;">未找到匹配的上海公交站台或线路</div>`;
        return;
      }
      let html = "";
      stations.slice(0, 5).forEach(st => {
        html += `
          <div class="near-line-row" onclick="window.AppUI.pickSearchResultStation('${esc(st.sId)}','${esc(st.sn)}')">
            <div><span class="dot dot-mint"></span><strong style="font-size:0.83rem;">${esc(st.sn)}</strong> <span style="font-size:0.71rem;color:var(--text-muted);">公交站</span></div>
            <span style="font-size:0.73rem;color:var(--accent);font-weight:700;">选本站线路 ▸</span>
          </div>`;
      });
      lines.slice(0, 6).forEach(ln => {
        html += `
          <div class="near-line-row" onclick="window.AppUI.pickSearchResultLine('${esc(ln.lineId)}','${esc(ln.name)}')">
            <div>
              <span class="route-badge" style="font-size:0.78rem;padding:2px 8px;">${esc(S.formatRouteDisplayName(ln.name))}</span>
              <span style="font-size:0.76rem;color:var(--text-sub);margin-left:6px;">${esc(ln.startSn || "")} → ${esc(ln.endSn || "")}</span>
            </div>
            <span style="font-size:0.73rem;color:var(--text-muted);">临时查全线</span>
          </div>`;
      });
      panel.style.display = "block";
      panel.innerHTML = html;
    }, 240);
  }

  function clearSearch() {
    document.getElementById("searchInput").value = "";
    document.getElementById("searchClearBtn").style.display = "none";
    const panel = document.getElementById("searchResultBox");
    panel.style.display = "none";
    panel.innerHTML = "";
  }

  function pickSearchResultLine(lineId, lineName) {
    clearSearch();
    window.DetailMod.openLineDetailModal({ lineId, lineName });
  }

  function pickSearchResultStation(sId, sn) {
    clearSearch();
    window.DetailMod.openSameStationModal(sId, sn);
  }

  // Nationwide 480+ City Picker & Location Picker
  let allCitiesCache = null;

  async function openCityPickerModal() {
    tick();
    const curCityName = (state.city && state.city.cityName) ? state.city.cityName : "上海";
    const hotBtns = S.HOT_CITIES.map(c => {
      const isCur = state.city && state.city.cityId === c.cityId;
      return `<button class="chip-btn ${isCur ? 'primary' : ''}" onclick="window.AppUI.selectCityById('${esc(c.cityId)}','${esc(c.cityName)}')">${esc(c.cityName)}</button>`;
    }).join(" ");

    const html = `
      <div style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div style="font-size:0.8rem;color:var(--text-sub);">当前城市：<strong style="color:var(--accent);">${esc(curCityName)}</strong></div>
        <button class="chip-btn primary" onclick="window.AppUI.triggerGpsLocate()">GPS自动识别所在城市</button>
      </div>
      <div class="search-bar" style="margin-bottom:10px;">
        <input id="cityFilterInput" type="text" placeholder="搜索全国 480+ 城市名称或拼音（如：杭州、苏州、大理）" oninput="window.AppUI.filterCityList(this.value)" />
      </div>
      <div id="cityFilterResultBox" style="max-height:220px;overflow-y:auto;margin-bottom:10px;"></div>
      <div style="font-size:0.74rem;color:var(--text-muted);margin-bottom:6px;">热门城市一键切换（每条常用路线独立保存所属城市）</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">${hotBtns}</div>
      <div id="allCitiesCountTip" style="font-size:0.72rem;color:var(--text-muted);">正在同步全国 486 城实时公交目录…</div>`;

    window.DetailMod.openAuxSheet("切换全国城市（支持 486 城）", "");
    document.getElementById("auxSheetBody").innerHTML = html;

    if (!allCitiesCache) {
      const res = await S.callBusApi("cityList", {});
      if (res.ok && res.data && Array.isArray(res.data.cityList) && res.data.cityList.length > 0) {
        allCitiesCache = res.data.cityList;
      } else {
        allCitiesCache = S.HOT_CITIES.slice();
      }
    }
    const tipEl = document.getElementById("allCitiesCountTip");
    if (tipEl) {
      tipEl.textContent = "已加载全国 " + allCitiesCache.length + " 个支持实时公交的城市，可在上方输入框检索任意城市。";
    }
  }

  function filterCityList(val) {
    const q = String(val || "").trim().toLowerCase();
    const box = document.getElementById("cityFilterResultBox");
    if (!box) return;
    if (!q) {
      box.innerHTML = "";
      return;
    }
    const pool = allCitiesCache || S.HOT_CITIES;
    const matched = pool.filter(c => {
      const name = String(c.cityName || "").toLowerCase();
      const py = String(c.pinyin || "").toLowerCase();
      return name.indexOf(q) >= 0 || py.indexOf(q) >= 0;
    }).slice(0, 20);

    if (matched.length === 0) {
      box.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 0;">未找到匹配的城市</div>`;
      return;
    }
    box.innerHTML = matched.map(c => `
      <div class="near-line-row" onclick="window.AppUI.selectCityById('${esc(c.cityId)}','${esc(c.cityName)}')">
        <div><strong style="font-size:0.84rem;">${esc(c.cityName)}</strong> <span style="font-size:0.72rem;color:var(--text-muted);">城市编码 ${esc(c.cityId)}</span></div>
        <span style="font-size:0.74rem;color:var(--accent);font-weight:700;">切换至此城市 ▸</span>
      </div>`).join("");
  }

  function selectCityById(cityId, cityName) {
    tick();
    const cleanName = String(cityName || "上海").replace(/市$/, "");
    state.city = { cityId: String(cityId || "034"), cityName: cleanName };
    const hotMatch = S.HOT_CITIES.find(c => c.cityId === state.city.cityId || c.cityName === cleanName);
    if (hotMatch) {
      state.location = {
        name: hotMatch.spotName || (cleanName + "市中心"),
        lat: hotMatch.lat,
        lng: hotMatch.lng,
        isGcj: false
      };
    } else {
      state.location.name = cleanName + "市中心";
    }
    nearStopsData = [];
    S.saveState(state);
    window.DetailMod.closeAuxSheet();
    renderHeaderLoc();
    if (homeSubTab === "nearby") refreshNearbyStops(false);
    showToast("已切换至「" + cleanName + "」实时公交");
  }

  function openLocationPicker() {
    tick();
    const curCityName = (state.city && state.city.cityName) ? state.city.cityName : "上海";
    const isSh = state.city && state.city.cityId === "034";
    const presets = isSh ? S.SHANGHAI_PRESET_SPOTS.map((p, i) => `
      <button class="chip-btn" onclick="window.AppUI.selectPresetSpot(${i})">${esc(p.name)}</button>
    `).join(" ") : "";
    const html = `
      <div style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div style="font-size:0.8rem;color:var(--text-sub);">当前城市：<strong style="color:var(--accent);">${esc(curCityName)}</strong></div>
        <button class="chip-btn" style="color:var(--accent);" onclick="window.AppUI.openCityPickerModal()">切换全国城市 ▾</button>
      </div>
      <div style="margin-bottom:12px;">
        <button class="chip-btn primary" style="width:100%;padding:9px;font-size:0.83rem;" onclick="window.AppUI.triggerGpsLocate()">
          使用手机 GPS 自动定位当前城市与路口
        </button>
      </div>
      <div class="search-bar" style="margin-bottom:10px;">
        <input id="locQueryInput" type="text" placeholder="输入${esc(curCityName)}路名或地标检索周边站台" />
        <button class="text-btn" style="color:var(--accent);" onclick="window.AppUI.runGeocodeSearch()">搜索</button>
      </div>
      <div id="geoSearchList" style="margin-bottom:12px;"></div>
      ${isSh ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:6px;">上海快捷地标</div><div style="display:flex;flex-wrap:wrap;gap:6px;">${presets}</div>` : ""}`;
    window.DetailMod.openAuxSheet("切换定位位置 / 城市", "");
    document.getElementById("auxSheetBody").innerHTML = html;
  }

  async function runGeocodeSearch() {
    const inp = document.getElementById("locQueryInput");
    const q = inp ? inp.value.trim() : "";
    if (!q) return;
    tick();
    const curCityName = (state.city && state.city.cityName) ? state.city.cityName : "上海";
    const box = document.getElementById("geoSearchList");
    box.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 0;">正在检索${esc(curCityName)}地址…</div>`;
    const res = await S.callBusApi("geocode", { cityName: curCityName, query: q });
    const list = (res.ok && Array.isArray(res.data)) ? res.data : [];
    if (list.length === 0) {
      box.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 0;">未找到对应地点，请尝试输入具体路名</div>`;
      return;
    }
    window.__geoCandidates = list;
    box.innerHTML = list.map((g, i) => `
      <div class="near-line-row" onclick="window.AppUI.applyGeoCandidate(${i})">
        <div>
          <div style="font-size:0.82rem;font-weight:800;">${esc(g.name)}</div>
          <div style="font-size:0.71rem;color:var(--text-muted);">${esc(g.detail || "")}</div>
        </div>
        <span style="font-size:0.74rem;color:var(--accent);font-weight:700;">设为当前</span>
      </div>`).join("");
  }

  function applyGeoCandidate(idx) {
    const g = (window.__geoCandidates || [])[idx];
    if (!g) return;
    state.location = { name: g.name, lat: g.lat, lng: g.lng, isGcj: !!g.isGcj };
    S.saveState(state);
    window.DetailMod.closeAuxSheet();
    renderHeaderLoc();
    switchHomeSubTab("nearby");
    showToast("已切换位置至：" + g.name);
  }

  function selectPresetSpot(idx) {
    const p = S.SHANGHAI_PRESET_SPOTS[idx];
    if (!p) return;
    tick();
    state.location = { ...p };
    S.saveState(state);
    window.DetailMod.closeAuxSheet();
    renderHeaderLoc();
    if (homeSubTab === "nearby") refreshNearbyStops(false);
    showToast("已切换至：" + p.name);
  }

  function triggerGpsLocate() {
    tick();
    if (window.AndroidBridge && typeof window.AndroidBridge.requestNativeLocation === "function") {
      showToast("正在请求手机 GPS / 移动网络定位…");
      window.AndroidBridge.requestNativeLocation();
    } else {
      showToast("当前环境不支持原生定位");
    }
  }

  window.__onNativeLocation = async function (payload) {
    if (!payload || !payload.ok) {
      showToast((payload && payload.error) ? payload.error : "定位未成功，请检查手机定位开关");
      return;
    }
    const lat = payload.gcjLat || payload.wgsLat;
    const lng = payload.gcjLng || payload.wgsLng;
    const isGcj = !!payload.gcjLat;
    state.location = {
      name: payload.name || "当前实时定位",
      lat,
      lng,
      isGcj
    };
    // 自动根据 GPS 经纬度检测所在城市（支持去外地自动切换 cityId）
    try {
      const cRes = await S.callBusApi("cityList", { lat, lng, isGcj });
      if (cRes.ok && cRes.data && Array.isArray(cRes.data.cityList)) {
        allCitiesCache = cRes.data.cityList;
        const gpsCity = cRes.data.cityList.find(c => Number(c.isGpsCity) === 1);
        if (gpsCity && gpsCity.cityId) {
          state.city = {
            cityId: String(gpsCity.cityId),
            cityName: String(gpsCity.cityName || "").replace(/市$/, "")
          };
        }
      }
    } catch (e) {}
    S.saveState(state);
    window.DetailMod.closeAuxSheet();
    renderHeaderLoc();
    refreshNearbyStops(false);
    showToast("已定位至：" + state.city.cityName + " · " + state.location.name);
  };

  // Watch Service Sync
  function toggleWatchForItem(item) {
    tick();
    if (watchState.active && watchState.watchKey === item.key) {
      stopWatchNow();
      return;
    }
    const cfg = {
      watchKey: item.key,
      cityId: item.cityId || (state.city && state.city.cityId) || "034",
      lineId: item.lineId,
      lineName: item.lineName,
      direction: String(item.direction || "0"),
      endSn: item.endSn || "",
      stationId: item.stationId || "",
      stationName: item.stationName || "",
      nextStationName: item.nextStationName || "",
      lineNo: item.lineNo || "",
      targetOrder: Number(item.targetOrder || 1),
      alertStops: state.settings.alertStops,
      alertMinutes: state.settings.alertMinutes,
      nightDnd: state.settings.nightDnd
    };
    if (window.AndroidBridge && typeof window.AndroidBridge.startBusWatch === "function") {
      window.AndroidBridge.startBusWatch(JSON.stringify(cfg));
      showToast("已开启通知栏实时盯梢，快到站自动震动提醒");
    } else {
      showToast("请在安卓客户端中使用通知栏盯梢");
    }
  }

  function stopWatchNow() {
    tick();
    if (window.AndroidBridge && typeof window.AndroidBridge.stopBusWatch === "function") {
      window.AndroidBridge.stopBusWatch();
    }
    watchState = { active: false, watchKey: "", summary: "" };
    renderWatchBanner();
    renderFavoritesList();
    showToast("已结束等车盯梢");
  }

  window.__onNativeWatchSync = function (st) {
    if (!st) return;
    watchState = st;
    renderWatchBanner();
    renderFavoritesList();
  };

  function renderWatchBanner() {
    const el = document.getElementById("watchBanner");
    if (!el) return;
    if (!watchState.active) {
      el.classList.remove("show");
      return;
    }
    el.classList.add("show");
    document.getElementById("watchBannerTitle").textContent =
      S.formatRouteDisplayName(watchState.lineName) + " · 候车：" + (watchState.stationName || "");
    document.getElementById("watchBannerDesc").textContent = watchState.summary || "每 15 秒后台刷新中…";
  }

  // Page & Settings Management
  function switchMainPage(page) {
    tick();
    activePage = page;
    document.getElementById("pageHome").style.display = page === "home" ? "block" : "none";
    document.getElementById("pageSettings").style.display = page === "settings" ? "block" : "none";
    document.getElementById("tabHome").classList.toggle("active", page === "home");
    document.getElementById("tabSettings").classList.toggle("active", page === "settings");
    if (page === "settings") renderSettingsPage();
  }

  function switchHomeSubTab(sub) {
    tick();
    homeSubTab = sub;
    document.getElementById("segFav").classList.toggle("active", sub === "fav");
    document.getElementById("segNearby").classList.toggle("active", sub === "nearby");
    document.getElementById("favListBox").style.display = sub === "fav" ? "block" : "none";
    document.getElementById("nearbyViewWrap").style.display = sub === "nearby" ? "block" : "none";
    if (sub === "nearby") refreshNearbyStops(false);
    else refreshFavorites(false);
  }

  function renderSettingsPage() {
    document.getElementById("valAlertStops").textContent = state.settings.alertStops + " 站";
    document.getElementById("valAlertMins").textContent = state.settings.alertMinutes + " 分钟";
    document.getElementById("chkNightDnd").checked = !!state.settings.nightDnd;
    document.getElementById("selThemeMode").value = state.settings.themeMode || "auto";

    const kaBtn = document.getElementById("btnKeepAlive");
    if (kaBtn) {
      let granted = false;
      try {
        if (window.AndroidBridge && typeof window.AndroidBridge.isKeepAliveGranted === "function") {
          granted = !!window.AndroidBridge.isKeepAliveGranted();
        }
      } catch (e) {}
      kaBtn.textContent = granted ? "✓ 已开启省电白名单" : "省电白名单（仅需点一次）";
    }

    const mBox = document.getElementById("manageFavBox");
    if (state.favorites.length === 0) {
      mBox.innerHTML = `<div style="font-size:0.78rem;color:var(--text-muted);padding:6px 0;">当前无置顶线路</div>`;
    } else {
      mBox.innerHTML = state.favorites.map((f, i) => `
        <div class="setting-row">
          <div>
            <strong>${esc(S.formatRouteDisplayName(f.lineName))}</strong> · ${esc(f.stationName)}
            <div style="font-size:0.72rem;color:var(--text-muted);">开往 ${esc(f.endSn)}</div>
          </div>
          <div style="display:flex;gap:5px;">
            ${i > 0 ? `<button class="chip-btn" onclick="window.AppUI.moveFavUp(${i})">上移</button>` : ""}
            <button class="chip-btn" onclick="window.AppUI.removeFavAt(${i})">移除</button>
          </div>
        </div>`).join("");
    }
  }

  function adjustSetting(field, delta, minV, maxV) {
    tick();
    const next = Math.min(maxV, Math.max(minV, Number(state.settings[field]) + delta));
    state.settings[field] = next;
    S.saveState(state);
    renderSettingsPage();
  }

  function renderHeaderLoc() {
    const cityName = (state.city && state.city.cityName) ? state.city.cityName : "上海";
    const locEl = document.getElementById("locNameText");
    if (locEl) {
      locEl.textContent = cityName + " · " + (state.location.name || "市中心");
    }
    const topBtn = document.getElementById("topCityBtn");
    if (topBtn) {
      topBtn.textContent = cityName + " ▾";
    }
    const searchInp = document.getElementById("searchInput");
    if (searchInp) {
      searchInp.placeholder = "在「" + cityName + "」搜站台选线路，或临时查公交";
    }
  }

  function updateRefreshStamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    document.getElementById("refreshStamp").textContent = hh + ":" + mm + ":" + ss + " 更新";
  }

  function startAutoLoop() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = setInterval(() => {
      if (document.hidden) return;
      if (window.DetailMod.isOpen()) {
        window.DetailMod.refreshLineDetailModal(false);
      } else if (activePage === "home") {
        if (homeSubTab === "fav") refreshFavorites(false);
        else refreshNearbyStops(false);
      }
    }, (state.settings.autoRefreshSec || 15) * 1000);
  }

  // Hardware Back Key Support
  window.__handleHardwareBack = function () {
    if (window.DetailMod.isAuxOpen()) {
      window.DetailMod.closeAuxSheet();
      return true;
    }
    if (window.DetailMod.isOpen()) {
      window.DetailMod.closeLineDetailModal();
      return true;
    }
    if (activePage === "settings") {
      switchMainPage("home");
      return true;
    }
    return false;
  };

  window.AppUI = {
    tick,
    showToast,
    hideToast,
    formatSafeError,
    getState: () => state,
    getWatchState: () => watchState,
    extractBestStnState,
    isFavoriteKey: (key) => state.favorites.some(x => x.key === key),
    toggleFavoriteEntry: (entry) => {
      const idx = state.favorites.findIndex(x => x.key === entry.key);
      if (idx >= 0) {
        state.favorites.splice(idx, 1);
        S.saveState(state);
        renderFavoritesList();
        return false;
      }
      state.favorites.unshift(entry);
      S.saveState(state);
      refreshFavorites(false);
      return true;
    },
    openFavCard: (idx) => {
      const item = state.favorites[idx];
      if (item) window.DetailMod.openLineDetailModal(item);
    },
    flipFavCard,
    toggleWatchFav: (idx) => {
      const item = state.favorites[idx];
      if (item) toggleWatchForItem(item);
    },
    toggleWatchForItem,
    stopWatchNow,
    refreshCurrent: () => {
      if (homeSubTab === "fav") refreshFavorites(true);
      else refreshNearbyStops(true);
    },
    switchMainPage,
    switchHomeSubTab,
    onSearchInput,
    clearSearch,
    pickSearchResultLine,
    pickSearchResultStation,
    openCityPickerModal,
    filterCityList,
    selectCityById,
    openLocationPicker,
    runGeocodeSearch,
    applyGeoCandidate,
    selectPresetSpot,
    triggerGpsLocate,
    adjustSetting,
    toggleNightDnd: (checked) => {
      state.settings.nightDnd = !!checked;
      S.saveState(state);
      showToast(checked ? "已开启夜间免打扰（23:00-07:00静默）" : "已关闭夜间免打扰");
    },
    changeThemeMode: (mode) => {
      state.settings.themeMode = mode;
      S.saveState(state);
      applyTheme();
    },
    moveFavUp: (idx) => {
      if (idx <= 0) return;
      tick();
      const tmp = state.favorites[idx - 1];
      state.favorites[idx - 1] = state.favorites[idx];
      state.favorites[idx] = tmp;
      S.saveState(state);
      renderSettingsPage();
      renderFavoritesList();
    },
    removeFavAt: (idx) => {
      tick();
      state.favorites.splice(idx, 1);
      S.saveState(state);
      renderSettingsPage();
      renderFavoritesList();
      showToast("已移除该置顶线路");
    },
    sendTestAlert: () => {
      tick();
      if (window.AndroidBridge && typeof window.AndroidBridge.sendTestNotification === "function") {
        window.AndroidBridge.sendTestNotification(
          "24路 → 豆市街复兴东路 快到站啦！",
          "候车站「陕西北路南京西路」：还有 1 站 · 约 2 分钟，请准备上车。"
        );
      }
      showToast("已发送测试到站震动通知");
    },
    openBatteryKeepAlive: () => {
      tick();
      if (window.AndroidBridge && typeof window.AndroidBridge.openKeepAliveSettings === "function") {
        window.AndroidBridge.openKeepAliveSettings();
      } else {
        showToast("请在系统设置中允许后台无限制运行");
      }
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    applyTheme();
    renderHeaderLoc();
    if (window.AndroidBridge && typeof window.AndroidBridge.getWatchState === "function") {
      try {
        watchState = JSON.parse(window.AndroidBridge.getWatchState());
        renderWatchBanner();
      } catch (e) {}
    }
    renderFavoritesList();
    refreshFavorites(false);
    startAutoLoop();
  });
})();
