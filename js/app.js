/* Ghost-net survey map – Israeli Mediterranean coast.
 * Static app: Leaflet map + surveys stored in the browser (localStorage),
 * with JSON backup/import and GeoJSON/CSV export for sharing. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- constants
  const STORAGE_KEY = "divepoints-v1";
  const SHALLOW_LIMIT = 15;

  const REGIONS = {
    north: "צפון", carmel: "חיפה והכרמל", sharon: "השרון", center: "גוש דן", south: "דרום",
  };
  const CATEGORIES = {
    reef:        { label: "ריף / רכס סלעי", icon: "🪸" },
    wreck:       { label: "ספינה טרופה",    icon: "⚓" },
    pipe:        { label: "צינור / תשתית",  icon: "🛢" },
    breakwater:  { label: "שובר גלים / נמל", icon: "🧱" },
    archaeology: { label: "אתר ארכאולוגי",  icon: "🏛" },
    island:      { label: "אי / סלע",        icon: "🏝" },
    other:       { label: "אחר",             icon: "📍" },
  };
  const STATUSES = {
    unsurveyed: { label: "טרם נסקר",          color: "var(--st-unsurveyed)", hex: "#8a96a3" },
    clean:      { label: "נסקר – ללא ממצאים", color: "var(--st-clean)",      hex: "#2e9d5b" },
    nets:       { label: "נסקר – נמצאו רשתות", color: "var(--st-nets)",       hex: "#d23a3a" },
    partial:    { label: "נסקר חלקית",        color: "var(--st-partial)",    hex: "#e88b1a" },
    aborted:    { label: "לא בוצע (בוטל)",    color: "var(--st-aborted)",    hex: "#7a5cc4" },
  };
  const RISK = { high: "גבוה", medium: "בינוני", low: "נמוך" };

  const SURVEY_STATUS = { done: "בוצע", partial: "בוצע חלקית", "not-done": "לא בוצע" };
  const FINDING_TYPES = {
    "gill-net": "רשת עומדת (מכמורת/רשת השהייה)",
    "trammel": "רשת משולשת",
    "line": "חוט דיג / חכה",
    "longline": "פרנגל (קו ארוך)",
    "trap": "מלכודת / כלוב",
    "rope": "חבל",
    "other": "אחר",
  };
  const REMOVED = { yes: "הוסר במלואו", partial: "הוסר חלקית", no: "לא הוסר" };

  // -------------------------------------------------------------------- state
  const state = loadState();
  let map, markersLayer, routesLayer, tempLayer;
  const markerById = {};
  let drawMode = null;     // { type, ... }
  let draft = null;        // survey currently being edited
  let gpsWatchId = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return { customSites: s.customSites || [], siteEdits: s.siteEdits || {}, surveys: s.surveys || [] };
      }
    } catch (e) { console.error(e); }
    return { customSites: [], siteEdits: {}, surveys: [] };
  }
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("שגיאה בשמירה: " + e.message);
    }
  }

  // ------------------------------------------------------------------ helpers
  const $ = (sel) => document.querySelector(sel);
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function uid(prefix) {
    return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), 3500);
  }
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function fmtDepth(d) { return d ? `${d[0]}–${d[1]} מ'` : "—"; }
  function routeLengthM(route) {
    let m = 0;
    for (let i = 1; i < (route || []).length; i++) m += L.latLng(route[i - 1]).distanceTo(L.latLng(route[i]));
    return Math.round(m);
  }

  // -------------------------------------------------------------------- sites
  function allSites() {
    const base = window.DIVE_SITES.map((s) => applyEdits(Object.assign({ verified: false }, s)));
    const custom = state.customSites.map((s) => applyEdits(Object.assign({ custom: true, verified: true }, s)));
    return base.concat(custom);
  }
  function applyEdits(site) {
    const e = state.siteEdits[site.id];
    if (!e) return site;
    if (site.line && e.lat != null) {
      const dLat = e.lat - site.lat, dLng = e.lng - site.lng;
      site.line = site.line.map(([a, b]) => [a + dLat, b + dLng]);
    }
    return Object.assign(site, e);
  }
  function getSite(id) { return allSites().find((s) => s.id === id); }

  function surveysFor(siteId) {
    return state.surveys
      .filter((s) => s.siteId === siteId)
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
  }
  function siteStatus(siteId) {
    const last = surveysFor(siteId)[0];
    if (!last) return "unsurveyed";
    if (last.status === "not-done") return "aborted";
    if (last.netsFound === "yes") return "nets";
    if (last.status === "partial") return "partial";
    return "clean";
  }

  // ---------------------------------------------------------------------- map
  function initMap() {
    map = L.map("map", { zoomControl: true }).setView([32.55, 34.9], 9);

    const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
    });
    const sat = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery &copy; Esri" });
    const ocean = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 13, attribution: "&copy; Esri, GEBCO, NOAA" });
    const seamarks = L.tileLayer("https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "&copy; OpenSeaMap",
    });

    sat.addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    routesLayer = L.layerGroup().addTo(map);
    tempLayer = L.layerGroup().addTo(map);

    L.control.layers(
      { "תצלום אוויר": sat, "מפת רחובות": osm, "מפה ימית (עומקים)": ocean },
      { "סימוני ים (OpenSeaMap)": seamarks, "מסלולי סקרים": routesLayer },
      { position: "topleft" }
    ).addTo(map);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

    map.on("click", onMapClick);
  }

  function markerIcon(site, status) {
    const st = STATUSES[status];
    const cat = CATEGORIES[site.category] || CATEGORIES.other;
    return L.divIcon({
      className: "",
      html: `<div class="site-marker${site.verified || site.src === "osm" ? "" : " unverified"}" style="background:${st.hex}" title="${esc(site.name)}">${cat.icon}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -12],
    });
  }

  function renderMap() {
    markersLayer.clearLayers();
    for (const k in markerById) delete markerById[k];
    const visible = new Set(filteredSites().map((s) => s.id));

    for (const site of allSites()) {
      if (!visible.has(site.id)) continue;
      const status = siteStatus(site.id);
      if (site.line) {
        L.polyline(site.line, { color: STATUSES[status].hex, weight: 5, opacity: 0.85, dashArray: site.verified || site.src === "osm" ? null : "8 6" })
          .bindPopup(() => popupHtml(site.id))
          .addTo(markersLayer);
      }
      const m = L.marker([site.lat, site.lng], { icon: markerIcon(site, status) })
        .bindPopup(() => popupHtml(site.id), { maxWidth: 300 })
        .addTo(markersLayer);
      markerById[site.id] = m;
    }
    renderRoutes();
  }

  function renderRoutes() {
    routesLayer.clearLayers();
    for (const s of state.surveys) {
      if (s.route && s.route.length > 1) {
        L.polyline(s.route, { color: "#ffd400", weight: 3, opacity: 0.9 })
          .bindTooltip(`${esc((getSite(s.siteId) || {}).name || "")} · ${esc(s.date)}`)
          .addTo(routesLayer);
      }
      for (const f of s.findings || []) {
        if (f.lat != null) {
          L.circleMarker([f.lat, f.lng], { radius: 6, color: "#fff", weight: 2, fillColor: "#d23a3a", fillOpacity: 1 })
            .bindTooltip(`ממצא: ${esc(FINDING_TYPES[f.type] || f.type)}`)
            .addTo(routesLayer);
        }
      }
    }
  }

  function popupHtml(siteId) {
    const site = getSite(siteId);
    const status = siteStatus(siteId);
    const surveys = surveysFor(siteId);
    const last = surveys[0];
    const cat = CATEGORIES[site.category] || CATEGORIES.other;
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${site.lat},${site.lng}`;
    return `<div class="popup">
      <h3>${cat.icon} ${esc(site.name)}</h3>
      <div class="meta">${esc(cat.label)} · ${esc(REGIONS[site.region] || "")} · עומק ${fmtDepth(site.depth)} · סיכון ${esc(RISK[site.risk] || "—")}</div>
      <span class="badge" style="background:${STATUSES[status].hex}">${STATUSES[status].label}</span>
      <p>${esc(site.desc || "")}</p>
      ${site.verified ? "" : site.src === "osm"
        ? `<div class="warn">📍 מיקום לפי OpenStreetMap – מומלץ לאמת בשטח</div>`
        : `<div class="warn">⚠ מיקום משוער – יש לאמת בשטח (ניתן לגרור עם "תקן מיקום")</div>`}
      ${last ? `<div class="meta">סקר אחרון: ${esc(last.date)} · ${esc(SURVEY_STATUS[last.status])} · סה"כ ${surveys.length} סקרים</div>` : ""}
      <div class="meta">${site.lat.toFixed(5)}, ${site.lng.toFixed(5)}</div>
      <div class="actions">
        <button class="btn small" data-act="new-survey" data-id="${esc(site.id)}">+ סקר חדש</button>
        <button class="btn btn-ghost small" data-act="history" data-id="${esc(site.id)}">היסטוריה (${surveys.length})</button>
        <button class="btn btn-ghost small" data-act="move" data-id="${esc(site.id)}">תקן מיקום</button>
        ${site.verified ? "" : `<button class="btn btn-ghost small" data-act="verify" data-id="${esc(site.id)}">אשר מיקום</button>`}
        <a class="btn btn-ghost small" href="${gmaps}" target="_blank" rel="noopener">ניווט</a>
        ${site.custom ? `<button class="btn btn-ghost small" data-act="edit-site" data-id="${esc(site.id)}">ערוך</button>` : ""}
      </div>
    </div>`;
  }

  // ----------------------------------------------------------------- sidebar
  function filteredSites() {
    const q = $("#search").value.trim();
    const region = $("#filter-region").value;
    const cat = $("#filter-category").value;
    const st = $("#filter-status").value;
    const shallow = $("#filter-shallow").checked;
    return allSites().filter((s) =>
      (!q || s.name.includes(q) || (s.desc || "").includes(q)) &&
      (!region || s.region === region) &&
      (!cat || s.category === cat) &&
      (!st || siteStatus(s.id) === st) &&
      (!shallow || !s.depth || s.depth[0] <= SHALLOW_LIMIT));
  }

  function renderSidebar() {
    const sites = filteredSites();
    const all = allSites();
    const counts = {};
    for (const s of all) { const k = siteStatus(s.id); counts[k] = (counts[k] || 0) + 1; }
    const surveyed = all.length - (counts.unsurveyed || 0);
    $("#stats").innerHTML = `
      <div class="stat"><b>${all.length}</b><span>אתרים</span></div>
      <div class="stat"><b>${surveyed}</b><span>נסקרו</span></div>
      <div class="stat"><b style="color:${STATUSES.nets.hex}">${counts.nets || 0}</b><span>עם רשתות</span></div>`;

    $("#site-list").innerHTML = sites.map((s) => {
      const st = siteStatus(s.id);
      const cat = CATEGORIES[s.category] || CATEGORIES.other;
      return `<li data-id="${esc(s.id)}">
        <span class="dot" style="background:${STATUSES[st].hex}"></span>
        <div><div class="name">${cat.icon} ${esc(s.name)}</div>
        <div class="meta">${esc(REGIONS[s.region] || "")} · ${fmtDepth(s.depth)} · ${STATUSES[st].label}</div></div>
      </li>`;
    }).join("") || `<li class="meta">אין אתרים תואמים</li>`;
  }

  function renderAll() { renderSidebar(); renderMap(); }

  function initSidebar() {
    $("#filter-category").innerHTML += Object.entries(CATEGORIES)
      .map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join("");
    $("#filter-status").innerHTML += Object.entries(STATUSES)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
    $("#legend").innerHTML = Object.values(STATUSES)
      .map((v) => `<span><i style="background:${v.hex}"></i>${v.label}</span>`).join("") +
      `<span>מסגרת מקווקוות = מיקום משוער</span>`;

    ["#search", "#filter-region", "#filter-category", "#filter-status", "#filter-shallow"].forEach((sel) =>
      $(sel).addEventListener("input", renderAll));

    $("#site-list").addEventListener("click", (e) => {
      const li = e.target.closest("li[data-id]");
      if (!li) return;
      const site = getSite(li.dataset.id);
      map.setView([site.lat, site.lng], Math.max(map.getZoom(), 15));
      setTimeout(() => markerById[site.id] && markerById[site.id].openPopup(), 300);
      if (window.innerWidth <= 760) $("#sidebar").classList.add("collapsed");
    });

    $("#toggle-sidebar").addEventListener("click", () => {
      $("#sidebar").classList.toggle("collapsed");
      setTimeout(() => map.invalidateSize(), 50);
    });
    if (window.innerWidth <= 760) $("#sidebar").classList.add("collapsed");
  }

  // -------------------------------------------------------------- popup acts
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case "new-survey": map.closePopup(); openSurveyForm(newSurvey(id)); break;
      case "history": map.closePopup(); openHistory(id); break;
      case "move": map.closePopup(); startMoveSite(id); break;
      case "verify": setSiteEdit(id, { verified: true }); map.closePopup(); renderAll(); toast("המיקום סומן כמאומת"); break;
      case "edit-site": map.closePopup(); openSiteForm(getSite(id)); break;
    }
  });

  function setSiteEdit(id, patch) {
    const custom = state.customSites.find((s) => s.id === id);
    if (custom) Object.assign(custom, patch);
    else state.siteEdits[id] = Object.assign({}, state.siteEdits[id], patch);
    saveState();
  }

  function startMoveSite(id) {
    const site = getSite(id);
    const m = markerById[id];
    if (!m) return;
    m.dragging.enable();
    const original = m.getLatLng();
    setDrawMode({ type: "move", siteId: id }, `גרור את "${site.name}" למיקום הנכון ולחץ סיום`, {
      done: () => {
        const ll = m.getLatLng();
        setSiteEdit(id, { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), verified: true });
        renderAll();
        toast("המיקום עודכן");
      },
      cancel: () => { m.setLatLng(original); m.dragging.disable(); },
      noUndo: true,
    });
  }

  // ------------------------------------------------------------- draw modes
  function setDrawMode(mode, msg, handlers) {
    drawMode = Object.assign(mode, handlers);
    $("#draw-msg").textContent = msg;
    $("#draw-undo").classList.toggle("hidden", !!handlers.noUndo);
    $("#draw-bar").classList.remove("hidden");
    $("#map").style.cursor = "crosshair";
    // Let clicks pass through markers/lines so points can be placed on top of them.
    $("#map").classList.toggle("drawing", !!handlers.click);
  }
  function endDrawMode() {
    drawMode = null;
    tempLayer.clearLayers();
    $("#draw-bar").classList.add("hidden");
    $("#map").style.cursor = "";
    $("#map").classList.remove("drawing");
  }
  function updateDrawMsg(msg) { $("#draw-msg").textContent = msg; }

  $("#draw-done").addEventListener("click", () => { const m = drawMode; endDrawMode(); m && m.done && m.done(); });
  $("#draw-cancel").addEventListener("click", () => { const m = drawMode; endDrawMode(); m && m.cancel && m.cancel(); });
  $("#draw-undo").addEventListener("click", () => drawMode && drawMode.undo && drawMode.undo());

  function onMapClick(e) {
    if (!drawMode || !drawMode.click) return;
    drawMode.click(e.latlng);
  }

  $("#add-site-btn").addEventListener("click", () => {
    setDrawMode({ type: "new-site" }, "לחץ על המפה במיקום האתר החדש", {
      noUndo: true,
      click: (ll) => { endDrawMode(); openSiteForm({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }); },
      done: () => {},
    });
  });

  // ---------------------------------------------------------------- modal
  function openModal(html) {
    $("#modal-body").innerHTML = html;
    $("#modal").classList.remove("hidden");
    $("#modal").scrollTop = 0;
  }
  function closeModal() { $("#modal").classList.add("hidden"); }
  $("#modal-close").addEventListener("click", () => { closeModal(); draft = null; });

  // -------------------------------------------------------- custom site form
  function openSiteForm(site) {
    const isNew = !site.id;
    openModal(`<h2>${isNew ? "אתר חדש" : "עריכת אתר"}</h2>
      <form id="site-form">
        <div class="grid">
          <label class="field wide"><span>שם האתר</span><input name="name" required value="${esc(site.name || "")}"></label>
          <label class="field"><span>סוג</span><select name="category">${opts(mapLabels(CATEGORIES), site.category || "reef")}</select></label>
          <label class="field"><span>אזור</span><select name="region">${opts(REGIONS, site.region || guessRegion(site.lat))}</select></label>
          <label class="field"><span>עומק מינימלי (מ')</span><input name="dmin" type="number" step="0.5" value="${site.depth ? site.depth[0] : ""}"></label>
          <label class="field"><span>עומק מקסימלי (מ')</span><input name="dmax" type="number" step="0.5" value="${site.depth ? site.depth[1] : ""}"></label>
          <label class="field"><span>סיכון לרשתות</span><select name="risk">${opts(RISK, site.risk || "medium")}</select></label>
          <label class="field"><span>קו רוחב</span><input name="lat" type="number" step="any" required value="${site.lat}"></label>
          <label class="field"><span>קו אורך</span><input name="lng" type="number" step="any" required value="${site.lng}"></label>
          <label class="field wide"><span>תיאור</span><textarea name="desc">${esc(site.desc || "")}</textarea></label>
        </div>
        <div class="form-actions">
          <button class="btn" type="submit">שמור</button>
          ${!isNew ? `<button class="btn btn-danger" type="button" id="delete-site">מחק אתר</button>` : ""}
        </div>
      </form>`);
    $("#site-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const data = {
        name: f.get("name").trim(), category: f.get("category"), region: f.get("region"),
        risk: f.get("risk"), desc: f.get("desc").trim(),
        lat: +f.get("lat"), lng: +f.get("lng"),
        depth: f.get("dmin") !== "" && f.get("dmax") !== "" ? [+f.get("dmin"), +f.get("dmax")] : null,
        verified: true,
      };
      if (isNew) state.customSites.push(Object.assign({ id: uid("custom") }, data));
      else Object.assign(state.customSites.find((s) => s.id === site.id), data);
      saveState(); closeModal(); renderAll(); toast("האתר נשמר");
    });
    const del = $("#delete-site");
    if (del) del.addEventListener("click", () => {
      const n = surveysFor(site.id).length;
      if (!confirm(`למחוק את "${site.name}"${n ? ` ואת ${n} הסקרים שלו` : ""}?`)) return;
      state.customSites = state.customSites.filter((s) => s.id !== site.id);
      state.surveys = state.surveys.filter((s) => s.siteId !== site.id);
      saveState(); closeModal(); renderAll();
    });
  }
  function guessRegion(lat) {
    if (lat >= 32.9) return "north";
    if (lat >= 32.48) return "carmel";
    if (lat >= 32.15) return "sharon";
    if (lat >= 31.97) return "center";
    return "south";
  }
  function mapLabels(obj) { const o = {}; for (const k in obj) o[k] = obj[k].label || obj[k]; return o; }
  function opts(obj, selected, withEmpty) {
    return (withEmpty ? `<option value="">—</option>` : "") +
      Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === selected ? " selected" : ""}>${esc(v)}</option>`).join("");
  }

  // -------------------------------------------------------------- survey form
  function newSurvey(siteId) {
    return {
      id: uid("survey"), siteId, isNew: true,
      date: today(), timeStart: "", team: "", status: "done", notDoneReason: "",
      netsFound: "no", findings: [],
      siteDescription: "", bottomType: "", marineLife: "",
      water: { visibility: "", temp: "", current: "", currentDir: "", seaState: "", wind: "", notes: "" },
      dive: { entry: "", maxDepth: "", duration: "", divers: "", description: "" },
      route: [], routeSource: "",
    };
  }

  function openSurveyForm(s) {
    draft = s;
    const site = getSite(s.siteId);
    const w = s.water, d = s.dive;
    openModal(`<h2>סקר – ${esc(site.name)}</h2>
      <form id="survey-form">
        <fieldset><legend>פרטי הסקר</legend><div class="grid">
          <label class="field"><span>תאריך</span><input type="date" name="date" value="${esc(s.date)}" required></label>
          <label class="field"><span>שעת כניסה</span><input type="time" name="timeStart" value="${esc(s.timeStart)}"></label>
          <label class="field"><span>סטטוס</span><select name="status">${opts(SURVEY_STATUS, s.status)}</select></label>
          <label class="field wide"><span>צוות / צוללים</span><input name="team" value="${esc(s.team)}" placeholder="שמות הצוללים, ראש צוות"></label>
          <label class="field wide" id="reason-field"><span>סיבה לאי ביצוע / ביצוע חלקי</span><input name="notDoneReason" value="${esc(s.notDoneReason)}" placeholder="למשל: ים גבוה, ראות אפסית, תקלה בציוד"></label>
        </div></fieldset>

        <fieldset><legend>ממצאים</legend>
          <div class="row">
            <label class="check"><input type="radio" name="netsFound" value="no"${s.netsFound === "no" ? " checked" : ""}> לא נמצאו רשתות / ציוד דיג</label>
            <label class="check"><input type="radio" name="netsFound" value="yes"${s.netsFound === "yes" ? " checked" : ""}> נמצאו רשתות / ציוד דיג</label>
          </div>
          <div id="findings-wrap">
            <div id="findings">${s.findings.map(findingHtml).join("")}</div>
            <button type="button" class="btn btn-ghost small" id="add-finding">+ הוסף ממצא</button>
          </div>
        </fieldset>

        <fieldset><legend>תיאור האתר</legend><div class="grid">
          <label class="field"><span>סוג קרקעית</span><input name="bottomType" value="${esc(s.bottomType)}" placeholder="סלע כורכר, חול, נקיקים…"></label>
          <label class="field"><span>חי ים בולט</span><input name="marineLife" value="${esc(s.marineLife)}"></label>
          <label class="field wide"><span>תיאור האתר</span><textarea name="siteDescription">${esc(s.siteDescription)}</textarea></label>
        </div></fieldset>

        <fieldset><legend>תנאי המים</legend><div class="grid">
          <label class="field"><span>ראות (מ')</span><input type="number" step="0.5" name="w.visibility" value="${esc(w.visibility)}"></label>
          <label class="field"><span>טמפ' מים (°C)</span><input type="number" step="0.5" name="w.temp" value="${esc(w.temp)}"></label>
          <label class="field"><span>זרם</span><select name="w.current">${opts({ none: "אין", weak: "חלש", moderate: "בינוני", strong: "חזק" }, w.current, true)}</select></label>
          <label class="field"><span>כיוון זרם</span><select name="w.currentDir">${opts({ N: "צפון", S: "דרום", E: "מזרח (לחוף)", W: "מערב (מהחוף)" }, w.currentDir, true)}</select></label>
          <label class="field"><span>מצב ים / גובה גל (מ')</span><input name="w.seaState" value="${esc(w.seaState)}" placeholder="למשל: 0.5"></label>
          <label class="field"><span>רוח</span><input name="w.wind" value="${esc(w.wind)}" placeholder="כיוון ועוצמה"></label>
          <label class="field wide"><span>הערות על תנאי המים</span><textarea name="w.notes">${esc(w.notes)}</textarea></label>
        </div></fieldset>

        <fieldset><legend>הצלילה והמסלול</legend><div class="grid">
          <label class="field"><span>נקודת כניסה</span><input name="d.entry" value="${esc(d.entry)}" placeholder="חוף / סירה"></label>
          <label class="field"><span>עומק מקסימלי (מ')</span><input type="number" step="0.1" name="d.maxDepth" value="${esc(d.maxDepth)}"></label>
          <label class="field"><span>משך (דק')</span><input type="number" name="d.duration" value="${esc(d.duration)}"></label>
          <label class="field"><span>מספר צוללים</span><input type="number" name="d.divers" value="${esc(d.divers)}"></label>
          <label class="field wide"><span>תיאור הצלילה והמסלול</span><textarea name="d.description">${esc(d.description)}</textarea></label>
        </div>
        <div class="row">
          <button type="button" class="btn btn-ghost small" id="draw-route">✏️ צייר מסלול על המפה</button>
          <button type="button" class="btn btn-ghost small" id="gps-route">📡 הקלט GPS (מצוף/סירה)</button>
          <label class="btn btn-ghost small">📂 ייבא GPX<input type="file" id="gpx-file" accept=".gpx,application/gpx+xml" hidden></label>
          <button type="button" class="btn btn-ghost small" id="clear-route">נקה מסלול</button>
        </div>
        <div class="hint" id="route-info">${routeInfo(s)}</div>
        </fieldset>

        <div class="form-actions">
          <button class="btn" type="submit">שמור סקר</button>
          <button class="btn btn-ghost" type="button" id="cancel-survey">ביטול</button>
          ${!s.isNew ? `<button class="btn btn-danger" type="button" id="delete-survey">מחק סקר</button>` : ""}
        </div>
      </form>`);

    const form = $("#survey-form");
    const syncVisibility = () => {
      const st = form.elements.status.value;
      $("#reason-field").classList.toggle("hidden", st === "done");
      $("#findings-wrap").classList.toggle("hidden", form.elements.netsFound.value !== "yes");
    };
    form.addEventListener("change", syncVisibility);
    syncVisibility();

    $("#add-finding").addEventListener("click", () => {
      readSurveyForm();
      draft.findings.push({ type: "gill-net", amount: "", size: "", depth: "", removed: "no", notes: "", lat: null, lng: null });
      openSurveyForm(draft);
    });
    $("#findings").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]");
      if (!b) return;
      const i = +b.dataset.i;
      readSurveyForm();
      if (b.dataset.f === "remove") { draft.findings.splice(i, 1); openSurveyForm(draft); }
      if (b.dataset.f === "locate") pickFindingLocation(i);
    });

    $("#draw-route").addEventListener("click", startDrawRoute);
    $("#gps-route").addEventListener("click", startGpsRoute);
    $("#gpx-file").addEventListener("change", importGpx);
    $("#clear-route").addEventListener("click", () => {
      draft.route = []; draft.routeSource = ""; $("#route-info").innerHTML = routeInfo(draft);
    });
    $("#cancel-survey").addEventListener("click", () => { closeModal(); draft = null; });
    const del = $("#delete-survey");
    if (del) del.addEventListener("click", () => {
      if (!confirm("למחוק את הסקר?")) return;
      state.surveys = state.surveys.filter((x) => x.id !== draft.id);
      saveState(); closeModal(); draft = null; renderAll(); toast("הסקר נמחק");
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      readSurveyForm();
      const rec = JSON.parse(JSON.stringify(draft));
      delete rec.isNew;
      if (rec.netsFound !== "yes") rec.findings = [];
      rec.updatedAt = Date.now();
      const i = state.surveys.findIndex((x) => x.id === rec.id);
      if (i >= 0) state.surveys[i] = rec;
      else { rec.createdAt = rec.updatedAt; state.surveys.push(rec); }
      saveState(); closeModal(); draft = null; renderAll(); toast("הסקר נשמר");
    });
  }

  function findingHtml(f, i) {
    return `<div class="finding" data-i="${i}">
      <div class="grid">
        <label class="field"><span>סוג</span><select name="f.type">${opts(FINDING_TYPES, f.type)}</select></label>
        <label class="field"><span>כמות / יחידות</span><input name="f.amount" value="${esc(f.amount)}"></label>
        <label class="field"><span>גודל משוער (מ' / מ"ר)</span><input name="f.size" value="${esc(f.size)}"></label>
        <label class="field"><span>עומק (מ')</span><input type="number" step="0.1" name="f.depth" value="${esc(f.depth)}"></label>
        <label class="field"><span>הוסר?</span><select name="f.removed">${opts(REMOVED, f.removed)}</select></label>
        <label class="field wide"><span>הערות (מצב, בעלי חיים לכודים, נדרש ציוד)</span><input name="f.notes" value="${esc(f.notes)}"></label>
      </div>
      <div class="row">
        <button type="button" class="btn btn-ghost small" data-f="locate" data-i="${i}">📍 ${f.lat != null ? "מיקום: " + f.lat.toFixed(5) + ", " + f.lng.toFixed(5) : "סמן מיקום על המפה"}</button>
        <button type="button" class="btn btn-ghost small" data-f="remove" data-i="${i}">הסר ממצא</button>
      </div>
    </div>`;
  }

  function routeInfo(s) {
    if (!s.route || s.route.length < 2) return "לא הוגדר מסלול.";
    const src = { drawn: "צויר ידנית", gps: "הוקלט ב-GPS", gpx: "יובא מ-GPX" }[s.routeSource] || "";
    return `מסלול: ${s.route.length} נקודות · ${routeLengthM(s.route)} מ' · ${src}`;
  }

  function readSurveyForm() {
    const form = $("#survey-form");
    if (!form || !draft) return;
    const f = new FormData(form);
    draft.date = f.get("date");
    draft.timeStart = f.get("timeStart");
    draft.status = f.get("status");
    draft.team = f.get("team");
    draft.notDoneReason = f.get("notDoneReason");
    draft.netsFound = f.get("netsFound") || "no";
    draft.bottomType = f.get("bottomType");
    draft.marineLife = f.get("marineLife");
    draft.siteDescription = f.get("siteDescription");
    for (const k of Object.keys(draft.water)) draft.water[k] = f.get("w." + k) || "";
    for (const k of Object.keys(draft.dive)) draft.dive[k] = f.get("d." + k) || "";
    form.querySelectorAll(".finding").forEach((el) => {
      const fd = draft.findings[+el.dataset.i];
      el.querySelectorAll("[name^='f.']").forEach((inp) => { fd[inp.name.slice(2)] = inp.value; });
    });
  }

  // Temporarily hide the form, let the user interact with the map, then reopen.
  function withMapInteraction(fn) {
    readSurveyForm();
    closeModal();
    fn();
  }
  function reopenDraft() { if (draft) openSurveyForm(draft); }

  function startDrawRoute() {
    withMapInteraction(() => {
      const pts = draft.route.slice();
      const line = L.polyline(pts, { color: "#ffd400", weight: 4 }).addTo(tempLayer);
      const site = getSite(draft.siteId);
      map.setView([site.lat, site.lng], Math.max(map.getZoom(), 16));
      const msg = () => `לחץ על המפה להוספת נקודות למסלול (${pts.length} נק', ${routeLengthM(pts)} מ')`;
      setDrawMode({ type: "route" }, msg(), {
        click: (ll) => { pts.push([+ll.lat.toFixed(6), +ll.lng.toFixed(6)]); line.setLatLngs(pts); updateDrawMsg(msg()); },
        undo: () => { pts.pop(); line.setLatLngs(pts); updateDrawMsg(msg()); },
        done: () => { draft.route = pts; draft.routeSource = "drawn"; reopenDraft(); },
        cancel: reopenDraft,
      });
    });
  }

  function startGpsRoute() {
    if (!navigator.geolocation) { toast("המכשיר אינו תומך ב-GPS"); return; }
    withMapInteraction(() => {
      const pts = [];
      const line = L.polyline(pts, { color: "#ffd400", weight: 4 }).addTo(tempLayer);
      const msg = () => `מקליט GPS… ${pts.length} נקודות, ${routeLengthM(pts)} מ'. השאר את המסך פתוח.`;
      const stop = () => { if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; };
      gpsWatchId = navigator.geolocation.watchPosition((p) => {
        const pt = [+p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6)];
        const prev = pts[pts.length - 1];
        if (prev && L.latLng(prev).distanceTo(L.latLng(pt)) < 3) return; // ignore jitter
        pts.push(pt); line.setLatLngs(pts); map.panTo(pt); updateDrawMsg(msg());
      }, (err) => toast("שגיאת GPS: " + err.message), { enableHighAccuracy: true, maximumAge: 0 });
      setDrawMode({ type: "gps" }, "ממתין לאות GPS…", {
        noUndo: true,
        done: () => { stop(); if (pts.length > 1) { draft.route = pts; draft.routeSource = "gps"; } reopenDraft(); },
        cancel: () => { stop(); reopenDraft(); },
      });
    });
  }

  function importGpx(e) {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((txt) => {
      const xml = new DOMParser().parseFromString(txt, "application/xml");
      let nodes = xml.querySelectorAll("trkpt");
      if (!nodes.length) nodes = xml.querySelectorAll("rtept");
      if (!nodes.length) nodes = xml.querySelectorAll("wpt");
      const pts = Array.from(nodes).map((n) => [+(+n.getAttribute("lat")).toFixed(6), +(+n.getAttribute("lon")).toFixed(6)]);
      if (pts.length < 2) { toast("לא נמצאו נקודות מסלול בקובץ"); return; }
      readSurveyForm();
      draft.route = pts; draft.routeSource = "gpx";
      $("#route-info").innerHTML = routeInfo(draft);
      toast(`יובאו ${pts.length} נקודות`);
    });
  }

  function pickFindingLocation(i) {
    withMapInteraction(() => {
      const site = getSite(draft.siteId);
      map.setView([site.lat, site.lng], Math.max(map.getZoom(), 16));
      if (draft.route.length > 1) L.polyline(draft.route, { color: "#ffd400", weight: 3 }).addTo(tempLayer);
      setDrawMode({ type: "finding" }, "לחץ על המפה במיקום הממצא", {
        noUndo: true,
        click: (ll) => {
          draft.findings[i].lat = +ll.lat.toFixed(6);
          draft.findings[i].lng = +ll.lng.toFixed(6);
          endDrawMode(); reopenDraft();
        },
        done: reopenDraft,
        cancel: reopenDraft,
      });
    });
  }

  // ------------------------------------------------------------------ history
  function openHistory(siteId) {
    const site = getSite(siteId);
    const list = surveysFor(siteId);
    const v = (x, suffix) => (x === "" || x == null ? "—" : esc(x) + (suffix || ""));
    openModal(`<h2>היסטוריית סקרים – ${esc(site.name)}</h2>
      ${list.length ? "" : "<p>טרם בוצעו סקרים באתר זה.</p>"}
      ${list.map((s) => `<div class="survey-item">
        <div class="row"><b>${esc(s.date)} ${esc(s.timeStart || "")}</b>
          <span class="badge" style="background:${STATUSES[surveyStatusKey(s)].hex}">${esc(SURVEY_STATUS[s.status])}${s.netsFound === "yes" ? " · נמצאו רשתות" : ""}</span>
        </div>
        <dl>
          <dt>צוות</dt><dd>${v(s.team)}</dd>
          ${s.status !== "done" ? `<dt>סיבה</dt><dd>${v(s.notDoneReason)}</dd>` : ""}
          ${(s.findings || []).map((f, i) => `<dt>ממצא ${i + 1}</dt><dd>${esc(FINDING_TYPES[f.type] || f.type)} · כמות ${v(f.amount)} · גודל ${v(f.size)} · עומק ${v(f.depth, " מ'")} · ${esc(REMOVED[f.removed] || "")}${f.notes ? " · " + esc(f.notes) : ""}</dd>`).join("")}
          <dt>תיאור האתר</dt><dd>${v(s.siteDescription)}${s.bottomType ? "\nקרקעית: " + esc(s.bottomType) : ""}${s.marineLife ? "\nחי ים: " + esc(s.marineLife) : ""}</dd>
          <dt>תנאי מים</dt><dd>ראות ${v(s.water.visibility, " מ'")} · טמפ' ${v(s.water.temp, "°")} · זרם ${v(s.water.current)} ${esc(s.water.currentDir || "")} · ים ${v(s.water.seaState)} · רוח ${v(s.water.wind)}${s.water.notes ? "\n" + esc(s.water.notes) : ""}</dd>
          <dt>צלילה</dt><dd>כניסה ${v(s.dive.entry)} · עומק מקס' ${v(s.dive.maxDepth, " מ'")} · ${v(s.dive.duration, " דק'")} · ${v(s.dive.divers)} צוללים${s.dive.description ? "\n" + esc(s.dive.description) : ""}</dd>
          <dt>מסלול</dt><dd>${routeInfo(s)}</dd>
        </dl>
        <div class="row">
          <button class="btn btn-ghost small" data-hist="edit" data-sid="${esc(s.id)}">ערוך</button>
          ${s.route && s.route.length > 1 ? `<button class="btn btn-ghost small" data-hist="show" data-sid="${esc(s.id)}">הצג מסלול במפה</button>` : ""}
        </div>
      </div>`).join("")}
      <div class="form-actions"><button class="btn" data-act="new-survey" data-id="${esc(siteId)}">+ סקר חדש</button></div>`);

    $("#modal-body").querySelectorAll("[data-hist]").forEach((b) => b.addEventListener("click", () => {
      const s = state.surveys.find((x) => x.id === b.dataset.sid);
      if (b.dataset.hist === "edit") openSurveyForm(JSON.parse(JSON.stringify(s)));
      else { closeModal(); map.fitBounds(L.polyline(s.route).getBounds(), { padding: [40, 40] }); }
    }));
  }
  function surveyStatusKey(s) {
    if (s.status === "not-done") return "aborted";
    if (s.netsFound === "yes") return "nets";
    if (s.status === "partial") return "partial";
    return "clean";
  }

  // ------------------------------------------------------------- data export
  $("#data-btn").addEventListener("click", () => {
    openModal(`<h2>ניהול נתונים</h2>
      <p class="hint">הנתונים נשמרים בדפדפן של המכשיר הזה בלבד. כדי לשתף עם הצוות או לגבות – ייצא קובץ גיבוי והעבר אותו (וואטסאפ / דרייב). ייבוא ממזג את הנתונים עם הקיימים.</p>
      <p>סה"כ: ${state.surveys.length} סקרים · ${state.customSites.length} אתרים שנוספו · ${Object.keys(state.siteEdits).length} תיקוני מיקום</p>
      <fieldset><legend>ייצוא</legend><div class="row">
        <button class="btn" id="exp-json">גיבוי מלא (JSON)</button>
        <button class="btn btn-ghost" id="exp-geojson">GeoJSON (ל-Google My Maps / QGIS)</button>
        <button class="btn btn-ghost" id="exp-csv">טבלת סקרים (CSV לאקסל)</button>
      </div></fieldset>
      <fieldset><legend>ייבוא</legend>
        <label class="btn btn-ghost">בחר קובץ גיבוי JSON<input type="file" id="imp-json" accept=".json,application/json" hidden></label>
      </fieldset>
      <fieldset><legend>איפוס</legend>
        <button class="btn btn-danger" id="reset-data">מחק את כל הנתונים המקומיים</button>
      </fieldset>`);
    $("#exp-json").addEventListener("click", exportJson);
    $("#exp-geojson").addEventListener("click", exportGeoJson);
    $("#exp-csv").addEventListener("click", exportCsv);
    $("#imp-json").addEventListener("change", importJson);
    $("#reset-data").addEventListener("click", () => {
      if (!confirm("למחוק את כל הסקרים, האתרים שנוספו ותיקוני המיקום מהמכשיר? מומלץ לייצא גיבוי קודם.")) return;
      state.customSites = []; state.siteEdits = {}; state.surveys = [];
      saveState(); closeModal(); renderAll();
    });
  });

  function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"); }

  function exportJson() {
    const data = { app: "divepoints", version: 1, exportedAt: new Date().toISOString(),
      customSites: state.customSites, siteEdits: state.siteEdits, surveys: state.surveys };
    download(`divepoints-backup-${stamp()}.json`, JSON.stringify(data, null, 2));
  }

  function importJson(e) {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then((txt) => {
      let data;
      try { data = JSON.parse(txt); } catch (err) { toast("קובץ לא תקין"); return; }
      if (data.app !== "divepoints") { toast("זה לא קובץ גיבוי של האפליקציה"); return; }
      let added = 0, updated = 0;
      for (const s of data.surveys || []) {
        const i = state.surveys.findIndex((x) => x.id === s.id);
        if (i < 0) { state.surveys.push(s); added++; }
        else if ((s.updatedAt || 0) > (state.surveys[i].updatedAt || 0)) { state.surveys[i] = s; updated++; }
      }
      for (const s of data.customSites || []) {
        const i = state.customSites.findIndex((x) => x.id === s.id);
        if (i < 0) state.customSites.push(s); else state.customSites[i] = Object.assign(state.customSites[i], s);
      }
      Object.assign(state.siteEdits, data.siteEdits || {});
      saveState(); closeModal(); renderAll();
      toast(`יובאו ${added} סקרים חדשים, ${updated} עודכנו`);
    });
  }

  function exportGeoJson() {
    const features = [];
    for (const site of allSites()) {
      const last = surveysFor(site.id)[0];
      const props = {
        kind: "site", id: site.id, name: site.name, category: CATEGORIES[site.category]?.label,
        region: REGIONS[site.region], depth: fmtDepth(site.depth), risk: RISK[site.risk],
        description: site.desc, status: STATUSES[siteStatus(site.id)].label,
        location_verified: !!site.verified, location_source: site.verified ? "field" : site.src === "osm" ? "OpenStreetMap" : "estimate", last_survey: last ? last.date : "",
        surveys: surveysFor(site.id).length,
      };
      features.push({ type: "Feature", properties: props,
        geometry: site.line
          ? { type: "LineString", coordinates: site.line.map(([a, b]) => [b, a]) }
          : { type: "Point", coordinates: [site.lng, site.lat] } });
    }
    for (const s of state.surveys) {
      const siteName = (getSite(s.siteId) || {}).name;
      if (s.route && s.route.length > 1) {
        features.push({ type: "Feature",
          properties: { kind: "route", site: siteName, date: s.date, team: s.team, length_m: routeLengthM(s.route) },
          geometry: { type: "LineString", coordinates: s.route.map(([a, b]) => [b, a]) } });
      }
      for (const f of s.findings || []) {
        if (f.lat == null) continue;
        features.push({ type: "Feature",
          properties: { kind: "finding", site: siteName, date: s.date, type: FINDING_TYPES[f.type],
            amount: f.amount, size: f.size, depth: f.depth, removed: REMOVED[f.removed], notes: f.notes },
          geometry: { type: "Point", coordinates: [f.lng, f.lat] } });
      }
    }
    download(`divepoints-${stamp()}.geojson`, JSON.stringify({ type: "FeatureCollection", features }, null, 2), "application/geo+json");
  }

  function exportCsv() {
    const cols = ["אתר", "אזור", "תאריך", "שעה", "סטטוס", "סיבה", "צוות", "נמצאו רשתות", "ממצאים",
      "תיאור אתר", "קרקעית", "חי ים", "ראות", "טמפ'", "זרם", "כיוון זרם", "מצב ים", "רוח", "הערות מים",
      "כניסה", "עומק מקס'", "משך", "צוללים", "תיאור צלילה", "אורך מסלול (מ')"];
    const rows = state.surveys.map((s) => {
      const site = getSite(s.siteId) || {};
      return [site.name, REGIONS[site.region], s.date, s.timeStart, SURVEY_STATUS[s.status], s.notDoneReason, s.team,
        s.netsFound === "yes" ? "כן" : "לא",
        (s.findings || []).map((f) => `${FINDING_TYPES[f.type]} (${f.amount || "?"}, ${f.size || "?"}, ${REMOVED[f.removed]})`).join("; "),
        s.siteDescription, s.bottomType, s.marineLife, s.water.visibility, s.water.temp, s.water.current, s.water.currentDir,
        s.water.seaState, s.water.wind, s.water.notes, s.dive.entry, s.dive.maxDepth, s.dive.duration, s.dive.divers,
        s.dive.description, routeLengthM(s.route)];
    });
    const cell = (x) => `"${String(x == null ? "" : x).replace(/"/g, '""')}"`;
    const csv = "﻿" + [cols, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
    download(`divepoints-surveys-${stamp()}.csv`, csv, "text/csv;charset=utf-8");
  }

  // --------------------------------------------------------------------- boot
  initMap();
  initSidebar();
  renderAll();
})();
