/* Ghost-net survey map – Israeli Mediterranean coast.
 * Static app: Leaflet map + survey records. Records are kept in the
 * team's shared store when the page runs as a claude.ai artifact (the
 * "db" capability), otherwise in this browser's localStorage, with JSON
 * backup/import and GeoJSON/CSV export in both cases. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- constants
  const STORAGE_KEY = "divepoints-v1";
  const SHALLOW_LIMIT = 15;
  // Running inside the claude.ai artifact viewer (tiles, GPS and plain
  // downloads are blocked there; a shared store is available instead).
  const IN_CLAUDE = !!(window.claude && typeof window.claude.use === "function");

  const REGIONS = {
    north: "צפון", carmel: "חיפה והכרמל", sharon: "השרון", center: "גוש דן", south: "דרום",
  };
  const CATEGORIES = {
    reef:        { label: "ריף / רכס סלעי" },
    wreck:       { label: "ספינה טרופה" },
    pipe:        { label: "צינור / תשתית" },
    breakwater:  { label: "שובר גלים / נמל" },
    archaeology: { label: "אתר ארכאולוגי" },
    island:      { label: "אי / סלע" },
    other:       { label: "אחר" },
  };
  // Chart-style symbols (20x20 viewBox, stroked with currentColor).
  const GLYPHS = {
    reef: '<path d="M2.5 13.5l2.7-4 2.4 3 2.6-5.5 2.5 4.5 2.2-2.6 2.6 4.6"/>',
    wreck: '<path d="M2.5 10h15M6.5 6.5v7M10 5v10M13.5 6.5v7"/>',
    pipe: '<path d="M2 10h16"/><circle cx="6" cy="10" r="1.9" fill="currentColor"/><circle cx="14" cy="10" r="1.9" fill="currentColor"/>',
    breakwater: '<path d="M2.5 8h15v4.5h-15z"/><path d="M5.5 12.5l3-4.5M9.5 12.5l3-4.5M13.5 12.5l3-4.5"/>',
    archaeology: '<path d="M4.5 5h11M4.5 15.5h11M7.5 5.5v9.5M12.5 5.5v9.5"/>',
    island: '<path d="M10 3.5v13M3.5 10h13"/><circle cx="5.8" cy="5.8" r="1" fill="currentColor"/><circle cx="14.2" cy="5.8" r="1" fill="currentColor"/><circle cx="5.8" cy="14.2" r="1" fill="currentColor"/><circle cx="14.2" cy="14.2" r="1" fill="currentColor"/>',
    other: '<circle cx="10" cy="10" r="3.5"/>',
  };
  const STATUSES = {
    unsurveyed: { label: "טרם נסקר",           short: "טרם נסקר" },
    clean:      { label: "נסקר – ללא ממצאים",  short: "נקי" },
    nets:       { label: "נסקר – נמצאו רשתות", short: "רשתות" },
    partial:    { label: "נסקר חלקית",         short: "חלקי" },
    aborted:    { label: "לא בוצע (בוטל)",     short: "בוטל" },
  };
  // Display order: what needs attention first.
  const STATUS_ORDER = ["nets", "partial", "clean", "aborted", "unsurveyed"];
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
  let map, markersLayer, routesLayer, tempLayer, ridgeLayer, surveyLayer, ridgeRenderer;
  const markerById = {};
  const surveyMarkerById = {};
  let modalCleanup = null;
  let drawMode = null;     // { type, ... }
  let draft = null;        // survey currently being edited
  let gpsWatchId = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        return { customSites: s.customSites || [], siteEdits: s.siteEdits || {}, surveys: s.surveys || [],
          ridges: s.ridges || [], ridgeFlags: s.ridgeFlags || {} };
      }
    } catch (e) { console.error(e); }
    return { customSites: [], siteEdits: {}, surveys: [], ridges: [], ridgeFlags: {} };
  }
  function saveLocal() {
    if (db) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast("שגיאה בשמירה: " + e.message);
    }
  }

  // ---------------------------------------------------------- shared store
  // Collections in the shared store, keyed by state field. Both backends
  // speak the same small API (collection/doc/set/delete/onSnapshot):
  // Firestore on the hosted site, the artifact "db" capability on claude.ai.
  const COLLECTIONS = { surveys: "surveys", customSites: "sites", siteEdits: "edits", ridges: "ridges", ridgeFlags: "ridgeFlags" };
  const KEYED = new Set(["siteEdits", "ridgeFlags"]);   // kept as {id: data} maps
  let db = null, backend = "local";                     // local | claude | firebase
  let me = null, amOwner = false;                       // signed-in user (firebase)
  let pendingWrites = false;
  let renderPending = false;
  let unsubs = [];

  async function initSharedStore() {
    if (IN_CLAUDE) {
      let store = null;
      try { store = await window.claude.use("db"); } catch (e) { store = null; }
      if (store) { db = store; backend = "claude"; subscribeAll(); }
      setSyncBadge();
      return;
    }
    if (window.FIREBASE_CONFIG) return initFirebase();
    setSyncBadge();
  }

  function subscribeAll() {
    for (const [key, coll] of Object.entries(COLLECTIONS)) {
      unsubs.push(db.collection(coll).onSnapshot((snap) => {
        const rows = snap.docs.map((d) => Object.assign({}, decodePts(clone(d.data())), { id: d.id }));
        if (KEYED.has(key)) {
          state[key] = {};
          for (const r of rows) { const id = r.id; delete r.id; state[key][id] = r; }
        } else {
          state[key] = rows;
        }
        if (snap.metadata) { pendingWrites = !!snap.metadata.hasPendingWrites; setSyncBadge(); }
        requestRender();
      }, (e) => toast("הסנכרון עם הצוות נעצר" + (e && e.message ? ": " + e.message : "") + ". רענן את הדף.")));
    }
  }

  // Write one record (data = null deletes it). Local state is already
  // updated by the caller; the shared store echoes the change back.
  async function persist(key, id, data) {
    if (!db) { saveLocal(); return true; }
    const ref = db.collection(COLLECTIONS[key]).doc(id);
    const op = data ? ref.set(encodePts(clone(data))) : ref.delete();
    if (backend === "firebase") {
      // Firestore applies the write locally at once and syncs when there is
      // reception; its promise settles only on server ack, so don't wait.
      op.catch(writeFailed);
      return true;
    }
    try { await op; return true; } catch (e) { writeFailed(e); return false; }
  }
  function writeFailed(e) {
    const denied = e && (e.code === "invalid_argument" || e.code === "permission-denied");
    toast(denied ? "אין לך הרשאת כתיבה לנתוני הצוות." : "השמירה נכשלה: " + ((e && e.message) || "שגיאה לא ידועה"));
  }

  function clone(o) { return JSON.parse(JSON.stringify(o || {})); }

  // Firestore can't hold nested arrays, so point lists ([[lat, lng], …])
  // travel as [{lat, lng}, …] and are turned back on the way in.
  const POINT_FIELDS = ["route", "coords"];
  function encodePts(o) {
    for (const k of POINT_FIELDS) {
      if (Array.isArray(o[k]) && Array.isArray(o[k][0])) o[k] = o[k].map(([lat, lng]) => ({ lat, lng }));
    }
    return o;
  }
  function decodePts(o) {
    for (const k of POINT_FIELDS) {
      if (Array.isArray(o[k]) && o[k][0] && !Array.isArray(o[k][0])) o[k] = o[k].map((p) => [p.lat, p.lng]);
    }
    return o;
  }

  // Re-render from snapshots, but never while the user is placing or
  // dragging something on the map (that would drop their marker).
  function requestRender() {
    if (drawMode) { renderPending = true; return; }
    renderAll();
  }

  function setSyncBadge() {
    const el = $("#sync");
    if (!el) return;
    const st = !db ? "local" : pendingWrites ? "pending" : "shared";
    el.textContent = { local: "במכשיר הזה בלבד", pending: "ממתין לקליטה…", shared: "מסונכרן" }[st];
    el.className = "sync " + st;
    el.title = { local: "הנתונים נשמרים רק בדפדפן הזה", pending: "השינויים נשמרו בטלפון ויישלחו לצוות כשתהיה קליטה", shared: "כל השינויים משותפים עם הצוות" }[st];
  }

  // ------------------------------------------------------------- firebase
  const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("לא נטען: " + src));
      document.head.appendChild(s);
    });
  }

  async function initFirebase() {
    showGate("loading");
    try {
      for (const f of ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js"]) {
        await loadScript(FIREBASE_SDK + f);
      }
    } catch (e) { showGate("error"); return; }
    const cfg = window.FIREBASE_CONFIG;
    firebase.initializeApp(cfg);
    const auth = firebase.auth(), fs = firebase.firestore();
    if (cfg.emulatorHost) {
      auth.useEmulator(`http://${cfg.emulatorHost}:9099`);
      fs.useEmulator(cfg.emulatorHost, 8080);
    }
    // Offline cache: surveys entered at sea sync when reception returns.
    try { await fs.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* private window: online only */ }
    auth.getRedirectResult().catch((e) => toast("הכניסה נכשלה: " + e.message));
    auth.onAuthStateChanged((user) => onAuth(user, fs));
  }

  async function onAuth(user, fs) {
    unsubs.forEach((u) => u()); unsubs = [];
    db = null; backend = "local"; me = null; amOwner = false;
    if (!user) { renderUser(); setSyncBadge(); showGate("signin"); return; }
    me = { uid: user.uid, name: user.displayName || user.email, email: (user.email || "").toLowerCase() };
    renderUser();
    showGate("loading");
    try {
      // The first person to sign in after setup becomes the map's manager.
      const ownerRef = fs.collection("meta").doc("owner");
      let owner = await ownerRef.get();
      if (!owner.exists) {
        await ownerRef.set({ email: me.email, name: me.name, since: Date.now() });
        owner = await ownerRef.get();
      }
      amOwner = owner.data().email === me.email;
      if (!amOwner) {
        const m = await fs.collection("team").doc(me.email).get();   // rules deny non-members
        if (!m.exists) throw { code: "permission-denied" };
      }
    } catch (e) {
      showGate(e && e.code === "permission-denied" ? "denied" : "error");
      return;
    }
    hideGate();
    db = fs; backend = "firebase";
    subscribeAll();
    setSyncBadge();
    renderUser();
    offerLocalUpload();
  }

  async function signIn() {
    const auth = firebase.auth();
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try {
      await auth.signInWithPopup(provider);
    } catch (e) {
      const redirect = ["auth/popup-blocked", "auth/operation-not-supported-in-this-environment", "auth/cancelled-popup-request"];
      if (redirect.includes(e.code)) return auth.signInWithRedirect(provider);
      if (e.code !== "auth/popup-closed-by-user") toast("הכניסה נכשלה: " + e.message);
    }
  }
  function signOut() { if (window.firebase) firebase.auth().signOut(); }

  // Full-screen gate over the app while signed out or without access.
  function showGate(kind) {
    const g = $("#gate");
    const views = {
      loading: { t: "רגע…", p: "מתחבר לנתוני הצוות.", a: "" },
      signin: {
        t: "כניסת צוות",
        p: "המפה ויומן הסקרים משותפים לחברי הצוות בלבד. נכנסים פעם אחת עם חשבון Google, וכל נקודה שדוקרים נשמרת לכולם.",
        a: `<button class="btn btn-google" id="gate-signin"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>כניסה עם Google</button>`,
      },
      denied: {
        t: "עדיין אין לך גישה",
        p: `החשבון <b class="mono">${esc(me ? me.email : "")}</b> לא נמצא ברשימת הצוות. שלחו את הכתובת הזו למנהל המפה כדי שיוסיף אתכם, ואז רעננו את הדף.`,
        a: `<button class="btn" id="gate-copy">העתק את המייל</button><button class="btn btn-ghost" id="gate-switch">החלף חשבון</button>`,
      },
      error: {
        t: "אין חיבור לנתוני הצוות",
        p: "לא הצלחנו להתחבר לשרת. בדקו שיש קליטה ונסו שוב. אם נכנסתם בעבר מהמכשיר הזה, הנתונים האחרונים יופיעו גם בלי קליטה.",
        a: `<button class="btn btn-primary" id="gate-retry">נסו שוב</button>`,
      },
    };
    const v = views[kind];
    $("#gate-title").textContent = v.t;
    $("#gate-text").innerHTML = v.p;
    $("#gate-actions").innerHTML = v.a;
    g.classList.toggle("loading", kind === "loading");
    g.classList.remove("hidden");
    const on = (id, fn) => { const b = $(id); if (b) b.addEventListener("click", fn); };
    on("#gate-signin", signIn);
    on("#gate-switch", signOut);
    on("#gate-retry", () => location.reload());
    on("#gate-copy", () => {
      navigator.clipboard.writeText(me.email).then(() => toast("המייל הועתק"), () => toast(me.email));
    });
  }
  function hideGate() { $("#gate").classList.add("hidden"); }

  function renderUser() {
    const el = $("#menu-user");
    if (el) el.innerHTML = me ? `<b>${esc(me.name)}</b><span class="mono">${esc(me.email)}</span>${amOwner ? `<span class="tag">מנהל המפה</span>` : ""}` : "";
    document.body.classList.toggle("signed-in", !!me);
    document.body.classList.toggle("is-owner", amOwner);
  }

  // Surveys saved on this device before team sync was set up.
  function localBacklog() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const known = new Set(state.surveys.map((x) => x.id));
      return { surveys: (s.surveys || []).filter((x) => !known.has(x.id)), customSites: s.customSites || [] };
    } catch (e) { return { surveys: [], customSites: [] }; }
  }
  function offerLocalUpload() {
    setTimeout(() => {
      const b = localBacklog();
      if (b.surveys.length) toast(`יש ${b.surveys.length} סקרים שנשמרו רק במכשיר הזה. אפשר להעלות אותם לצוות מהתפריט ← נתונים.`);
    }, 2500);
  }

  // Team list, managed by the map's manager.
  function openTeam() {
    const fs = firebase.firestore();
    openModal(`<h2>ניהול צוות</h2>
      <p class="sub">רק מי שברשימה יכול לראות ולערוך את יומן הסקרים. כל אחד נכנס עם חשבון Google שלו.</p>
      <form id="team-form" class="team-add">
        <input id="team-email" type="email" required placeholder="name@gmail.com" aria-label="מייל של חבר צוות" dir="ltr">
        <button class="btn btn-primary">הוסף לצוות</button>
      </form>
      <ul class="team-list" id="team-list"><li class="hint">טוען…</li></ul>
      <p class="hint">מנהל המפה: <span class="mono">${esc(me.email)}</span></p>`);
    const unsub = fs.collection("team").onSnapshot((snap) => {
      const el = $("#team-list");
      if (!el) return;
      el.innerHTML = snap.docs.length
        ? snap.docs.map((d) => `<li><span class="mono" dir="ltr">${esc(d.id)}</span><button class="btn btn-ghost small" data-rm="${esc(d.id)}">הסר</button></li>`).join("")
        : `<li class="hint">עדיין אין חברי צוות. הוסיפו את כתובות ה-Gmail של הצוללים.</li>`;
    }, writeFailed);
    modalCleanup = unsub;
    $("#team-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const em = $("#team-email").value.trim().toLowerCase();
      if (!em) return;
      fs.collection("team").doc(em).set({ addedBy: me.email, addedAt: Date.now() }).catch(writeFailed);
      $("#team-email").value = "";
      toast(`${em} נוסף לצוות`);
    });
    $("#team-list").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-rm]");
      if (!b) return;
      if (await confirmDialog(`להסיר את ${b.dataset.rm} מהצוות?`, "הסר")) {
        fs.collection("team").doc(b.dataset.rm).delete().catch(writeFailed);
      }
    });
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
  async function download(filename, text, mime) {
    if (IN_CLAUDE) {
      let dl = null;
      try { dl = await window.claude.use("downloads"); } catch (e) { dl = null; }
      if (!dl) { toast("הורדת קבצים אינה זמינה בתצוגה הזו"); return; }
      try { await dl.save({ filename: filename.replace(/\.geojson$/, ".json"), data: text }); }
      catch (e) { if (!e || e.code !== "declined") toast("ההורדה נכשלה: " + ((e && e.message) || "")); }
      return;
    }
    const blob = new Blob([text], { type: mime || "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  // In-page confirmation (native confirm dialogs are unavailable in some views).
  function confirmDialog(message, okLabel) {
    return new Promise((resolve) => {
      const box = $("#confirm");
      $("#confirm-msg").textContent = message;
      $("#confirm-ok").textContent = okLabel || "מחק";
      box.classList.remove("hidden");
      const done = (v) => {
        box.classList.add("hidden");
        $("#confirm-ok").onclick = $("#confirm-cancel").onclick = null;
        resolve(v);
      };
      $("#confirm-ok").onclick = () => done(true);
      $("#confirm-cancel").onclick = () => done(false);
    });
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
  // Current value of a CSS custom property (SVG/canvas styles cannot use var()).
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const BAND_VAR = { 0: "--d0", 5: "--d5", 10: "--d10", 15: "--d15", 20: "--d20", 30: "--d30", 50: "--d50", 100: "--d100" };
  const POPUP_OPTS = { maxWidth: 300, minWidth: 290, autoPanPaddingTopLeft: [16, 64], autoPanPaddingBottomRight: [16, 64] };
  const COAST_BOUNDS = [[31.3, 33.9], [33.35, 35.7]];
  const EMPTY_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const LABEL_ZOOM = { city: 9, town: 10, village: 12, mouth: 12, beach: 13 };
  let clusterLayer, linesLayer, chartLayers, mapMode = "sat";

  function bandStyle(f) {
    const p = f.properties;
    return { stroke: false, fillOpacity: 1, fillColor: css(BAND_VAR[p.min] || "--deep") };
  }
  function isoStyle(f) {
    const d = f.properties.depth;
    const sat = mapMode === "sat";
    return {
      color: sat ? "#ffffff" : css("--isobath"),
      weight: d <= 10 ? 0.6 : 0.9, opacity: sat ? 0.55 : 0.75, dashArray: d <= 10 ? "3 3" : null,
    };
  }
  function landStyle() { return { color: css("--land-edge"), weight: 0.8, fillColor: css("--land"), fillOpacity: 1 }; }
  function surveyStyle() { return { color: css("--survey"), weight: mapMode === "sat" ? 3 : 2.4, opacity: 1 }; }

  function initMap() {
    map = L.map("map", {
      zoomControl: false, minZoom: 8, maxZoom: 18,
      // Keep the view on the charted coast (data covers 31.5–33.15 N).
      maxBounds: COAST_BOUNDS, maxBoundsViscosity: 0.8,
    });
    map.attributionControl.setPrefix(false);
    // Pane order, bottom to top: chart fill < satellite < isobaths <
    // survey line < place labels < markers.
    map.createPane("chart").style.zIndex = 150;
    map.createPane("iso").style.zIndex = 380;
    map.createPane("ridges").style.zIndex = 390;
    map.createPane("surveyLine").style.zIndex = 420;
    map.createPane("labels").style.zIndex = 450;
    map.getPane("labels").style.pointerEvents = "none";

    // Satellite: Sentinel-2 tiles bundled with the page along the coastal
    // strip. Three layers at different native zooms stack so the picture
    // softens away from the coast instead of ending in a hard edge.
    const satOpts = {
      errorTileUrl: EMPTY_TILE, maxZoom: 18, bounds: COAST_BOUNDS,
      attribution: 'Sentinel-2 cloudless 2023 by <a href="https://s2maps.eu" target="_blank" rel="noopener">EOX</a>',
    };
    satOpts.keepBuffer = 1;   // fewer off-screen tiles to move while panning on phones
    // The wide layer also covers the hinterland, so the overview has no edge.
    const satWide = L.tileLayer("tiles/{z}/{x}/{y}.jpg", Object.assign({}, satOpts, { minZoom: 8, maxNativeZoom: 10, bounds: [[30.9, 32.4], [33.7, 37.9]] }));
    const satFine = L.layerGroup([
      L.tileLayer("tiles/{z}/{x}/{y}.jpg", Object.assign({}, satOpts, { minZoom: 11, maxNativeZoom: 12 })),
      L.tileLayer("tiles/{z}/{x}/{y}.jpg", Object.assign({}, satOpts, { minZoom: 13, maxNativeZoom: 14 })),
    ]);

    // Chart: depth bands (EMODnet) under OSM land. Drawn only in chart mode:
    // under imagery it would be redrawn on every pan for nothing.
    const canvas = L.canvas({ pane: "chart", padding: 0.3 });
    const feats = (window.BATHY && window.BATHY.features) || [];
    const fc = (pred) => ({ type: "FeatureCollection", features: feats.filter(pred) });
    const bands = L.geoJSON(fc((f) => f.properties.kind === "band"),
      { renderer: canvas, interactive: false, style: bandStyle, smoothFactor: 1.5, attribution: "עומקים: EMODnet Bathymetry" });
    const land = L.geoJSON(window.COAST_LAND || null,
      { renderer: canvas, interactive: false, style: landStyle, smoothFactor: 1.5, attribution: "© OpenStreetMap" });
    const isobaths = L.geoJSON(fc((f) => f.properties.kind === "isobath" && f.properties.depth !== SHALLOW_LIMIT),
      { renderer: L.canvas({ pane: "iso", padding: 0.3 }), interactive: false, style: isoStyle, smoothFactor: 1.5 });
    // The 15 m isobath: outer edge of the survey belt, always on top.
    const surveyLine = L.geoJSON(fc((f) => f.properties.kind === "isobath" && f.properties.depth === SHALLOW_LIMIT),
      { pane: "surveyLine", interactive: false, style: surveyStyle });
    chartLayers = { bands, land, isobaths, surveyLine, satWide, satFine };
    // Hosted outside Claude (e.g. GitHub Pages) live tile services load:
    // sharper imagery over the bundled tiles, and a street map.
    chartLayers.live = IN_CLAUDE ? null : {
      sat: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }),
      streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 19, attribution: "© OpenStreetMap contributors" }),
    };

    // Labels: depth figures along isobaths + coastal place names, one group
    // per kind, each on the map only from its zoom (keeps the DOM small).
    labelGroups = { iso: L.layerGroup() };
    const labelIcon = (cls, html) => L.divIcon({ className: "map-label " + cls, html, iconSize: null });
    for (const f of feats) {
      const d = f.properties.depth;
      if (f.properties.kind !== "isobath" || d > 50) continue;
      const cs = f.geometry.coordinates;
      if (cs.length < 12) continue;
      const step = Math.max(30, Math.floor(cs.length / 3));
      for (let i = Math.floor(step / 2); i < cs.length; i += step) {
        labelGroups.iso.addLayer(L.marker([cs[i][1], cs[i][0]], {
          pane: "labels", interactive: false, keyboard: false,
          icon: labelIcon("iso" + (d === SHALLOW_LIMIT ? " survey" : ""), `${d}`),
        }));
      }
    }
    for (const p of window.PLACES || []) {
      (labelGroups[p.k] = labelGroups[p.k] || L.layerGroup()).addLayer(L.marker([p.lat, p.lng], {
        pane: "labels", interactive: false, keyboard: false, icon: labelIcon(`place k-${p.k}`, esc(p.n)),
      }));
    }

    linesLayer = L.layerGroup();
    ridgeLayer = L.layerGroup();
    surveyLayer = L.layerGroup();
    ridgeRenderer = L.canvas({ pane: "ridges", padding: 0.3 });
    clusterLayer = L.markerClusterGroup
      ? L.markerClusterGroup({
          showCoverageOnHover: false, maxClusterRadius: 46, disableClusteringAtZoom: 13,
          spiderfyOnMaxZoom: true, iconCreateFunction: clusterIcon,
        })
      : L.featureGroup();
    routesLayer = L.layerGroup();
    tempLayer = L.layerGroup();

    [isobaths, surveyLine, linesLayer, clusterLayer, routesLayer, surveyLayer, tempLayer]
      .forEach((l) => l.addTo(map));
    addMapControls();
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

    const syncZoom = () => {
      const z = map.getZoom(), el = map.getContainer();
      for (let i = 8; i <= 18; i++) el.classList.toggle("zg" + i, z >= i);
      syncLabels();
      applyLayer("ridges");
    };
    map.on("zoomend", syncZoom);
    map.on("click", onMapClick);
    map.on("contextmenu", (e) => showDepthProbe(e.latlng));
    // On phones the tool column would cover the site card; hide it meanwhile.
    map.on("popupopen", () => map.getContainer().classList.add("popup-open"));
    map.on("popupclose", () => map.getContainer().classList.remove("popup-open"));
    setMapMode(mapMode);
    fitCoast();
    syncZoom();

    // Follow theme switches (system setting or the viewer's own toggle).
    const restyle = () => { restyleChart(); renderMap(); renderRidges(true); };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", restyle);
    new MutationObserver(restyle).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }

  const LABEL_MIN_ZOOM = { iso: 12, city: 9, town: 10, village: 12, mouth: 12, beach: 14 };
  let labelGroups = {};
  function syncLabels() {
    const z = map.getZoom();
    for (const [k, g] of Object.entries(labelGroups)) {
      let on = z >= (LABEL_MIN_ZOOM[k] || 12);
      if (k === "iso" && layerPref.iso === false) on = false;
      if (mapMode === "streets" && k !== "iso") on = false;   // street tiles carry their own names
      if (on && !map.hasLayer(g)) g.addTo(map);
      if (!on && map.hasLayer(g)) map.removeLayer(g);
    }
  }

  function restyleChart() {
    chartLayers.bands.setStyle(bandStyle);
    chartLayers.land.setStyle(landStyle);
    chartLayers.isobaths.setStyle(isoStyle);
    chartLayers.surveyLine.setStyle(surveyStyle);
  }

  function setMapMode(mode) {
    mapMode = mode;
    const live = chartLayers.live || {};
    const want = {
      chart: mode === "chart",
      satWide: mode === "sat",
      satFine: mode === "sat" && !live.sat,   // live imagery replaces the bundled detail
      liveSat: mode === "sat" && live.sat,
      streets: mode === "streets" && live.streets,
    };
    const toggle = (layer, on) => {
      if (!layer) return;
      if (on && !map.hasLayer(layer)) layer.addTo(map);
      if (!on && map.hasLayer(layer)) map.removeLayer(layer);
    };
    toggle(chartLayers.bands, want.chart);
    toggle(chartLayers.land, want.chart);
    toggle(chartLayers.satWide, want.satWide);
    toggle(chartLayers.satFine, want.satFine);
    toggle(live.sat, want.liveSat);
    toggle(live.streets, want.streets);
    map.getContainer().classList.toggle("mode-sat", mode === "sat");
    map.getContainer().classList.toggle("mode-streets", mode === "streets");
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    restyleChart();
    if (ridgeLayer) renderRidges();
    if (labelGroups.iso) syncLabels();
  }

  function fitCoast() {
    const pts = allSites().map((s) => [s.lat, s.lng]);
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [24, 24] });
    else map.setView([32.55, 34.9], 9);
  }

  // Map controls: base-map switch, depth-lines toggle, zoom, whole coast.
  function addMapControls() {
    const Tools = L.Control.extend({
      options: { position: "topleft" },
      onAdd() {
        const el = L.DomUtil.create("div", "map-tools");
        el.innerHTML = `
          <div class="seg" role="group" aria-label="סוג מפה">
            <button type="button" data-mode="sat" aria-pressed="true">לוויין</button>
            <button type="button" data-mode="chart" aria-pressed="false">מפה ימית</button>
            ${IN_CLAUDE ? "" : `<button type="button" data-mode="streets" aria-pressed="false">רחובות</button>`}
          </div>
          <details class="layers" id="layers">
            <summary><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M9 2l7 4-7 4-7-4 7-4z"/><path d="M2 9.5l7 4 7-4M2 13l7 4 7-4"/></svg><span>שכבות</span></summary>
            <div class="layers-body">
              <div class="seg in-layers" role="group" aria-label="סוג מפה">
                <button type="button" data-mode="sat" aria-pressed="true">לוויין</button>
                <button type="button" data-mode="chart" aria-pressed="false">מפה ימית</button>
                ${IN_CLAUDE ? "" : `<button type="button" data-mode="streets" aria-pressed="false">רחובות</button>`}
              </div>
              <label><input type="checkbox" data-layer="surveys" checked><i class="sw survey"></i>נקודות סקר</label>
              <label><input type="checkbox" data-layer="routes" checked><i class="sw route"></i>מסלולים וממצאים</label>
              <label><input type="checkbox" data-layer="ridges" checked><i class="sw ridge"></i>רכסים תת-ימיים</label>
              <label><input type="checkbox" data-layer="sites" checked><i class="sw site"></i>אתרי צלילה מוכרזים</label>
              <label><input type="checkbox" data-layer="iso" checked><i class="sw iso"></i>קווי עומק</label>
            </div>
          </details>
          <div class="zoom" role="group" aria-label="זום">
            <button type="button" class="tool icon" id="zoom-in" aria-label="התקרב">+</button>
            <button type="button" class="tool icon" id="zoom-out" aria-label="התרחק">−</button>
          </div>
          <button type="button" class="tool icon" id="fit-coast" title="כל החוף" aria-label="הצג את כל החוף">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 6V2h4M12 2h4v4M16 12v4h-4M6 16H2v-4"/></svg>
          </button>
          <details class="legend">
            <summary>מקרא</summary>
            <div class="legend-body">
              <div class="row"><span class="survey-line"></span>15 מ' · גבול רצועת הסקר</div>
              <div class="row"><span class="iso-line"></span>קווי עומק 5–500 מ'</div>
              <div class="row"><span class="ridge-swatch"></span>רכס משוער (מקווקו) / מסומן ע"י הצוות</div>
              <div class="row"><span class="survey-pin legend-pin"></span>נקודת סקר, בצבע התוצאה</div>
              <div class="marks">${STATUS_ORDER.map((k) => `<span><i style="background:var(--st-${k})"></i>${STATUSES[k].short}</span>`).join("")}
                <span><i style="background:var(--survey)"></i>סיכון גבוה</span>
                <span><i class="est"></i>מיקום משוער</span></div>
              <div class="ramp-wrap"><div class="ramp">${[0, 5, 10, 15, 20, 30, 50, 100].map((d) => `<span style="background:var(${BAND_VAR[d]})"></span>`).join("")}</div>
              <div class="ramp-labels">${[0, 5, 10, 15, 20, 30, 50, 100].map((d) => `<span>${d}</span>`).join("")}</div></div>
              <div class="note"><b>לחיצה ארוכה על המפה</b> (או קליק ימני) מציגה את העומק המשוער בנקודה.<br>עומקים: EMODnet (~115 מ'), הערכה בלבד. לא לניווט.</div>
            </div>
          </details>`;
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);
        el.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => setMapMode(b.dataset.mode)));
        el.querySelectorAll("[data-layer]").forEach((cb) => cb.addEventListener("change", () => setLayer(cb.dataset.layer, cb.checked)));
        el.querySelector("#zoom-in").addEventListener("click", () => map.zoomIn());
        el.querySelector("#zoom-out").addEventListener("click", () => map.zoomOut());
        el.querySelector("#fit-coast").addEventListener("click", fitCoast);
        return el;
      },
    });
    new Tools().addTo(map);
  }

  // Cluster badge: a ring split by survey status, so progress reads from
  // the overview without zooming in.
  function clusterIcon(cluster) {
    const kids = cluster.getAllChildMarkers();
    const counts = {};
    for (const m of kids) counts[m.options.status] = (counts[m.options.status] || 0) + 1;
    const n = kids.length;
    const size = n < 6 ? 40 : n < 15 ? 46 : 52;
    const r = size / 2 - 4, c = 2 * Math.PI * r;
    let offset = 0;
    const arcs = STATUS_ORDER.map((k) => {
      if (!counts[k]) return "";
      const len = (counts[k] / n) * c;
      const stroke = k === "unsurveyed" ? "var(--rule)" : `var(--st-${k})`;
      const arc = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" style="stroke:${stroke}" stroke-width="6"
        stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
      offset += len;
      return arc;
    }).join("");
    const label = STATUS_ORDER.filter((k) => counts[k]).map((k) => `${STATUSES[k].short} ${counts[k]}`).join(", ");
    return L.divIcon({
      className: "",
      html: `<div class="cluster" title="${esc(label)}"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle r="${r + 3}" cx="${size / 2}" cy="${size / 2}" style="fill:var(--panel)"/>${arcs}</svg><b>${n}</b></div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
  }

  function glyph(category) {
    const g = GLYPHS[category] || GLYPHS.other;
    return `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${g}</svg>`;
  }
  function isEstimate(site) { return !(site.verified || site.src === "osm"); }
  function markHtml(site, status, extraClass) {
    const cls = ["site-marker", "s-" + status];
    if (isEstimate(site)) cls.push("est");
    if (site.risk === "high" && status === "unsurveyed") cls.push("risk-high");
    if (extraClass) cls.push(extraClass);
    return `<div class="${cls.join(" ")}" style="--st:var(--st-${status})">${glyph(site.category)}</div>`;
  }

  function renderMap() {
    clusterLayer.clearLayers();
    linesLayer.clearLayers();
    for (const k in markerById) delete markerById[k];
    const markers = [];
    for (const site of filteredSites()) {
      const status = siteStatus(site.id);
      if (site.line) {
        // White casing keeps the line readable over dark water and imagery.
        L.polyline(site.line, { color: "#ffffff", weight: 9, opacity: 0.85, lineCap: "round", interactive: false }).addTo(linesLayer);
        L.polyline(site.line, {
          color: css(status === "unsurveyed" ? "--st-unsurveyed-ink" : `--st-${status}`),
          weight: 5, opacity: 0.9, lineCap: "round", dashArray: isEstimate(site) ? "8 6" : null,
        }).bindPopup(() => popupHtml(site.id), POPUP_OPTS).addTo(linesLayer);
      }
      const m = L.marker([site.lat, site.lng], {
        status, title: site.name, riseOnHover: true,
        icon: L.divIcon({ className: "", html: markHtml(site, status), iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] }),
      }).bindPopup(() => popupHtml(site.id), POPUP_OPTS);
      markerById[site.id] = m;
      markers.push(m);
    }
    if (clusterLayer.addLayers) clusterLayer.addLayers(markers); else markers.forEach((m) => clusterLayer.addLayer(m));
    renderRoutes();
  }

  function renderRoutes() {
    routesLayer.clearLayers();
    for (const s of state.surveys) {
      if (s.route && s.route.length > 1) {
        L.polyline(s.route, { color: css("--survey"), weight: 3, opacity: 0.95, dashArray: "1 6", lineCap: "round" })
          .bindTooltip(`${esc((getSite(s.siteId) || {}).name || "")} · ${esc(fmtDate(s.date))}`)
          .addTo(routesLayer);
      }
      for (const f of s.findings || []) {
        if (f.lat != null) {
          L.circleMarker([f.lat, f.lng], { radius: 6, color: css("--panel"), weight: 2, fillColor: css("--st-nets"), fillOpacity: 1 })
            .bindTooltip(`ממצא: ${esc(FINDING_TYPES[f.type] || f.type)}`)
            .addTo(routesLayer);
        }
      }
    }
  }

  // ------------------------------------------------------------ survey points
  // A survey is its own point on the map; linking it to a declared dive
  // site is optional.
  function surveyLoc(s) {
    if (s.lat != null && s.lng != null) return [s.lat, s.lng];
    const site = s.siteId && getSite(s.siteId);
    return site ? [site.lat, site.lng] : null;
  }
  function surveyTitle(s) {
    const site = s.siteId && getSite(s.siteId);
    return s.place || (site && site.name) || "נקודת סקר";
  }
  function nearbySites(lat, lng, km) {
    const here = L.latLng(lat, lng);
    return allSites().map((x) => ({ site: x, d: here.distanceTo([x.lat, x.lng]) }))
      .filter((x) => x.d <= km * 1000).sort((a, b) => a.d - b.d);
  }
  function findingsCount(s) { return (s.findings || []).length; }
  function removedCount(s) { return (s.findings || []).filter((f) => f.removed === "yes").length; }

  function renderSurveys() {
    surveyLayer.clearLayers();
    for (const k in surveyMarkerById) delete surveyMarkerById[k];
    for (const s of state.surveys) {
      if (s.lat == null) continue;   // older site-only surveys show on the site marker
      const k = surveyStatusKey(s);
      surveyMarkerById[s.id] = L.marker([s.lat, s.lng], {
        title: surveyTitle(s), riseOnHover: true, zIndexOffset: 500,
        icon: L.divIcon({ className: "", html: `<div class="survey-pin" style="--st:var(--st-${k})"></div>`, iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12] }),
      }).bindPopup(() => surveyPopupHtml(s.id), POPUP_OPTS).addTo(surveyLayer);
    }
  }

  function surveyPopupHtml(id) {
    const s = state.surveys.find((x) => x.id === id);
    if (!s) return "";
    const k = surveyStatusKey(s);
    const site = s.siteId && getSite(s.siteId);
    const loc = surveyLoc(s);
    const by = s.createdBy && s.createdBy.name;
    return `<div style="--st:var(--st-${k})">
      <div class="card-status"><i></i>${STATUSES[k].label} · ${esc(fmtDate(s.date))}</div>
      <div class="card-body">
        <div><div class="hint">נקודת סקר${site ? ` · ${esc(site.name)}` : ""}</div><h3>${esc(surveyTitle(s))}</h3></div>
        <dl class="facts">
          <div><dt>ממצאים</dt><dd>${findingsCount(s)}</dd></div>
          <div><dt>הוסרו</dt><dd>${removedCount(s)}</dd></div>
          <div><dt>עומק מקס'</dt><dd>${s.dive && s.dive.maxDepth ? esc(s.dive.maxDepth) + " מ'" : "—"}</dd></div>
        </dl>
        ${s.team ? `<p><b>צוות:</b> ${esc(s.team)}</p>` : ""}
        ${s.siteDescription ? `<p>${esc(s.siteDescription)}</p>` : ""}
        <div class="coords"><span>${ddm(loc[0], "N", "S", 2)} ${ddm(loc[1], "E", "W", 3)}</span><span class="src">${by ? "נרשם ע\"י " + esc(by) : ""}</span></div>
        <div class="card-actions">
          <button class="btn btn-primary small" data-act="edit-survey" data-id="${esc(s.id)}">פתח סקר</button>
          <button class="btn small" data-act="survey-here" data-lat="${loc[0]}" data-lng="${loc[1]}">סקר חוזר כאן</button>
          <a class="btn btn-ghost small" href="https://www.google.com/maps/search/?api=1&query=${loc[0]},${loc[1]}" target="_blank" rel="noopener">ניווט</a>
        </div>
      </div></div>`;
  }

  function focusSurvey(id) {
    const s = state.surveys.find((x) => x.id === id);
    if (!s) return;
    if (isPhone()) setSheet(false);
    const loc = surveyLoc(s);
    if (!loc) { openSurveyForm(clone(s)); return; }
    if (s.lat == null && s.siteId) { focusSite(s.siteId); return; }
    setLayer("surveys", true);
    map.setView(loc, Math.max(map.getZoom(), 15));
    setTimeout(() => surveyMarkerById[id] && surveyMarkerById[id].openPopup(), 400);
  }

  function startNewSurvey() {
    setLayer("surveys", true);
    setDrawMode({ type: "new-survey" }, "לחצו על המפה במקום שבו נעשה הסקר", {
      noUndo: true,
      click: (ll) => { endDrawMode(); openSurveyForm(newSurvey(null, ll)); },
      done: () => {},
    });
  }

  // ------------------------------------------------------------------ ridges
  // Auto-detected candidates (from imagery) plus ridges the team draws.
  // A wrong candidate is hidden for everyone through a shared flag.
  function ridgeStyle(manual) {
    return () => ({
      color: css("--ridge"), weight: manual ? 2 : 1.2, opacity: 0.95, dashArray: manual ? null : "4 3",
      fillColor: css("--ridge"), fillOpacity: mapMode === "sat" ? 0.18 : 0.34,
    });
  }
  let ridgeSig = "";
  function renderRidges(force) {
    const sig = JSON.stringify([state.ridgeFlags, state.ridges.map((r) => r.id + ":" + (r.updatedAt || "")), mapMode]);
    if (!force && sig === ridgeSig) return;
    ridgeSig = sig;
    ridgeLayer.clearLayers();
    const hidden = (id) => state.ridgeFlags[id] && state.ridgeFlags[id].hidden;
    const auto = ((window.AUTO_RIDGES && window.AUTO_RIDGES.features) || []).filter((f) => !hidden(f.properties.id));
    L.geoJSON({ type: "FeatureCollection", features: auto }, {
      renderer: ridgeRenderer, style: ridgeStyle(false), smoothFactor: 1.5,
      onEachFeature: (f, l) => l.on("click", (e) => openRidgePopup(e.latlng, { auto: true, id: f.properties.id, area: f.properties.area })),
    }).addTo(ridgeLayer);
    for (const r of state.ridges) {
      L.polygon(r.coords, Object.assign({ renderer: ridgeRenderer }, ridgeStyle(true)()))
        .on("click", (e) => openRidgePopup(e.latlng, { auto: false, id: r.id, area: polygonArea(r.coords), r }))
        .addTo(ridgeLayer);
    }
  }
  function polygonArea(coords) {   // m², local equirectangular approximation
    if (!coords || coords.length < 3) return 0;
    const k = 111320, c = Math.cos(coords[0][0] * Math.PI / 180);
    let a = 0;
    for (let i = 0; i < coords.length; i++) {
      const [y1, x1] = coords[i], [y2, x2] = coords[(i + 1) % coords.length];
      a += x1 * c * k * y2 * k - x2 * c * k * y1 * k;
    }
    return Math.abs(a / 2);
  }
  function surveysNear(latlng, m) {
    return state.surveys.filter((s) => { const l = surveyLoc(s); return l && map.distance(latlng, l) <= m; }).length;
  }
  function openRidgePopup(latlng, info) {
    if (drawMode) return;
    const dunam = Math.max(1, Math.round(info.area / 1000));
    const by = info.r && info.r.createdBy ? info.r.createdBy.name : "";
    const html = `<div style="--st:var(--ridge)">
      <div class="card-status"><i></i>${info.auto ? "זוהה אוטומטית מתצלום לוויין" : "סומן ידנית" + (by ? " ע\"י " + esc(by) : "")}</div>
      <div class="card-body">
        <div><div class="hint">רכס / קרקעית סלעית</div><h3>${info.auto ? "רכס משוער" : "רכס שסומן בשטח"}</h3></div>
        <dl class="facts">
          <div><dt>שטח</dt><dd>~${dunam} דונם</dd></div>
          <div><dt>מקור</dt><dd>${info.auto ? "לוויין" : "צוות"}</dd></div>
          <div><dt>סקרים עד 300 מ'</dt><dd>${surveysNear(latlng, 300)}</dd></div>
        </dl>
        ${info.auto ? `<p class="hint">אזור כהה מהחול שסביבו בתצלום Sentinel-2. לרוב סלע כורכר או צמחייה. יש לאמת בצלילה.</p>` : ""}
        <div class="card-actions">
          <button class="btn btn-primary small" data-act="survey-here" data-lat="${latlng.lat}" data-lng="${latlng.lng}">סקר כאן</button>
          ${info.auto
            ? `<button class="btn btn-ghost small" data-act="ridge-hide" data-id="${esc(info.id)}">זה לא רכס, הסתר</button>`
            : `<button class="btn btn-ghost small" data-act="ridge-delete" data-id="${esc(info.id)}">מחק רכס</button>`}
        </div>
      </div></div>`;
    L.popup(POPUP_OPTS).setLatLng(latlng).setContent(html).openOn(map);
  }
  function startDrawRidge() {
    setLayer("ridges", true);
    const pts = [];
    const poly = L.polygon([], { color: css("--ridge"), weight: 2, fillOpacity: 0.25 }).addTo(tempLayer);
    const msg = () => `לחצו סביב הרכס כדי לסמן אותו (${pts.length} נקודות)`;
    setDrawMode({ type: "ridge" }, msg(), {
      click: (ll) => { pts.push([+ll.lat.toFixed(6), +ll.lng.toFixed(6)]); poly.setLatLngs(pts); updateDrawMsg(msg()); },
      undo: () => { pts.pop(); poly.setLatLngs(pts); updateDrawMsg(msg()); },
      done: () => {
        if (pts.length < 3) { toast("צריך לפחות 3 נקודות כדי לסמן רכס"); return; }
        const r = { id: uid("ridge"), coords: pts, createdAt: Date.now(), updatedAt: Date.now() };
        if (me) r.createdBy = { name: me.name, email: me.email };
        state.ridges.push(r);
        persist("ridges", r.id, r);
        renderRidges(true);
        toast("הרכס נשמר");
      },
      cancel: () => {},
    });
  }

  // ------------------------------------------------------------------ layers
  const LAYER_KEYS = ["surveys", "routes", "ridges", "sites", "iso"];
  function layerObjects(key) {
    return { sites: [clusterLayer, linesLayer], ridges: [ridgeLayer], surveys: [surveyLayer],
      routes: [routesLayer], iso: [chartLayers.isobaths] }[key];
  }
  // What the user asked for per layer; ridges also wait for zoom 11 (too
  // small to see below it, and costly to redraw on every pan).
  const layerPref = {};
  const RIDGE_MIN_ZOOM = 11;
  function applyLayer(key) {
    let on = layerPref[key] !== false;
    if (key === "ridges" && map.getZoom() < RIDGE_MIN_ZOOM) on = false;
    for (const l of layerObjects(key)) {
      if (on && !map.hasLayer(l)) l.addTo(map);
      if (!on && map.hasLayer(l)) map.removeLayer(l);
    }
    if (key === "iso") { map.getContainer().classList.toggle("no-iso", !on); syncLabels(); }
  }
  function setLayer(key, on) {
    layerPref[key] = on;
    applyLayer(key);
    const cb = document.querySelector(`[data-layer="${key}"]`);
    if (cb) cb.checked = on;
    try { localStorage.setItem("divepoints-layers", JSON.stringify(layerPref)); }
    catch (e) { /* storage unavailable: the choice just isn't remembered */ }
  }
  function restoreLayers() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("divepoints-layers") || "{}"); } catch (e) { saved = {}; }
    for (const k of LAYER_KEYS) setLayer(k, saved[k] !== false);
  }

  // ------------------------------------------------------------- survey log
  let logFilter = "";
  const MONTH = new Intl.DateTimeFormat("he-IL", { month: "long", year: "numeric" });
  function renderLog() {
    const all = state.surveys;
    const nets = all.filter((s) => s.netsFound === "yes").length;
    const items = all.reduce((n, s) => n + findingsCount(s), 0);
    const removed = all.reduce((n, s) => n + removedCount(s), 0);
    $("#log-count").textContent = all.length;
    $("#tab-log-n").textContent = all.length || "";
    $("#log-sub").innerHTML = `<span><b>${nets}</b> עם רשתות</span><span><b>${items}</b> ממצאים</span><span><b>${removed}</b> הוסרו</span>`;
    const counts = {};
    for (const s of all) { const k = surveyStatusKey(s); counts[k] = (counts[k] || 0) + 1; }
    $("#log-chips").innerHTML = ["nets", "clean", "partial", "aborted"].map((k) =>
      `<li><button class="chip" data-logf="${k}" aria-pressed="${logFilter === k}"><span class="sw" style="background:var(--st-${k})"></span>${STATUSES[k].short}<span class="n">${counts[k] || 0}</span></button></li>`).join("");
    if (!all.length) {
      $("#log-list").innerHTML = `<div class="empty"><span class="t">היומן ריק</span>לחצו על <b>+ סקר</b> ובחרו במפה את המקום שבו צללתם. אפשר גם לפתוח סקר מתוך אתר צלילה או מרכס.</div>`;
      return;
    }
    const q = $("#log-search").value.trim();
    const list = all.filter((s) => (!logFilter || surveyStatusKey(s) === logFilter) &&
        (!q || [surveyTitle(s), s.team, s.siteDescription, s.createdBy && s.createdBy.name].some((v) => v && String(v).includes(q))))
      .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
    if (!list.length) { $("#log-list").innerHTML = `<div class="empty">אין סקרים שמתאימים לסינון.</div>`; return; }
    const html = [];
    let month = "";
    for (const s of list) {
      const m = s.date ? MONTH.format(new Date(s.date + "T12:00:00")) : "ללא תאריך";
      if (m !== month) {
        if (month) html.push("</ul>");
        month = m;
        html.push(`<h2 class="group"><span>${esc(m)}</span></h2><ul class="site-list log">`);
      }
      const k = surveyStatusKey(s);
      const n = findingsCount(s);
      html.push(`<li data-sid="${esc(s.id)}" tabindex="0">
        <div class="survey-pin list" style="--st:var(--st-${k})"></div>
        <div class="txt"><div class="name">${esc(surveyTitle(s))}</div>
          <div class="meta"><span class="mono">${esc(fmtDate(s.date))}</span>${s.team ? `<span>${esc(s.team)}</span>` : ""}${s.createdBy ? `<span>נרשם ע"י ${esc(s.createdBy.name)}</span>` : ""}</div></div>
        <div class="when">${s.netsFound === "yes" ? `<span class="pill nets">רשתות${n ? " · " + n : ""}</span>` : `<span class="pill">${STATUSES[k].short}</span>`}</div>
      </li>`);
    }
    html.push("</ul>");
    $("#log-list").innerHTML = html.join("");
  }

  function initTabs() {
    document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
      $("#pane-log").classList.toggle("hidden", b.dataset.tab !== "log");
      $("#pane-sites").classList.toggle("hidden", b.dataset.tab !== "sites");
      if (isPhone()) setSheet(true);
    }));
    $("#log-search").addEventListener("input", renderLog);
    $("#log-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-logf]");
      if (!b) return;
      logFilter = logFilter === b.dataset.logf ? "" : b.dataset.logf;
      renderLog();
    });
    $("#log-list").addEventListener("click", (e) => {
      const li = e.target.closest("[data-sid]");
      if (li) focusSurvey(li.dataset.sid);
    });
    $("#log-list").addEventListener("keydown", (e) => {
      const li = e.target.closest("[data-sid]");
      if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); focusSurvey(li.dataset.sid); }
    });
  }

  // Phones: bottom sheet opens with a swipe up on its top edge, closes with a
  // swipe down or a tap on the map; the FAB hides while it is open.
  function setSheet(open) {
    $("#panel").classList.toggle("open", open);
    document.body.classList.toggle("sheet-open", open);
  }
  function initSheet() {
    const panel = $("#panel");
    let y0 = null;
    const start = (e) => { y0 = e.touches[0].clientY; };
    const end = (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0;
      y0 = null;
      if (dy < -30) setSheet(true);
      else if (dy > 30) setSheet(false);
    };
    for (const el of [$("#panel-handle"), panel.querySelector(".tabs")]) {
      el.addEventListener("touchstart", start, { passive: true });
      el.addEventListener("touchend", end, { passive: true });
    }
    $("#panel-handle").addEventListener("click", () => setSheet(!panel.classList.contains("open")));
    map.on("click", () => { if (isPhone() && !drawMode && panel.classList.contains("open")) setSheet(false); });
    map.on("dragstart", () => { if (isPhone() && panel.classList.contains("open")) setSheet(false); });
    $("#fab-survey").addEventListener("click", startNewSurvey);
  }

  function initMenu() {
    $("#new-survey-btn").addEventListener("click", startNewSurvey);
    const menu = $("#menu");
    menu.addEventListener("click", (e) => {
      const b = e.target.closest("[data-menu]");
      if (!b) return;
      menu.open = false;
      ({ "add-site": startAddSite, "draw-ridge": startDrawRidge, data: openData, team: openTeam, signout: signOut, share: shareLink })[b.dataset.menu]();
    });
    document.addEventListener("click", (e) => { if (!e.target.closest("#menu")) menu.open = false; });
  }

  // The installed app has no address bar, so the link has to come from the UI.
  function shareLink() {
    const url = location.origin + location.pathname;
    const copy = () => navigator.clipboard.writeText(url).then(() => toast("הקישור הועתק"), () => toast(url));
    if (navigator.share) {
      navigator.share({ title: "Divepoints", text: "סקר רשתות רפאים – סיירת החוף", url })
        .catch((e) => { if (e.name !== "AbortError") copy(); });
    } else copy();
  }

  // ------------------------------------------------------------ depth probe
  // Model depth at a point from the bundled shelf grid (EMODnet, ~115 m).
  // Returns metres, Infinity when deeper than the grid keeps, null on land
  // or outside the charted coast.
  const depthRowCache = {};
  function depthAt(lat, lng) {
    const g = window.DEPTH_GRID;
    if (!g) return null;
    const r = Math.floor((g.lat1 - lat) / g.res), c = Math.floor((lng - g.lon0) / g.res);
    const row = g.rows[r];
    if (!row) return null;
    if (!depthRowCache[r]) depthRowCache[r] = Uint8Array.from(atob(row[1]), (ch) => ch.charCodeAt(0));
    const bytes = depthRowCache[r], i = c - row[0];
    if (i < 0) return Infinity;            // seaward of the shelf span
    if (i >= bytes.length) return null;    // landward of it
    const v = bytes[i];
    return v === 255 ? null : v === 254 ? Infinity : v / 4;
  }

  function showDepthProbe(latlng) {
    if (drawMode) return;
    const d = depthAt(latlng.lat, latlng.lng);
    const max = (window.DEPTH_GRID && window.DEPTH_GRID.max) || 60;
    const num = d == null ? "—" : d === Infinity ? `>${max}` : d < 1 ? "<1" : d.toFixed(d < 10 ? 1 : 0);
    const where = d == null ? "יבשה או מחוץ לאזור המפה"
      : d <= SHALLOW_LIMIT ? "בתוך רצועת הסקר" : "מחוץ לרצועת הסקר";
    const html = `<div class="probe">
      <div class="probe-num"><b>${num}</b><span>מ'</span></div>
      <div class="probe-where ${d != null && d <= SHALLOW_LIMIT ? "in" : ""}">${where}</div>
      <div class="probe-wide hint">עומק משוער לפי מודל EMODnet (רזולוציה ~115 מ'). לא לניווט.</div>
      <div class="probe-wide coords"><span>${ddm(latlng.lat, "N", "S", 2)} ${ddm(latlng.lng, "E", "W", 3)}</span></div>
      ${d != null ? `<div class="card-actions"><button class="btn btn-primary small" data-act="survey-here" data-lat="${latlng.lat}" data-lng="${latlng.lng}">סקר כאן</button></div>` : ""}
    </div>`;
    L.popup({ maxWidth: 300, minWidth: 260, className: "probe-popup" }).setLatLng(latlng).setContent(html).openOn(map);
  }

  // Degrees and decimal minutes, as on a boat GPS: 32°06.576′N
  function ddm(v, pos, neg, degDigits) {
    const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return `${String(d).padStart(degDigits, "0")}°${m.toFixed(3).padStart(6, "0")}′${v >= 0 ? pos : neg}`;
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y.slice(2)}`;
  }

  // Site depth range on a 0–30 m scale, with the 15 m survey limit marked.
  function depthGauge(d) {
    if (!d) return "";
    const pct = (v) => (Math.min(v, 30) / 30) * 100;
    const a = pct(d[0]), b = pct(d[1]);
    return `<div class="gauge" role="img" aria-label="טווח עומק ${d[0]}–${d[1]} מטר">
      <div class="gauge-track"><span class="gauge-range" style="inset-inline-start:${a}%;width:${Math.max(b - a, 2)}%"></span><span class="gauge-limit"></span></div>
      <div class="gauge-scale mono"><span>0</span><span class="mid">15 מ'</span><span>30+</span></div>
    </div>`;
  }

  function popupHtml(siteId) {
    const site = getSite(siteId);
    const status = siteStatus(siteId);
    const surveys = surveysFor(siteId);
    const last = surveys[0];
    const cat = CATEGORIES[site.category] || CATEGORIES.other;
    const moved = state.siteEdits[site.id] && state.siteEdits[site.id].lat != null;
    const model = !site.custom && !moved && window.GRID_DEPTH ? window.GRID_DEPTH[site.id] : null;
    const src = site.verified ? "מאומת בשטח" : site.src === "osm" ? "לפי OpenStreetMap" : "מיקום משוער";
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${site.lat},${site.lng}`;
    const id = esc(site.id);
    return `<div style="--st:var(--st-${status})">
      <div class="card-status"><i></i>${STATUSES[status].label}${last ? ` · ${esc(fmtDate(last.date))}` : ""}</div>
      <div class="card-body">
        <div><div class="hint">${esc(cat.label)} · ${esc(REGIONS[site.region] || "")}</div><h3>${esc(site.name)}</h3></div>
        ${depthGauge(site.depth)}
        <dl class="facts">
          <div><dt>עומק</dt><dd>${fmtDepth(site.depth)}</dd></div>
          <div><dt>במודל העומק</dt><dd>${model != null ? `~${model} מ'` : "—"}</dd></div>
          <div><dt>סיכון</dt><dd>${esc(RISK[site.risk] || "—")}</dd></div>
        </dl>
        <p>${esc(site.desc || "")}</p>
        ${isEstimate(site) ? `<div class="warn">מיקום משוער. בסקר הראשון גררו את הנקודה למקום הנכון ("תקן מיקום").</div>` : ""}
        <div class="coords"><span>${ddm(site.lat, "N", "S", 2)} ${ddm(site.lng, "E", "W", 3)}</span><span class="src">${src}</span></div>
        <div class="card-actions">
          <button class="btn btn-primary small" data-act="new-survey" data-id="${id}">סקר חדש</button>
          <button class="btn small" data-act="history" data-id="${id}">היסטוריה · ${surveys.length}</button>
          <a class="btn btn-ghost small" href="${gmaps}" target="_blank" rel="noopener">ניווט</a>
        </div>
        <div class="card-actions more">
          <button class="btn btn-ghost small" data-act="move" data-id="${id}">תקן מיקום</button>
          ${site.verified ? "" : `<button class="btn btn-ghost small" data-act="verify" data-id="${id}">אשר מיקום</button>`}
          ${site.custom ? `<button class="btn btn-ghost small" data-act="edit-site" data-id="${id}">ערוך אתר</button>` : ""}
        </div>
      </div>
    </div>`;
  }

  // ----------------------------------------------------------------- sidebar
  let statusFilter = "";

  function filteredSites() {
    const q = $("#search").value.trim();
    const region = $("#filter-region").value;
    const cat = $("#filter-category").value;
    const shallow = $("#filter-shallow").checked;
    return allSites().filter((s) =>
      (!q || s.name.includes(q) || (s.desc || "").includes(q)) &&
      (!region || s.region === region) &&
      (!cat || s.category === cat) &&
      (!statusFilter || siteStatus(s.id) === statusFilter) &&
      (!shallow || !s.depth || s.depth[0] <= SHALLOW_LIMIT));
  }

  function renderSidebar() {
    const all = allSites();
    const counts = {};
    for (const s of all) { const k = siteStatus(s.id); counts[k] = (counts[k] || 0) + 1; }
    $("#done-count").textContent = all.length - (counts.unsurveyed || 0);
    $("#tab-sites-n").textContent = all.length;
    $("#total-count").textContent = all.length;
    // The coast as a barcode: one tick per site, north to south; colour is
    // survey status, height is net risk.
    const RISK_H = { high: 100, medium: 66, low: 40 };
    $("#coastbar").innerHTML = all.slice().sort((a, b) => b.lat - a.lat).map((s) => {
      const st = siteStatus(s.id);
      return `<button class="tick s-${st}" data-id="${esc(s.id)}" style="--st:var(--st-${st});--h:${RISK_H[s.risk] || 55}%"
        title="${esc(s.name)} · ${STATUSES[st].short}" aria-label="${esc(s.name)}, ${STATUSES[st].label}"></button>`;
    }).join("");
    $("#status-chips").innerHTML = STATUS_ORDER.map((k) =>
      `<li><button class="chip" data-status="${k}" aria-pressed="${statusFilter === k}">
        <span class="sw" style="background:var(--st-${k})"></span>${STATUSES[k].short}<span class="n">${counts[k] || 0}</span>
      </button></li>`).join("");

    const sites = filteredSites();
    if (!sites.length) {
      $("#site-list").innerHTML = `<div class="empty">אין אתרים שמתאימים לסינון.<br><br><button class="btn small" id="clear-filters">נקה סינון</button></div>`;
      return;
    }
    const html = [];
    for (const [rk, rname] of Object.entries(REGIONS)) {
      const group = sites.filter((s) => s.region === rk).sort((a, b) => b.lat - a.lat);
      if (!group.length) continue;
      html.push(`<h2 class="group"><span>${esc(rname)}</span><span class="n">${group.length}</span></h2><ul class="site-list">`);
      for (const s of group) {
        const st = siteStatus(s.id);
        const last = surveysFor(s.id)[0];
        const cat = CATEGORIES[s.category] || CATEGORIES.other;
        html.push(`<li data-id="${esc(s.id)}" tabindex="0">
          ${markHtml(s, st, "list-mark")}
          <div class="txt"><div class="name">${esc(s.name)}</div>
            <div class="meta"><span class="mono">${fmtDepth(s.depth)}</span><span>${esc(cat.label)}</span>${isEstimate(s) ? `<span class="tag-est">≈ מיקום משוער</span>` : ""}</div></div>
          <div class="when mono">${last ? esc(fmtDate(last.date)) : ""}</div>
        </li>`);
      }
      html.push(`</ul>`);
    }
    $("#site-list").innerHTML = html.join("");
  }

  function renderAll() {
    renderSidebar(); renderLog(); renderMap(); renderSurveys(); renderRidges();
  }

  function isPhone() { return window.matchMedia("(max-width: 760px)").matches; }

  function focusSite(id) {
    const m = markerById[id];
    if (!m) return;
    if (isPhone()) setSheet(false);
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 14));
    setTimeout(() => m.openPopup(), 400);
  }

  function initSidebar() {
    $("#filter-category").innerHTML += Object.entries(CATEGORIES)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");

    ["#search", "#filter-region", "#filter-category", "#filter-shallow"].forEach((sel) =>
      $(sel).addEventListener("input", renderAll));

    $("#status-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-status]");
      if (!b) return;
      statusFilter = statusFilter === b.dataset.status ? "" : b.dataset.status;
      renderAll();
    });

    $("#site-list").addEventListener("click", (e) => {
      if (e.target.closest("#clear-filters")) {
        statusFilter = ""; $("#search").value = ""; $("#filter-region").value = "";
        $("#filter-category").value = ""; $("#filter-shallow").checked = false;
        renderAll();
        return;
      }
      const li = e.target.closest("li[data-id]");
      if (li) focusSite(li.dataset.id);
    });
    $("#site-list").addEventListener("keydown", (e) => {
      const li = e.target.closest("li[data-id]");
      if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); focusSite(li.dataset.id); }
    });

    $("#toggle-panel").addEventListener("click", () => {
      $("#panel").classList.toggle("collapsed");
      setTimeout(() => map.invalidateSize(), 50);
    });

    $("#coastbar").addEventListener("click", (e) => {
      const b = e.target.closest(".tick");
      if (b) focusSite(b.dataset.id);
    });
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
      case "edit-survey": {
        map.closePopup();
        const s = state.surveys.find((x) => x.id === id);
        if (s) openSurveyForm(clone(s));
        break;
      }
      case "survey-here": {
        map.closePopup();
        openSurveyForm(newSurvey(null, L.latLng(+b.dataset.lat, +b.dataset.lng)));
        break;
      }
      case "ridge-hide":
        map.closePopup();
        state.ridgeFlags[id] = { hidden: true, at: Date.now(), by: me ? me.email : "" };
        persist("ridgeFlags", id, state.ridgeFlags[id]);
        renderRidges(true);
        toast("הרכס הוסתר לכל הצוות");
        break;
      case "ridge-delete":
        map.closePopup();
        confirmDialog("למחוק את הרכס שסומן?").then((ok) => {
          if (!ok) return;
          state.ridges = state.ridges.filter((r) => r.id !== id);
          persist("ridges", id, null);
          renderRidges(true);
        });
        break;
    }
  });

  function setSiteEdit(id, patch) {
    const custom = state.customSites.find((s) => s.id === id);
    if (custom) { Object.assign(custom, patch); persist("customSites", id, custom); }
    else {
      state.siteEdits[id] = Object.assign({}, state.siteEdits[id], patch);
      persist("siteEdits", id, state.siteEdits[id]);
    }
  }

  function startMoveSite(id) {
    const site = getSite(id);
    const m = markerById[id];
    if (!m) return;
    const original = m.getLatLng();
    // Zoom past the clustering threshold so the marker itself is on the map.
    map.setView(original, Math.max(map.getZoom(), 15));
    setTimeout(() => m.dragging && m.dragging.enable(), 450);
    setDrawMode({ type: "move", siteId: id }, `גרור את "${site.name}" למיקום הנכון ולחץ סיום`, {
      done: () => {
        const ll = m.getLatLng();
        setSiteEdit(id, { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), verified: true });
        renderAll();
        toast("המיקום עודכן");
      },
      cancel: () => { m.setLatLng(original); if (m.dragging) m.dragging.disable(); },
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
    if (renderPending) { renderPending = false; setTimeout(renderAll, 0); }
  }
  function updateDrawMsg(msg) { $("#draw-msg").textContent = msg; }

  $("#draw-done").addEventListener("click", () => { const m = drawMode; endDrawMode(); m && m.done && m.done(); });
  $("#draw-cancel").addEventListener("click", () => { const m = drawMode; endDrawMode(); m && m.cancel && m.cancel(); });
  $("#draw-undo").addEventListener("click", () => drawMode && drawMode.undo && drawMode.undo());

  function onMapClick(e) {
    if (!drawMode || !drawMode.click) return;
    drawMode.click(e.latlng);
  }

  function startAddSite() {
    setDrawMode({ type: "new-site" }, "לחצו על המפה במיקום אתר הצלילה החדש", {
      noUndo: true,
      click: (ll) => { endDrawMode(); openSiteForm({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }); },
      done: () => {},
    });
  }

  // ---------------------------------------------------------------- modal
  function openModal(html) {
    $("#modal-body").innerHTML = html;
    $("#modal").classList.remove("hidden");
    $("#modal").scrollTop = 0;
  }
  function closeModal() {
    $("#modal").classList.add("hidden");
    if (modalCleanup) { modalCleanup(); modalCleanup = null; }
  }
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
      let rec;
      if (isNew) { rec = Object.assign({ id: uid("custom") }, data); state.customSites.push(rec); }
      else { rec = Object.assign(state.customSites.find((s) => s.id === site.id), data); }
      persist("customSites", rec.id, rec);
      closeModal(); renderAll(); toast("האתר נשמר");
    });
    const del = $("#delete-site");
    if (del) del.addEventListener("click", async () => {
      const gone = surveysFor(site.id);
      if (!(await confirmDialog(`למחוק את "${site.name}"${gone.length ? ` ואת ${gone.length} הסקרים שלו` : ""}?`))) return;
      state.customSites = state.customSites.filter((s) => s.id !== site.id);
      state.surveys = state.surveys.filter((s) => s.siteId !== site.id);
      closeModal(); renderAll();
      await persist("customSites", site.id, null);
      for (const s of gone) await persist("surveys", s.id, null);
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
  function newSurvey(siteId, latlng) {
    let site = siteId ? getSite(siteId) : null;
    if (!site && latlng) {
      const near = nearbySites(latlng.lat, latlng.lng, 0.4)[0];   // auto-link a site within 400 m
      if (near) site = near.site;
    }
    const pos = latlng || (site && L.latLng(site.lat, site.lng));
    return {
      id: uid("survey"), siteId: site ? site.id : "", isNew: true,
      lat: pos ? +pos.lat.toFixed(6) : null, lng: pos ? +pos.lng.toFixed(6) : null,
      modelDepth: pos ? depthAt(pos.lat, pos.lng) : null,
      place: latlng || !site ? "" : site.name,
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
    const w = s.water, d = s.dive;
    const loc = surveyLoc(s);
    const near = loc ? nearbySites(loc[0], loc[1], 2) : [];
    if (s.siteId && !near.some((x) => x.site.id === s.siteId) && getSite(s.siteId)) near.unshift({ site: getSite(s.siteId), d: 0 });
    openModal(`<h2>${s.isNew ? "סקר חדש" : "סקר"} – ${esc(surveyTitle(s))}</h2>
      <p class="sub">${s.createdBy ? `נרשם ע"י ${esc(s.createdBy.name)}` : ""}${s.updatedBy && s.createdBy && s.updatedBy.email !== s.createdBy.email ? ` · עודכן ע"י ${esc(s.updatedBy.name)}` : ""}</p>
      <form id="survey-form">
        <fieldset><legend>מיקום</legend><div class="grid">
          <label class="field wide"><span>שם המקום</span><input name="place" value="${esc(s.place || "")}" placeholder="למשל: רכס צפוני מול חוף מכמורת"></label>
          <label class="field wide"><span>שייך לאתר צלילה</span><select name="siteId">
            <option value="">— נקודה עצמאית —</option>
            ${near.map((x) => `<option value="${esc(x.site.id)}"${x.site.id === s.siteId ? " selected" : ""}>${esc(x.site.name)}${x.d ? ` (${x.d < 1000 ? Math.round(x.d) + " מ'" : (x.d / 1000).toFixed(1) + " ק\"מ"})` : ""}</option>`).join("")}
          </select></label>
        </div>
        <div class="loc-row"><span class="mono" dir="ltr">${loc ? ddm(loc[0], "N", "S", 2) + "  " + ddm(loc[1], "E", "W", 3) : "אין מיקום"}</span>
          ${loc ? (() => { const md = depthAt(loc[0], loc[1]); return md == null ? "" : `<span class="pill">עומק משוער ${md === Infinity ? ">60" : "~" + md.toFixed(md < 10 ? 1 : 0)} מ'</span>`; })() : ""}
          <button type="button" class="btn btn-ghost small" id="move-point">הזז את הנקודה במפה</button></div>
        </fieldset>
        <fieldset><legend>פרטי הסקר</legend><div class="grid">
          <label class="field"><span>תאריך</span><input type="date" name="date" value="${esc(s.date)}" required></label>
          <label class="field"><span>שעת כניסה</span><input type="time" name="timeStart" value="${esc(s.timeStart)}"></label>
          <div class="field wide"><span>סטטוס</span><div class="segmented" role="radiogroup" aria-label="סטטוס הסקר">
            ${Object.entries(SURVEY_STATUS).map(([k, v]) => `<label><input type="radio" name="status" value="${k}"${s.status === k ? " checked" : ""}>${v}</label>`).join("")}
          </div></div>
          <label class="field wide"><span>צוות / צוללים</span><input name="team" value="${esc(s.team)}" placeholder="שמות הצוללים, ראש צוות"></label>
          <label class="field wide" id="reason-field"><span>סיבה לאי ביצוע / ביצוע חלקי</span><input name="notDoneReason" value="${esc(s.notDoneReason)}" placeholder="למשל: ים גבוה, ראות אפסית, תקלה בציוד"></label>
        </div></fieldset>

        <fieldset><legend>ממצאים</legend>
          <div class="segmented big nets" role="radiogroup" aria-label="האם נמצאו רשתות">
            <label><input type="radio" name="netsFound" value="no"${s.netsFound === "no" ? " checked" : ""}>לא נמצאו רשתות</label>
            <label class="yes"><input type="radio" name="netsFound" value="yes"${s.netsFound === "yes" ? " checked" : ""}>נמצאו רשתות / ציוד דיג</label>
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
          ${IN_CLAUDE ? "" : `<button type="button" class="btn btn-ghost small" id="gps-route">📡 הקלט GPS (מצוף/סירה)</button>`}
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

    $("#move-point").addEventListener("click", () => withMapInteraction(() => {
      const l = surveyLoc(draft);
      if (l) map.setView(l, Math.max(map.getZoom(), 15));
      setDrawMode({ type: "move-point" }, "לחצו על המפה במיקום המדויק של הסקר", {
        noUndo: true,
        click: (ll) => { draft.lat = +ll.lat.toFixed(6); draft.lng = +ll.lng.toFixed(6); endDrawMode(); reopenDraft(); },
        done: reopenDraft, cancel: reopenDraft,
      });
    }));
    $("#draw-route").addEventListener("click", startDrawRoute);
    if ($("#gps-route")) $("#gps-route").addEventListener("click", startGpsRoute);
    $("#gpx-file").addEventListener("change", importGpx);
    $("#clear-route").addEventListener("click", () => {
      draft.route = []; draft.routeSource = ""; $("#route-info").innerHTML = routeInfo(draft);
    });
    $("#cancel-survey").addEventListener("click", () => { closeModal(); draft = null; });
    const del = $("#delete-survey");
    if (del) del.addEventListener("click", async () => {
      if (!(await confirmDialog("למחוק את הסקר?"))) return;
      const id = draft.id;
      state.surveys = state.surveys.filter((x) => x.id !== id);
      closeModal(); draft = null; renderAll();
      if (await persist("surveys", id, null)) toast("הסקר נמחק");
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      readSurveyForm();
      const rec = JSON.parse(JSON.stringify(draft));
      delete rec.isNew;
      if (rec.netsFound !== "yes") rec.findings = [];
      rec.updatedAt = Date.now();
      if (me) {
        const who = { name: me.name, email: me.email };
        if (!rec.createdBy) rec.createdBy = who;
        rec.updatedBy = who;
      }
      const i = state.surveys.findIndex((x) => x.id === rec.id);
      if (i >= 0) state.surveys[i] = rec;
      else { rec.createdAt = rec.updatedAt; state.surveys.push(rec); }
      closeModal(); draft = null; renderAll();
      persist("surveys", rec.id, rec).then((ok) => ok && toast(db ? "הסקר נשמר ומשותף עם הצוות" : "הסקר נשמר"));
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
    draft.place = (f.get("place") || "").trim();
    draft.siteId = f.get("siteId") || "";
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
      const here = surveyLoc(draft);
      if (here) map.setView(here, Math.max(map.getZoom(), 16));
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
      const here = surveyLoc(draft);
      if (here) map.setView(here, Math.max(map.getZoom(), 16));
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
          <span class="badge" style="background:var(--st-${surveyStatusKey(s)})">${esc(SURVEY_STATUS[s.status])}${s.netsFound === "yes" ? " · נמצאו רשתות" : ""}</span>
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
  function openData() {
    const backlog = db ? localBacklog() : { surveys: [] };
    openModal(`<h2>נתונים וגיבוי</h2>
      <p class="hint">${db
        ? "הנתונים משותפים: כל סקר שנשמר מופיע מיד אצל כל מי שפותח את המפה. מומלץ לייצא גיבוי מדי פעם."
        : "הנתונים נשמרים בדפדפן של המכשיר הזה בלבד. כדי לשתף עם הצוות או לגבות – ייצא קובץ גיבוי והעבר אותו (וואטסאפ / דרייב). ייבוא ממזג את הנתונים עם הקיימים."}</p>
      <p>סה"כ: ${state.surveys.length} סקרים · ${state.ridges.length} רכסים שסומנו · ${state.customSites.length} אתרים שנוספו · ${Object.keys(state.siteEdits).length} תיקוני מיקום</p>
      ${backlog.surveys.length ? `<fieldset><legend>נתונים מהמכשיר</legend>
        <p class="hint">${backlog.surveys.length} סקרים נשמרו במכשיר הזה לפני שהסנכרון הופעל.</p>
        <button class="btn btn-primary" id="upload-local">העלה אותם לצוות</button></fieldset>` : ""}
      <fieldset><legend>ייצוא</legend><div class="row">
        <button class="btn" id="exp-json">גיבוי מלא (JSON)</button>
        <button class="btn btn-ghost" id="exp-geojson">GeoJSON (ל-Google My Maps / QGIS)</button>
        <button class="btn btn-ghost" id="exp-csv">טבלת סקרים (CSV לאקסל)</button>
      </div></fieldset>
      <fieldset><legend>ייבוא</legend>
        <label class="btn btn-ghost">בחר קובץ גיבוי JSON<input type="file" id="imp-json" accept=".json,application/json" hidden></label>
      </fieldset>
      ${db ? "" : `<fieldset><legend>איפוס</legend>
        <button class="btn btn-danger" id="reset-data">מחק את כל הנתונים המקומיים</button>
      </fieldset>`}`);
    $("#exp-json").addEventListener("click", exportJson);
    $("#exp-geojson").addEventListener("click", exportGeoJson);
    $("#exp-csv").addEventListener("click", exportCsv);
    $("#imp-json").addEventListener("change", importJson);
    if ($("#reset-data")) $("#reset-data").addEventListener("click", async () => {
      if (!(await confirmDialog("למחוק את כל הסקרים, האתרים שנוספו ותיקוני המיקום מהמכשיר? מומלץ לייצא גיבוי קודם."))) return;
      state.customSites = []; state.siteEdits = {}; state.surveys = [];
      saveLocal(); closeModal(); renderAll();
    });
    if ($("#upload-local")) $("#upload-local").addEventListener("click", () => {
      for (const s of backlog.surveys) { state.surveys.push(s); persist("surveys", s.id, s); }
      closeModal(); renderAll();
      toast(`${backlog.surveys.length} סקרים הועלו לצוות`);
    });
  }

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
      const writes = [];
      for (const s of data.surveys || []) {
        const i = state.surveys.findIndex((x) => x.id === s.id);
        if (i < 0) { state.surveys.push(s); added++; writes.push(["surveys", s.id, s]); }
        else if ((s.updatedAt || 0) > (state.surveys[i].updatedAt || 0)) { state.surveys[i] = s; updated++; writes.push(["surveys", s.id, s]); }
      }
      for (const s of data.customSites || []) {
        const i = state.customSites.findIndex((x) => x.id === s.id);
        const rec = i < 0 ? s : Object.assign(state.customSites[i], s);
        if (i < 0) state.customSites.push(rec);
        writes.push(["customSites", rec.id, rec]);
      }
      for (const [id, e] of Object.entries(data.siteEdits || {})) {
        state.siteEdits[id] = e; writes.push(["siteEdits", id, e]);
      }
      closeModal(); renderAll();
      (async () => {
        if (db) { for (const w of writes) await persist(...w); } else saveLocal();
        toast(`יובאו ${added} סקרים חדשים, ${updated} עודכנו`);
      })();
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
      const loc = surveyLoc(s);
      if (loc) {
        features.push({ type: "Feature",
          properties: { kind: "survey", place: surveyTitle(s), site: siteName || "", date: s.date, status: SURVEY_STATUS[s.status],
            nets_found: s.netsFound === "yes", findings: findingsCount(s), removed: removedCount(s), team: s.team,
            recorded_by: s.createdBy ? s.createdBy.name : "" },
          geometry: { type: "Point", coordinates: [loc[1], loc[0]] } });
      }
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
    const cols = ["מקום", "קו רוחב", "קו אורך", "נרשם ע\"י", "אתר", "אזור", "תאריך", "שעה", "סטטוס", "סיבה", "צוות", "נמצאו רשתות", "ממצאים",
      "תיאור אתר", "קרקעית", "חי ים", "ראות", "טמפ'", "זרם", "כיוון זרם", "מצב ים", "רוח", "הערות מים",
      "כניסה", "עומק מקס'", "משך", "צוללים", "תיאור צלילה", "אורך מסלול (מ')"];
    const rows = state.surveys.map((s) => {
      const site = getSite(s.siteId) || {};
      const loc = surveyLoc(s) || ["", ""];
      return [surveyTitle(s), loc[0], loc[1], s.createdBy ? s.createdBy.name : "", site.name, REGIONS[site.region], s.date, s.timeStart, SURVEY_STATUS[s.status], s.notDoneReason, s.team,
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
  initTabs();
  initMenu();
  initSheet();
  setSyncBadge();
  restoreLayers();
  renderAll();
  initSharedStore();
})();
