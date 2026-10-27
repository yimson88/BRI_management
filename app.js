(() => {
  "use strict";

  const STORAGE_KEY = "brisCuisine.management.v1";
  const RECOVERY_KEY = "brisCuisine.recovery.v1";
  const SESSION_KEY = "brisCuisine.session.v1";
  const FILE_HANDLE_DB = "brisCuisine.liveJson.v1";
  const LOCK_AFTER = 30 * 60 * 1000;
  const DEPARTMENTS = {
    food: { name: "Food", short: "FD" },
    snacks: { name: "Snacks & Pastries", short: "SP" },
    drinks: { name: "Drinks", short: "DR" }
  };
  const EXPENSE_CATEGORIES = [
    "Market Purchase (Groceries)", "Meat / Fish / Poultry", "Gas Refills / Utilities",
    "Staff Daily Wages / Allowances", "Transport", "Repairs & Maintenance", "Miscellaneous"
  ];
  const PAYMENT_METHODS = ["Cash", "Mobile Money", "Card / Transfer"];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const uid = (prefix = "id") => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const dateFromISO = value => {
    const [y, m, d] = String(value).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  };
  const isoFromDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const addDays = (iso, count) => { const d = dateFromISO(iso); d.setDate(d.getDate() + count); return isoFromDate(d); };
  const sum = (items, mapper = value => value) => items.reduce((total, item) => total + Number(mapper(item) || 0), 0);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const money = value => `${new Intl.NumberFormat("en-CM", { maximumFractionDigits: 0 }).format(Number(value || 0))} FCFA`;
  const number = value => new Intl.NumberFormat("en-CM", { maximumFractionDigits: 2 }).format(Number(value || 0));
  const formatDate = (iso, options = {}) => dateFromISO(iso).toLocaleDateString("en-GB", options.short ? { day: "2-digit", month: "short" } : { day: "2-digit", month: "short", year: "numeric" });
  const formatDateTime = value => new Date(value).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const escapeHTML = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const initials = value => String(value || "User").split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
  const departmentName = key => DEPARTMENTS[key]?.name || "Global";
  const inRange = (value, start, end) => value >= start && value <= end;

  function hashPassword(value) {
    const text = `BRIS::${value}::CUISINE`;
    let a = 0xdeadbeef ^ text.length;
    let b = 0x41c6ce57 ^ text.length;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 2654435761);
      b = Math.imul(b ^ c, 1597334677);
    }
    a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
    b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
    return `${(b >>> 0).toString(16).padStart(8, "0")}${(a >>> 0).toString(16).padStart(8, "0")}`;
  }

  function defaultState() {
    const users = [
      ["ceo", "BRI@2026", "Chief Executive Officer", "ceo", null],
      ["food", "Food@2026", "Food Salesperson", "department", "food"],
      ["snacks", "Snacks@2026", "Snacks & Pastries Salesperson", "department", "snacks"],
      ["drinks", "Drinks@2026", "Drinks Salesperson", "department", "drinks"]
    ].map(([username, password, name, role, department]) => ({
      id: uid("usr"), username, passwordHash: hashPassword(password), name, role, department,
      active: true, mustChange: true, createdAt: new Date().toISOString()
    }));
    return {
      version: 1,
      settings: { businessName: "BRI'S CUISINE", currency: "FCFA" },
      users, inventory: [], stockMovements: [], sales: [], expenses: [], sessions: [], activity: []
    };
  }

  function loadState() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!stored || !Array.isArray(stored.users)) throw new Error("Invalid state");
      return { ...defaultState(), ...stored, settings: { ...defaultState().settings, ...(stored.settings || {}) } };
    } catch {
      try {
        const recovered = JSON.parse(localStorage.getItem(RECOVERY_KEY));
        if (!recovered || !Array.isArray(recovered.users)) throw new Error("Invalid recovery state");
        localStorage.setItem(STORAGE_KEY, JSON.stringify(recovered));
        return { ...defaultState(), ...recovered, settings: { ...defaultState().settings, ...(recovered.settings || {}) } };
      } catch {
        const fresh = defaultState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
        return fresh;
      }
    }
  }

  let state = loadState();
  let currentUser = null;
  let liveFileHandle = null;
  let liveWriteActive = false;
  let liveWriteQueued = false;
  let serverConnected = false;
  let serverWriteActive = false;
  let serverWriteQueued = false;
  let lastSaveError = null;
  const ui = {
    route: "dashboard", department: "food", cart: [], productSearch: "", inventorySearch: "",
    inventoryDept: "all", expenseDept: "all", expenseDate: todayISO(), reportPeriod: "daily",
    reportAnchor: todayISO(), reportDepartment: "all", customStart: todayISO(), customEnd: todayISO()
  };

  function saveState() {
    const json = JSON.stringify(state);
    try {
      const previous = localStorage.getItem(STORAGE_KEY);
      if (previous) localStorage.setItem(RECOVERY_KEY, previous);
      localStorage.setItem(STORAGE_KEY, json);
      lastSaveError = null;
      updateSaveStatus("saved");
      queueServerJSONWrite();
      queueLiveJSONWrite();
    } catch (error) {
      lastSaveError = error;
      updateSaveStatus("error");
      if (currentUser) toast("Automatic save failed", "Export a JSON backup now and check available browser storage.", "error");
    }
  }

  function updateSaveStatus(status = "saved") {
    const badge = $("#offline-badge");
    if (!badge) return;
    if (status === "saving") badge.innerHTML = '<span class="status-dot"></span> Saving JSON…';
    else if (status === "error") badge.innerHTML = '<span class="status-dot" style="background:#b3293c"></span> Save problem';
    else badge.innerHTML = `<span class="status-dot"></span> ${liveFileHandle || serverConnected ? "JSON file saved" : "Auto-saved"}`;
    badge.title = status === "error" ? "The latest change could not be saved" : `Last automatic save: ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }

  function openHandleDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB unavailable"));
      const request = indexedDB.open(FILE_HANDLE_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("handles");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function storeLiveFileHandle(handle) {
    const database = await openHandleDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("handles", "readwrite");
      transaction.objectStore("handles").put(handle, "primary");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }

  async function getStoredLiveFileHandle() {
    const database = await openHandleDatabase();
    const handle = await new Promise((resolve, reject) => {
      const request = database.transaction("handles", "readonly").objectStore("handles").get("primary");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return handle;
  }

  async function restoreLiveFileConnection() {
    if (!("showSaveFilePicker" in window)) return;
    try {
      const handle = await getStoredLiveFileHandle();
      if (handle && await handle.queryPermission({ mode: "readwrite" }) === "granted") {
        liveFileHandle = handle;
        updateSaveStatus("saved");
        queueLiveJSONWrite();
      }
    } catch { /* Browser storage still remains the primary automatic save. */ }
  }

  async function connectLiveJSONFile() {
    if (!("showSaveFilePicker" in window)) {
      return toast("Live file is not supported here", "Use Chrome or Edge, or continue with automatic browser JSON storage and backups.", "error");
    }
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: "bris-cuisine-live-data.json",
        types: [{ description: "BRI'S CUISINE JSON database", accept: { "application/json": [".json"] } }]
      });
      const permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") throw new Error("Write permission was not granted");
      liveFileHandle = handle;
      await storeLiveFileHandle(handle);
      await writeLiveJSON();
      toast("Live JSON auto-save connected", "Every department change will now also be written to the selected file.");
      if (ui.route === "settings") renderSettings();
    } catch (error) {
      if (error?.name !== "AbortError") toast("Could not connect JSON file", error.message || "File permission was not granted.", "error");
    }
  }

  async function writeLiveJSON() {
    if (!liveFileHandle) return;
    updateSaveStatus("saving");
    const writable = await liveFileHandle.createWritable();
    await writable.write(JSON.stringify({ app: "BRIS_CUISINE", formatVersion: 1, savedAt: new Date().toISOString(), data: state }, null, 2));
    await writable.close();
    updateSaveStatus("saved");
  }

  async function queueLiveJSONWrite() {
    if (!liveFileHandle) return;
    liveWriteQueued = true;
    if (liveWriteActive) return;
    liveWriteActive = true;
    while (liveWriteQueued) {
      liveWriteQueued = false;
      try { await writeLiveJSON(); }
      catch (error) {
        lastSaveError = error;
        updateSaveStatus("error");
        if (currentUser) toast("Live JSON file save failed", "Browser storage is still safe. Reconnect the live JSON file in Settings.", "error");
      }
    }
    liveWriteActive = false;
  }

  async function loadServerJSON() {
    if (location.protocol === "file:") return;
    try {
      const response = await fetch("/api/data", { cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json();
      serverConnected = true;
      if (payload?.data && Array.isArray(payload.data.users)) {
        state = { ...defaultState(), ...payload.data, settings: { ...defaultState().settings, ...(payload.data.settings || {}) } };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } else {
        queueServerJSONWrite();
      }
      updateSaveStatus("saved");
    } catch { serverConnected = false; }
  }

  async function writeServerJSON() {
    if (!serverConnected) return;
    updateSaveStatus("saving");
    const response = await fetch("/api/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: state })
    });
    if (!response.ok) throw new Error(`Local JSON server returned ${response.status}`);
    updateSaveStatus("saved");
  }

  async function queueServerJSONWrite() {
    if (!serverConnected) return;
    serverWriteQueued = true;
    if (serverWriteActive) return;
    serverWriteActive = true;
    while (serverWriteQueued) {
      serverWriteQueued = false;
      try { await writeServerJSON(); }
      catch (error) {
        lastSaveError = error;
        updateSaveStatus("error");
        if (currentUser) toast("JSON database save failed", "Browser recovery storage is still safe. Keep the BRI launcher window open.", "error");
      }
    }
    serverWriteActive = false;
  }

  function activity(action, detail, department = null) {
    state.activity.unshift({ id: uid("act"), action, detail, department, userId: currentUser?.id || null, userName: currentUser?.name || "System", at: new Date().toISOString() });
    state.activity = state.activity.slice(0, 300);
  }

  const icons = {
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>',
    sale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 2l1 4h10l1-4M4 6h16l-1 16H5L4 6z"/><path d="M9 11v6m6-6v6"/></svg>',
    stock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 8l-9 5-9-5 9-5 9 5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/></svg>',
    expense: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18m-5 5h2"/></svg>',
    report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 20V10m5 10V4m6 16v-7m5 7V7"/></svg>',
    reconcile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 7h-9a4 4 0 000 8h10"/><path d="M17 3l4 4-4 4M4 17h9a4 4 0 000-8H3"/><path d="M7 21l-4-4 4-4"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0015 19.4a1.7 1.7 0 00-1 .6 1.7 1.7 0 00-.4 1.1V21h-4v-.1A1.7 1.7 0 008.6 19.4a1.7 1.7 0 00-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-.6-1 1.7 1.7 0 00-1.1-.4H3v-4h.1A1.7 1.7 0 004.6 8.6a1.7 1.7 0 00-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001-.6 1.7 1.7 0 00.4-1.1V3h4v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0019.4 9c.11.37.32.7.6 1 .3.27.68.4 1.1.4h.1v4h-.1a1.7 1.7 0 00-1.7.6z"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M10 17l5-5-5-5m5 5H3"/><path d="M14 3h5a2 2 0 012 2v14a2 2 0 01-2 2h-5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 4.2A10.6 10.6 0 0112 4c6.5 0 10 8 10 8a16 16 0 01-2.1 3.2M6.6 6.6C3.5 8.6 2 12 2 12s3.5 8 10 8a9.8 9.8 0 004.1-.9"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L8 18l-4 1 1-4L16.5 3.5z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3v12m-5-5l5 5 5-5M5 21h14"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 16V4m-5 5l5-5 5 5M5 20h14"/></svg>',
    print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><path d="M6 14h12v7H6z"/></svg>',
    money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="M16 8.5c-.8-1-2-1.5-4-1.5-2.2 0-3.5 1-3.5 2.5S9.8 12 12 12s3.5 1 3.5 2.5S14.2 17 12 17c-2 0-3.2-.5-4-1.5M12 5v14"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14m-6-6l6 6-6 6"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 6L9 17l-5-5"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6h18M8 6V4h8v2m3 0l-1 15H6L5 6m5 4v7m4-7v7"/></svg>'
  };

  const navItems = [
    ["dashboard", "Dashboard", icons.dashboard], ["pos", "Sales entry", icons.sale],
    ["inventory", "Stock & products", icons.stock], ["expenses", "Expenditure", icons.expense],
    ["reports", "Sales reports", icons.report], ["reconciliation", "Cash reconciliation", icons.reconcile]
  ];

  function isCEO() { return currentUser?.role === "ceo"; }
  function allowedDepartment(requested) { return isCEO() ? (DEPARTMENTS[requested] ? requested : "food") : currentUser.department; }
  function activeSession(department) { return state.sessions.find(s => s.department === department && s.status === "open"); }
  function salesFor(department = null) { return state.sales.filter(s => !department || s.department === department); }
  function expensesFor(department = null) { return state.expenses.filter(e => !department || e.department === department); }
  function itemsFor(department = null) { return state.inventory.filter(item => !department || item.department === department); }

  function setSession(user) {
    currentUser = user;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId: user.id, lastActive: Date.now() }));
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    currentUser = null;
  }

  function restoreSession() {
    try {
      const session = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      if (!session || Date.now() - session.lastActive > LOCK_AFTER) return false;
      const user = state.users.find(u => u.id === session.userId && u.active);
      if (!user) return false;
      setSession(user);
      return true;
    } catch { return false; }
  }

  function showLogin() {
    $("#login-screen").hidden = false;
    $("#app-shell").hidden = true;
    $("#login-form").reset();
    $("#login-error").hidden = true;
    setTimeout(() => $("#login-username").focus(), 50);
  }

  function showApp() {
    $("#login-screen").hidden = true;
    $("#app-shell").hidden = false;
    ui.department = currentUser.department || "food";
    ui.inventoryDept = isCEO() ? "all" : currentUser.department;
    ui.expenseDept = isCEO() ? "all" : currentUser.department;
    ui.reportDepartment = isCEO() ? "all" : currentUser.department;
    renderNavigation();
    updateUserUI();
    navigate("dashboard");
  }

  function renderNavigation() {
    const base = navItems.map(([route, label, svg], index) => `${index === 0 ? '<div class="nav-label">Operations</div>' : ""}<button class="nav-button" data-route="${route}">${svg}<span>${label}</span></button>`).join("");
    const management = isCEO() ? `<div class="nav-label">Management</div><button class="nav-button" data-route="team">${icons.users}<span>Team access</span></button><button class="nav-button" data-route="settings">${icons.settings}<span>Backup & settings</span></button>` : "";
    $("#main-nav").innerHTML = base + management;
    $("#logout-button").innerHTML = `${icons.logout}<span>Lock & sign out</span>`;
  }

  function updateUserUI() {
    $("#user-name").textContent = currentUser.name;
    $("#user-role").textContent = isCEO() ? "CEO · All departments" : `${departmentName(currentUser.department)} department`;
    $("#user-avatar").textContent = initials(currentUser.name);
    $("#today-label").textContent = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
    $("#default-password-banner").hidden = !currentUser.mustChange;
  }

  function navigate(route) {
    const allowed = [...navItems.map(item => item[0]), ...(isCEO() ? ["team", "settings"] : [])];
    ui.route = allowed.includes(route) ? route : "dashboard";
    $$(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.route === ui.route));
    const meta = {
      dashboard: ["OVERVIEW", "Dashboard"], pos: ["OPERATIONS", "Sales entry"], inventory: ["OPERATIONS", "Stock & products"],
      expenses: ["FINANCE", "Expenditure"], reports: ["INSIGHTS", "Sales reports"], reconciliation: ["FINANCE", "Cash reconciliation"],
      team: ["MANAGEMENT", "Team access"], settings: ["SYSTEM", "Backup & settings"]
    }[ui.route];
    $("#page-kicker").textContent = meta[0];
    $("#page-title").textContent = meta[1];
    closeSidebar();
    renderRoute();
    $("#page-content").focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setQuickAction(label, action, svg = icons.plus, visible = true) {
    const button = $("#quick-action");
    button.hidden = !visible;
    button.dataset.action = action || "";
    button.innerHTML = `${svg}<span>${label}</span>`;
  }

  function renderRoute() {
    const renderers = { dashboard: renderDashboard, pos: renderPOS, inventory: renderInventory, expenses: renderExpenses, reports: renderReports, reconciliation: renderReconciliation, team: renderTeam, settings: renderSettings };
    (renderers[ui.route] || renderDashboard)();
  }

  function closeSidebar() {
    $("#sidebar").classList.remove("open");
    $("#sidebar-scrim").hidden = true;
  }

  function departmentOptions(selected, includeAll = false) {
    return `${includeAll ? `<option value="all" ${selected === "all" ? "selected" : ""}>All departments</option>` : ""}${Object.entries(DEPARTMENTS).map(([key, dept]) => `<option value="${key}" ${selected === key ? "selected" : ""}>${dept.name}</option>`).join("")}`;
  }

  function kpiCard(label, value, foot, icon, tone = "") {
    return `<article class="kpi-card"><div class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-icon ${tone}">${icon}</span></div><strong class="kpi-value mono">${value}</strong><div class="kpi-foot">${foot}</div></article>`;
  }

  function trendHTML(current, previous) {
    if (!previous) return current ? '<span class="trend up">New</span> vs previous day' : "No previous-day activity";
    const pct = ((current - previous) / previous) * 100;
    return `<span class="trend ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "↑" : "↓"} ${Math.abs(pct).toFixed(0)}%</span> vs previous day`;
  }

  function dailySeries(department, days = 7, end = todayISO()) {
    return Array.from({ length: days }, (_, index) => addDays(end, index - days + 1)).map(date => ({
      date,
      revenue: sum(state.sales.filter(s => s.date === date && (!department || s.department === department)), s => s.total),
      expense: sum(state.expenses.filter(e => e.date === date && (!department || e.department === department)), e => e.amount)
    }));
  }

  function lineChart(series, keys = ["revenue"]) {
    const width = 720, height = 220, left = 42, right = 14, top = 14, bottom = 34;
    const plotW = width - left - right, plotH = height - top - bottom;
    const values = series.flatMap(point => keys.map(key => Number(point[key] || 0)));
    const max = Math.max(...values, 1);
    const x = index => left + (series.length === 1 ? plotW / 2 : index * plotW / (series.length - 1));
    const y = value => top + plotH - Number(value || 0) / max * plotH;
    const grid = [0, .25, .5, .75, 1].map(level => `<line class="chart-grid-line" x1="${left}" y1="${top + plotH * level}" x2="${width - right}" y2="${top + plotH * level}"/><text class="chart-label" x="0" y="${top + plotH * level + 3}">${compactMoney(max * (1 - level))}</text>`).join("");
    const labels = series.map((point, index) => `<text class="chart-label" text-anchor="middle" x="${x(index)}" y="${height - 7}">${formatDate(point.date, { short: true })}</text>`).join("");
    const plots = keys.map((key, keyIndex) => {
      const points = series.map((point, index) => `${x(index)},${y(point[key])}`).join(" ");
      return `<polyline points="${points}" fill="none" stroke="${keyIndex ? "#d3a027" : "#7f1f43"}" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>${series.map((point, index) => `<circle cx="${x(index)}" cy="${y(point[key])}" r="3.5" fill="white" stroke="${keyIndex ? "#d3a027" : "#7f1f43"}" stroke-width="2"><title>${formatDate(point.date)} · ${key}: ${money(point[key])}</title></circle>`).join("")}`;
    }).join("");
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Revenue trend chart">${grid}${plots}${labels}</svg>`;
  }

  function compactMoney(value) {
    const n = Number(value || 0);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    return String(Math.round(n));
  }

  function forecast(department = null) {
    const grouped = {};
    state.sales.filter(s => !department || s.department === department).forEach(s => { grouped[s.date] = (grouped[s.date] || 0) + Number(s.total); });
    const dates = Object.keys(grouped).sort().slice(-14);
    if (dates.length < 3) return { ready: false, days: dates.length, daily: 0, weekly: 0, trend: 0, confidence: "Building" };
    const values = dates.map(date => grouped[date]);
    const weights = values.map((_, i) => i + 1);
    const daily = sum(values.map((value, i) => value * weights[i])) / sum(weights);
    const firstHalf = sum(values.slice(0, Math.ceil(values.length / 2))) / Math.ceil(values.length / 2);
    const secondHalf = sum(values.slice(Math.ceil(values.length / 2))) / Math.max(1, Math.floor(values.length / 2));
    const trend = firstHalf ? ((secondHalf - firstHalf) / firstHalf) * 100 : 0;
    return { ready: true, days: dates.length, daily, weekly: daily * 7, trend, confidence: dates.length >= 10 ? "High" : dates.length >= 6 ? "Medium" : "Early" };
  }

  function recentTransactions(department = null, limit = 6) {
    const sales = state.sales.filter(s => !department || s.department === department).map(s => ({ type: "sale", at: s.createdAt, title: s.itemName, subtitle: `${s.quantity} × ${money(s.unitPrice)} · ${departmentName(s.department)}`, amount: s.total }));
    const expenses = state.expenses.filter(e => !department || e.department === department).map(e => ({ type: "expense", at: e.createdAt, title: e.category, subtitle: `${e.supplier || "No supplier"} · ${e.scope === "global" ? "Global" : departmentName(e.department)}`, amount: -e.amount }));
    return [...sales, ...expenses].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
  }

  function transactionList(transactions) {
    if (!transactions.length) return `<div class="card-empty"><div><span class="empty-icon">${icons.report}</span><strong>No transactions yet</strong><p>Sales and expenditure entries will appear here as soon as work begins.</p></div></div>`;
    return `<div class="list">${transactions.map(row => `<div class="list-item"><span class="list-icon">${row.type === "sale" ? "IN" : "OUT"}</span><span class="list-copy"><strong>${escapeHTML(row.title)}</strong><small>${escapeHTML(row.subtitle)} · ${formatDateTime(row.at)}</small></span><span class="list-amount"><strong class="${row.amount >= 0 ? "text-success" : "text-danger"}">${row.amount >= 0 ? "+" : "−"}${money(Math.abs(row.amount))}</strong><small>${row.type === "sale" ? "Revenue" : "Expense"}</small></span></div>`).join("")}</div>`;
  }

  function renderDashboard() {
    setQuickAction("New sale", "go-sale", icons.plus);
    const dept = isCEO() ? null : currentUser.department;
    const today = todayISO(), yesterday = addDays(today, -1);
    const todaySales = state.sales.filter(s => s.date === today && (!dept || s.department === dept));
    const yesterdaySales = state.sales.filter(s => s.date === yesterday && (!dept || s.department === dept));
    const todayExpenses = state.expenses.filter(e => e.date === today && (!dept ? true : e.department === dept));
    const todayRevenue = sum(todaySales, s => s.total);
    const yesterdayRevenue = sum(yesterdaySales, s => s.total);
    const expenseTotal = sum(todayExpenses, e => e.amount);
    const lowStock = itemsFor(dept).filter(item => Number(item.quantity) <= Number(item.lowStock));
    const series = dailySeries(dept, 7);
    const pred = forecast(dept);

    const overview = isCEO()
      ? `${kpiCard("Today's revenue", money(todayRevenue), trendHTML(todayRevenue, yesterdayRevenue), icons.money, "green")}${kpiCard("Today's expenditure", money(expenseTotal), `${todayExpenses.filter(e => e.scope === "global").length} global expense entries`, icons.expense, "red")}${kpiCard("Net position", money(todayRevenue - expenseTotal), todayRevenue - expenseTotal >= 0 ? "Positive trading position" : "Expenditure exceeds revenue", icons.report, todayRevenue - expenseTotal >= 0 ? "gold" : "red")}${kpiCard("Low-stock products", number(lowStock.length), lowStock.length ? "Needs management attention" : "All registered stock is healthy", icons.stock, lowStock.length ? "red" : "green")}`
      : `${kpiCard("Today's revenue", money(todayRevenue), trendHTML(todayRevenue, yesterdayRevenue), icons.money, "green")}${kpiCard("Units sold", number(sum(todaySales, s => s.quantity)), `${todaySales.length} sale ${todaySales.length === 1 ? "entry" : "entries"}`, icons.sale, "gold")}${kpiCard("Today's expenditure", money(expenseTotal), `${todayExpenses.length} recorded ${todayExpenses.length === 1 ? "expense" : "expenses"}`, icons.expense, "red")}${kpiCard("Low-stock products", number(lowStock.length), lowStock.length ? "Restock required" : "Stock levels are healthy", icons.stock, lowStock.length ? "red" : "green")}`;

    const side = isCEO() ? forecastCard(pred, "all departments") : quickDepartmentPanel(currentUser.department, todayRevenue, expenseTotal);
    $("#page-content").innerHTML = `
      <div class="page-head"><div><h2>${isCEO() ? "Business command centre" : `${departmentName(dept)} department`}</h2><p>${isCEO() ? "A live view of revenue, expenditure, stock health and department performance." : "Record today's activity and keep your shift fully reconciled."}</p></div><div class="page-head-actions">${isCEO() ? '<button class="button button-secondary" data-route="reports">View full reports</button>' : `<span class="dept-chip">${departmentName(dept)}</span>`}</div></div>
      <section class="kpi-grid">${overview}</section>
      <section class="dashboard-grid">
        <article class="card"><header class="card-header"><div><h3>7-day performance</h3><p>Revenue${isCEO() ? " and total expenditure" : " trend"}</p></div><div class="legend"><span><i></i>Revenue</span>${isCEO() ? '<span><i class="gold"></i>Expenditure</span>' : ""}</div></header><div class="card-body"><div class="chart-wrap">${lineChart(series, isCEO() ? ["revenue", "expense"] : ["revenue"])}</div></div></article>
        ${side}
      </section>
      ${isCEO() ? `<section class="card" style="margin-bottom:20px"><header class="card-header"><div><h3>Department performance today</h3><p>Revenue, activity and stock health by service</p></div></header><div class="card-body"><div class="department-cards">${Object.keys(DEPARTMENTS).map(departmentCard).join("")}</div></div></section>` : renderStockWatch(lowStock)}
      <section class="dashboard-grid equal">
        <article class="card"><header class="card-header"><div><h3>Recent activity</h3><p>Latest sales and expenditure records</p></div><button class="button button-ghost button-small" data-route="reports">See reports ${icons.arrow}</button></header><div class="card-body">${transactionList(recentTransactions(dept))}</div></article>
        ${isCEO() ? `<article>${forecastCard(pred, "all departments")}</article>` : forecastCard(pred, departmentName(dept))}
      </section>`;
  }

  function quickDepartmentPanel(department, revenue, expense) {
    const shift = activeSession(department);
    return `<article class="card quick-panel"><div class="card-body"><p class="eyebrow">TODAY'S WORKSPACE</p><h3>${shift ? "Shift in progress" : "Ready to begin?"}</h3><p>${shift ? "Continue recording sales and expenses. Reconcile the cash drawer before signing off." : "Open a shift with the starting cash balance before recording sales."}</p><div class="shift-status"><span style="background:${shift ? "#5fe1a3" : "#f1cf78"}"></span><div><strong>${shift ? `${escapeHTML(shift.shift)} shift · Open` : "No open shift"}</strong><small>${shift ? `Cashier: ${escapeHTML(shift.cashierName)} · opened ${formatDateTime(shift.openedAt)}` : "Opening balance required"}</small></div></div><button class="button" data-action="${shift ? "go-sale" : "open-shift"}" data-department="${department}">${shift ? `${icons.plus} Record a new sale` : `${icons.reconcile} Open today's shift`}</button><div class="quick-stats"><div class="quick-stat"><small>Revenue</small><strong>${money(revenue)}</strong></div><div class="quick-stat"><small>Expenditure</small><strong>${money(expense)}</strong></div></div></div></article>`;
  }

  function forecastCard(pred, label) {
    return `<article class="forecast-card"><div class="forecast-top"><div><h3>7-day revenue forecast</h3><p>Weighted from recent recorded sales · ${escapeHTML(label)}</p></div><span class="forecast-icon">${icons.report}</span></div><strong class="forecast-value">${pred.ready ? money(pred.weekly) : "Learning…"}</strong><div class="forecast-foot"><span>${pred.ready ? `${pred.trend >= 0 ? "↑" : "↓"} ${Math.abs(pred.trend).toFixed(0)}% recent momentum` : `Add sales on ${Math.max(0, 3 - pred.days)} more day(s)`}</span><span class="confidence">${pred.confidence} confidence</span></div></article>`;
  }

  function departmentCard(department) {
    const today = todayISO();
    const deptSales = state.sales.filter(s => s.department === department && s.date === today);
    const revenue = sum(deptSales, s => s.total);
    const allRevenue = sum(state.sales.filter(s => s.date === today), s => s.total);
    const low = itemsFor(department).filter(item => Number(item.quantity) <= Number(item.lowStock)).length;
    return `<article class="department-card"><div class="department-head"><span class="department-badge">${icons[department === "food" ? "sale" : department === "drinks" ? "expense" : "stock"]}</span><span class="status-badge ${activeSession(department) ? "success" : "neutral"}">${activeSession(department) ? "Shift open" : "Closed"}</span></div><h4>${departmentName(department)}</h4><strong>${money(revenue)}</strong><div class="progress"><span style="width:${allRevenue ? clamp(revenue / allRevenue * 100, 3, 100) : 0}%"></span></div><div class="department-meta"><span>${deptSales.length} entries</span><span class="${low ? "text-danger" : "text-success"}">${low} low stock</span></div></article>`;
  }

  function renderStockWatch(lowStock) {
    if (!lowStock.length) return "";
    return `<section class="card" style="margin-bottom:20px"><header class="card-header"><div><h3>Stock attention</h3><p>Products at or below their alert level</p></div><button class="button button-ghost button-small" data-route="inventory">Manage stock ${icons.arrow}</button></header><div class="card-body"><div class="department-cards">${lowStock.slice(0, 3).map(item => `<article class="department-card"><div class="department-head"><span class="product-initial">${escapeHTML(item.name[0] || "P")}</span><span class="status-badge danger">Low</span></div><h4>${escapeHTML(item.name)}</h4><strong>${number(item.quantity)} ${escapeHTML(item.unit)}</strong><div class="department-meta"><span>Alert at ${number(item.lowStock)}</span><span>${money(item.sellingPrice)}</span></div></article>`).join("")}</div></div></section>`;
  }

  function renderPOS() {
    setQuickAction("Add product", "open-stock", icons.stock);
    const department = allowedDepartment(ui.department);
    ui.department = department;
    const shift = activeSession(department);
    const products = itemsFor(department).filter(item => item.active !== false && `${item.name} ${item.category}`.toLowerCase().includes(ui.productSearch.toLowerCase()));
    $("#page-content").innerHTML = `
      <div class="page-head"><div><h2>Sales counter</h2><p>Select registered products to build a sale. Stock is reduced automatically.</p></div><div class="page-head-actions">${isCEO() ? `<select id="pos-department" class="search-input" aria-label="Department">${departmentOptions(department)}</select>` : `<span class="dept-chip">${departmentName(department)}</span>`}</div></div>
      ${!shift ? `<div class="security-banner" style="margin:0 0 18px;border-radius:12px;background:#8c6312"><span></span><p><strong>No shift is open for ${departmentName(department)}.</strong> Open a shift before completing sales.</p><button class="button button-small button-inverse" data-action="open-shift" data-department="${department}">Open shift</button></div>` : ""}
      <section class="pos-layout">
        <div><div class="product-toolbar"><div class="search-wrap">${icons.search}<input id="product-search" class="search-input" value="${escapeHTML(ui.productSearch)}" placeholder="Search products or categories"></div><button class="button button-secondary" data-action="open-stock">${icons.plus} Register product</button></div>
        ${products.length ? `<div class="product-grid">${products.map(product => `<button class="product-card ${Number(product.quantity) <= 0 ? "out" : ""}" data-action="cart-add" data-id="${product.id}" ${Number(product.quantity) <= 0 ? "disabled" : ""}><span class="product-initial">${escapeHTML(product.name[0] || "P")}</span><span class="product-stock ${Number(product.quantity) <= Number(product.lowStock) ? "low" : ""}">${number(product.quantity)} ${escapeHTML(product.unit)}</span><h3>${escapeHTML(product.name)}</h3><p>${escapeHTML(product.category)}</p><strong>${money(product.sellingPrice)}</strong></button>`).join("")}</div>` : emptyState("No products available", "Register stock for this department before recording a sale.", "Register first product", "open-stock", icons.stock)}</div>
        ${renderCart(department, shift)}
      </section>`;
  }

  function renderCart(department, shift) {
    ui.cart = ui.cart.filter(line => state.inventory.some(item => item.id === line.itemId && item.department === department));
    const total = sum(ui.cart, line => line.quantity * line.unitPrice);
    return `<aside class="card sale-cart"><header class="card-header"><div><h3>Current sale</h3><p>${ui.cart.length} product ${ui.cart.length === 1 ? "line" : "lines"}</p></div>${ui.cart.length ? '<button class="button button-ghost button-small" data-action="cart-clear">Clear</button>' : ""}</header><div class="card-body cart-lines">${ui.cart.length ? ui.cart.map(line => `<div class="cart-line"><div><h4>${escapeHTML(line.name)}</h4><p>${money(line.unitPrice)} each · ${money(line.quantity * line.unitPrice)}</p></div><div class="quantity-control"><button data-action="cart-minus" data-id="${line.itemId}" aria-label="Reduce quantity">−</button><span>${line.quantity}</span><button data-action="cart-plus" data-id="${line.itemId}" aria-label="Increase quantity">+</button></div></div>`).join("") : `<div class="card-empty" style="min-height:150px"><div><span class="empty-icon">${icons.sale}</span><strong>Your sale is empty</strong><p>Choose a product from the list to add it here.</p></div></div>`}<div class="cart-summary"><div class="summary-row"><span>Items</span><strong>${sum(ui.cart, line => line.quantity)}</strong></div><div class="summary-row total"><span>Total due</span><strong>${money(total)}</strong></div></div></div><div class="cart-footer"><div class="field"><label for="sale-payment">Payment method</label><select id="sale-payment">${PAYMENT_METHODS.map(method => `<option>${method}</option>`).join("")}</select></div><button class="button button-primary button-large" data-action="complete-sale" ${!ui.cart.length || !shift ? "disabled" : ""}>${icons.check} Complete sale</button></div></aside>`;
  }

  function emptyState(title, copy, button, action, icon = icons.report) {
    return `<div class="card"><div class="card-empty"><div><span class="empty-icon">${icon}</span><strong>${title}</strong><p>${copy}</p>${button ? `<button class="button button-primary" data-action="${action}">${icons.plus}${button}</button>` : ""}</div></div></div>`;
  }

  function renderInventory() {
    setQuickAction("Register product", "open-stock", icons.plus);
    const department = isCEO() ? ui.inventoryDept : currentUser.department;
    const products = state.inventory.filter(item => (department === "all" || item.department === department) && `${item.name} ${item.category}`.toLowerCase().includes(ui.inventorySearch.toLowerCase()));
    const value = sum(products, item => item.quantity * item.costPrice);
    const low = products.filter(item => Number(item.quantity) <= Number(item.lowStock)).length;
    $("#page-content").innerHTML = `
      <div class="page-head"><div><h2>Products and stock</h2><p>Register products with their selling price, then restock or adjust quantities as needed.</p></div><div class="page-head-actions"><button class="button button-primary" data-action="open-stock">${icons.plus} Register product</button></div></div>
      <section class="kpi-grid">${kpiCard("Registered products", number(products.length), department === "all" ? "Across all departments" : departmentName(department), icons.stock)}${kpiCard("Units on hand", number(sum(products, item => item.quantity)), "Current recorded quantity", icons.stock, "gold")}${kpiCard("Stock cost value", money(value), "Quantity × cost price", icons.money, "green")}${kpiCard("Low-stock alerts", number(low), low ? "Action recommended" : "No current alerts", icons.report, low ? "red" : "green")}</section>
      <section class="card table-card"><div class="table-toolbar"><div class="search-wrap">${icons.search}<input id="inventory-search" class="search-input" value="${escapeHTML(ui.inventorySearch)}" placeholder="Search stock"></div><div class="toolbar">${isCEO() ? `<select id="inventory-department">${departmentOptions(department, true)}</select>` : ""}<button class="button button-secondary" data-action="export-inventory">${icons.download} Export CSV</button></div></div><div class="table-scroll"><table><thead><tr><th>Product</th><th>Department</th><th>Category</th><th>Quantity</th><th>Cost price</th><th>Selling price</th><th>Status</th><th></th></tr></thead><tbody>${products.length ? products.sort((a,b) => a.name.localeCompare(b.name)).map(item => `<tr><td><strong>${escapeHTML(item.name)}</strong><br><span class="caption">${escapeHTML(item.unit)}</span></td><td><span class="dept-chip">${departmentName(item.department)}</span></td><td>${escapeHTML(item.category)}</td><td class="mono"><strong>${number(item.quantity)}</strong> ${escapeHTML(item.unit)}</td><td class="mono">${money(item.costPrice)}</td><td class="mono"><strong>${money(item.sellingPrice)}</strong></td><td><span class="status-badge ${Number(item.quantity) <= 0 ? "danger" : Number(item.quantity) <= Number(item.lowStock) ? "warning" : "success"}">${Number(item.quantity) <= 0 ? "Out" : Number(item.quantity) <= Number(item.lowStock) ? "Low" : "Healthy"}</span></td><td><div class="row-actions"><button class="icon-button" data-action="restock" data-id="${item.id}" title="Restock">${icons.plus}</button><button class="icon-button" data-action="edit-stock" data-id="${item.id}" title="Edit">${icons.edit}</button></div></td></tr>`).join("") : `<tr><td colspan="8" class="table-empty">No products match this view.</td></tr>`}</tbody></table></div></section>`;
  }

  function renderExpenses() {
    setQuickAction("Record expense", "open-expense", icons.plus);
    const department = isCEO() ? ui.expenseDept : currentUser.department;
    const records = state.expenses.filter(expense => expense.date === ui.expenseDate && (department === "all" || expense.department === department)).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    const deptTotal = sum(records.filter(e => e.scope === "department"), e => e.amount);
    const globalTotal = sum(records.filter(e => e.scope === "global"), e => e.amount);
    $("#page-content").innerHTML = `
      <div class="page-head"><div><h2>Daily expenditure</h2><p>Capture department costs and business-wide global expenditure using the source sheet fields.</p></div><div class="page-head-actions"><button class="button button-primary" data-action="open-expense">${icons.plus} Record expense</button></div></div>
      <section class="kpi-grid">${kpiCard("Total expenditure", money(deptTotal + globalTotal), formatDate(ui.expenseDate), icons.expense, "red")}${kpiCard("Department expenses", money(deptTotal), `${records.filter(e => e.scope === "department").length} entries`, icons.expense, "gold")}${kpiCard("Global expenditure", money(globalTotal), isCEO() ? `${records.filter(e => e.scope === "global").length} CEO entries` : "Visible on CEO dashboard", icons.money)}${kpiCard("Vouchers captured", number(records.filter(e => e.voucher).length), "Traceable payment records", icons.report, "green")}</section>
      <section class="card table-card"><div class="table-toolbar"><div class="toolbar"><input id="expense-date-filter" type="date" value="${ui.expenseDate}" aria-label="Expense date">${isCEO() ? `<select id="expense-department">${departmentOptions(department, true)}</select>` : ""}</div><button class="button button-secondary" data-action="export-expenses">${icons.download} Export CSV</button></div><div class="table-scroll"><table><thead><tr><th>Date</th><th>Scope</th><th>Category</th><th>Supplier details</th><th>Voucher #</th><th>Payment</th><th class="align-right">Amount paid</th><th></th></tr></thead><tbody>${records.length ? records.map(expense => `<tr><td>${formatDate(expense.date)}</td><td><span class="dept-chip ${expense.scope === "global" ? "global" : ""}">${expense.scope === "global" ? "Global" : departmentName(expense.department)}</span></td><td><strong>${escapeHTML(expense.category)}</strong>${expense.notes ? `<br><span class="caption">${escapeHTML(expense.notes)}</span>` : ""}</td><td>${escapeHTML(expense.supplier || "—")}</td><td>${escapeHTML(expense.voucher || "—")}</td><td>${escapeHTML(expense.payment || "Cash")}</td><td class="align-right mono"><strong>${money(expense.amount)}</strong></td><td><div class="row-actions"><button class="icon-button" data-action="edit-expense" data-id="${expense.id}" title="Edit">${icons.edit}</button></div></td></tr>`).join("") : `<tr><td colspan="8" class="table-empty">No expenditure recorded for this date.</td></tr>`}</tbody></table></div></section>`;
  }

  function reportBounds() {
    const anchor = dateFromISO(ui.reportAnchor);
    if (ui.reportPeriod === "daily") return [ui.reportAnchor, ui.reportAnchor];
    if (ui.reportPeriod === "weekly") {
      const day = anchor.getDay() || 7;
      const monday = new Date(anchor); monday.setDate(anchor.getDate() - day + 1);
      return [isoFromDate(monday), addDays(isoFromDate(monday), 6)];
    }
    if (ui.reportPeriod === "monthly") return [`${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2,"0")}-01`, isoFromDate(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0))];
    if (ui.reportPeriod === "yearly") return [`${anchor.getFullYear()}-01-01`, `${anchor.getFullYear()}-12-31`];
    return [ui.customStart, ui.customEnd];
  }

  function reportData() {
    const [start, end] = reportBounds();
    const department = isCEO() ? ui.reportDepartment : currentUser.department;
    const sales = state.sales.filter(s => inRange(s.date, start, end) && (department === "all" || s.department === department));
    const expenses = state.expenses.filter(e => inRange(e.date, start, end) && (department === "all" ? true : e.department === department));
    return { start, end, department, sales, expenses };
  }

  function renderReports() {
    setQuickAction("Print report", "print-report", icons.print);
    const data = reportData();
    const revenue = sum(data.sales, s => s.total), expenditure = sum(data.expenses, e => e.amount), units = sum(data.sales, s => s.quantity);
    const dayCount = Math.max(1, Math.round((dateFromISO(data.end) - dateFromISO(data.start)) / 86400000) + 1);
    const series = dailySeriesRange(data.start, data.end, data.department === "all" ? null : data.department);
    const productTotals = {};
    data.sales.forEach(s => { productTotals[s.itemName] ||= { quantity: 0, revenue: 0 }; productTotals[s.itemName].quantity += Number(s.quantity); productTotals[s.itemName].revenue += Number(s.total); });
    const topProducts = Object.entries(productTotals).sort((a,b) => b[1].revenue - a[1].revenue).slice(0, 6);
    $("#page-content").innerHTML = `
      <div class="page-head"><div><h2>Sales and performance reports</h2><p>Daily, weekly, monthly and yearly records generated from saved transactions.</p></div><div class="page-head-actions"><button class="button button-secondary" data-action="export-report">${icons.download} Export CSV</button><button class="button button-primary" data-action="print-report">${icons.print} Print report</button></div></div>
      <section class="report-filter no-print"><div class="segmented">${["daily","weekly","monthly","yearly","custom"].map(period => `<button class="${ui.reportPeriod === period ? "active" : ""}" data-action="report-period" data-period="${period}">${period[0].toUpperCase()+period.slice(1)}</button>`).join("")}</div>${ui.reportPeriod === "custom" ? `<div class="field"><label>From</label><input id="report-start" type="date" value="${ui.customStart}"></div><div class="field"><label>To</label><input id="report-end" type="date" value="${ui.customEnd}"></div>` : `<div class="field"><label>Reference date</label><input id="report-anchor" type="date" value="${ui.reportAnchor}"></div>`}${isCEO() ? `<div class="field"><label>Department</label><select id="report-department">${departmentOptions(data.department, true)}</select></div>` : ""}</section>
      <div class="page-head"><div><p class="eyebrow">REPORTING PERIOD</p><h2>${formatDate(data.start)}${data.end !== data.start ? ` — ${formatDate(data.end)}` : ""}</h2></div><span class="dept-chip">${data.department === "all" ? "All departments" : departmentName(data.department)}</span></div>
      <section class="report-summary"><div class="report-stat"><small>Gross revenue</small><strong class="text-success">${money(revenue)}</strong></div><div class="report-stat"><small>Total expenditure</small><strong class="text-danger">${money(expenditure)}</strong></div><div class="report-stat"><small>Net result</small><strong>${money(revenue - expenditure)}</strong></div><div class="report-stat"><small>Average per day</small><strong>${money(revenue / dayCount)}</strong></div></section>
      <section class="dashboard-grid"><article class="card"><header class="card-header"><div><h3>Revenue vs expenditure</h3><p>${number(units)} units from ${data.sales.length} sale entries</p></div><div class="legend"><span><i></i>Revenue</span><span><i class="gold"></i>Expenditure</span></div></header><div class="card-body"><div class="chart-wrap">${lineChart(compressSeries(series), ["revenue","expense"])}</div></div></article><article class="card"><header class="card-header"><div><h3>Top products</h3><p>Ranked by revenue in this period</p></div></header><div class="card-body">${topProducts.length ? `<div class="list">${topProducts.map(([name, totals], index) => `<div class="list-item"><span class="list-icon">${index + 1}</span><span class="list-copy"><strong>${escapeHTML(name)}</strong><small>${number(totals.quantity)} units sold</small></span><span class="list-amount"><strong>${money(totals.revenue)}</strong><small>${revenue ? (totals.revenue/revenue*100).toFixed(1) : 0}% of revenue</small></span></div>`).join("")}</div>` : `<div class="card-empty"><div><span class="empty-icon">${icons.report}</span><strong>No sales in period</strong><p>Choose a different period or record sales first.</p></div></div>`}</div></article></section>
      <section class="card table-card"><header class="card-header"><div><h3>Sales record</h3><p>Complete item, quantity, unit price and total collected log</p></div></header><div class="table-scroll"><table><thead><tr><th>Date / time</th><th>Department</th><th>Item description</th><th>Qty</th><th>Unit price</th><th>Payment</th><th class="align-right">Total collected</th></tr></thead><tbody>${data.sales.length ? [...data.sales].sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).map(sale => `<tr><td>${formatDate(sale.date)}<br><span class="caption">${new Date(sale.createdAt).toLocaleTimeString("en-GB", {hour:"2-digit",minute:"2-digit"})}</span></td><td><span class="dept-chip">${departmentName(sale.department)}</span></td><td><strong>${escapeHTML(sale.itemName)}</strong></td><td class="mono">${number(sale.quantity)}</td><td class="mono">${money(sale.unitPrice)}</td><td>${escapeHTML(sale.payment)}</td><td class="align-right mono"><strong>${money(sale.total)}</strong></td></tr>`).join("") : `<tr><td colspan="7" class="table-empty">No sales found in the selected reporting period.</td></tr>`}</tbody></table></div></section>`;
  }

  function dailySeriesRange(start, end, department = null) {
    const days = [];
    for (let date = start, guard = 0; date <= end && guard < 370; date = addDays(date, 1), guard++) {
      days.push({ date, revenue: sum(state.sales.filter(s => s.date === date && (!department || s.department === department)), s => s.total), expense: sum(state.expenses.filter(e => e.date === date && (!department || e.department === department)), e => e.amount) });
    }
    return days;
  }

  function compressSeries(series) {
    if (series.length <= 14) return series;
    const chunks = 12, size = Math.ceil(series.length / chunks), output = [];
    for (let i = 0; i < series.length; i += size) {
      const group = series.slice(i, i + size);
      output.push({ date: group[0].date, revenue: sum(group, x => x.revenue), expense: sum(group, x => x.expense) });
    }
    return output;
  }

  function sessionTotals(session) {
    const revenue = sum(state.sales.filter(s => s.sessionId === session.id), s => s.total);
    const expense = sum(state.expenses.filter(e => e.sessionId === session.id), e => e.amount);
    const expected = Number(session.openingCash) + revenue - expense;
    return { revenue, expense, expected, variance: session.actualCash == null ? null : Number(session.actualCash) - expected };
  }

  function renderReconciliation() {
    setQuickAction("Open shift", "open-shift", icons.plus);
    const department = allowedDepartment(ui.department);
    ui.department = department;
    const open = activeSession(department);
    const totals = open ? sessionTotals(open) : null;
    const sessions = state.sessions.filter(s => isCEO() ? (ui.department ? s.department === department : true) : s.department === department).sort((a,b) => new Date(b.openedAt)-new Date(a.openedAt)).slice(0, 30);
    $("#page-content").innerHTML = `
      <div class="page-head"><div><h2>End-of-day cash reconciliation</h2><p>Uses the source sheet formula: opening cash + income − department expenditure.</p></div><div class="page-head-actions">${isCEO() ? `<select id="recon-department" class="search-input">${departmentOptions(department)}</select>` : `<span class="dept-chip">${departmentName(department)}</span>`}${!open ? `<button class="button button-primary" data-action="open-shift" data-department="${department}">${icons.plus} Open shift</button>` : ""}</div></div>
      ${open ? `<section class="recon-hero"><article class="cash-formula"><p class="eyebrow">EXPECTED CASH IN DRAWER</p><h2>${escapeHTML(open.shift)} shift · ${formatDate(open.date)}</h2><p>Cashier: ${escapeHTML(open.cashierName)}</p><div class="formula-line"><div class="formula-value"><small>Opening cash</small><strong>${money(open.openingCash)}</strong></div><span class="formula-op">+</span><div class="formula-value"><small>Income (A)</small><strong>${money(totals.revenue)}</strong></div><span class="formula-op">−</span><div class="formula-value"><small>Expenditure (B)</small><strong>${money(totals.expense)}</strong></div></div><div class="summary-row total" style="color:white;border-color:rgba(255,255,255,.16)"><span>Expected cash</span><strong style="color:#f1cf78">${money(totals.expected)}</strong></div></article><article class="card actual-card"><h3>Close and reconcile shift</h3><form id="close-shift-form"><input type="hidden" name="sessionId" value="${open.id}"><div class="field"><label>Actual cash counted <span>(physical cash)</span></label><div class="input-prefix"><span>FCFA</span><input id="actual-cash" name="actualCash" type="number" min="0" step="1" required placeholder="0"></div></div><div id="variance-preview" class="variance-result"><span>Variance / shortage</span><strong>—</strong></div><div class="form-actions" style="margin-top:15px;padding-top:15px"><button class="button button-primary" type="submit">${icons.check} Close shift</button></div></form></article></section>` : emptyState("No open shift", `Open a day or night shift for ${departmentName(department)} to establish the opening cash balance.`, "Open shift", "open-shift", icons.reconcile)}
      <section class="card table-card" style="margin-top:20px"><header class="card-header"><div><h3>Reconciliation history</h3><p>Prepared by cashier and verified by management</p></div></header><div class="table-scroll"><table><thead><tr><th>Date / shift</th><th>Cashier</th><th>Opening</th><th>Revenue</th><th>Expenses</th><th>Actual</th><th>Variance</th><th>Status</th><th></th></tr></thead><tbody>${sessions.length ? sessions.map(session => { const t = sessionTotals(session); return `<tr><td><strong>${formatDate(session.date)}</strong><br><span class="caption">${escapeHTML(session.shift)} shift</span></td><td>${escapeHTML(session.cashierName)}</td><td>${money(session.openingCash)}</td><td>${money(t.revenue)}</td><td>${money(t.expense)}</td><td>${session.actualCash == null ? "—" : money(session.actualCash)}</td><td class="${t.variance == null ? "" : t.variance < 0 ? "text-danger" : "text-success"}">${t.variance == null ? "—" : `${t.variance >= 0 ? "+" : "−"}${money(Math.abs(t.variance))}`}</td><td><span class="status-badge ${session.verifiedAt ? "success" : session.status === "open" ? "warning" : "neutral"}">${session.verifiedAt ? "Verified" : session.status === "open" ? "Open" : "Awaiting verification"}</span></td><td>${isCEO() && session.status === "closed" && !session.verifiedAt ? `<button class="button button-secondary button-small" data-action="verify-session" data-id="${session.id}">Verify</button>` : ""}</td></tr>`; }).join("") : `<tr><td colspan="9" class="table-empty">No reconciliation history yet.</td></tr>`}</tbody></table></div></section>`;
  }

  function renderTeam() {
    setQuickAction("Add user", "add-user", icons.plus);
    $("#page-content").innerHTML = `<div class="page-head"><div><h2>Team access</h2><p>Manage usernames, department access, account status and password resets.</p></div><div class="page-head-actions"><button class="button button-primary" data-action="add-user">${icons.plus} Add user</button></div></div><section class="card table-card"><div class="table-scroll"><table><thead><tr><th>Team member</th><th>Username</th><th>Access</th><th>Security</th><th>Status</th><th></th></tr></thead><tbody>${state.users.map(user => `<tr><td><strong>${escapeHTML(user.name)}</strong><br><span class="caption">Created ${formatDate(user.createdAt.slice(0,10))}</span></td><td class="mono">${escapeHTML(user.username)}</td><td><span class="dept-chip ${user.role === "ceo" ? "global" : ""}">${user.role === "ceo" ? "CEO · Full access" : departmentName(user.department)}</span></td><td><span class="status-badge ${user.mustChange ? "warning" : "success"}">${user.mustChange ? "Password change due" : "Secured"}</span></td><td><span class="status-badge ${user.active ? "success" : "danger"}">${user.active ? "Active" : "Disabled"}</span></td><td><div class="row-actions"><button class="icon-button" data-action="reset-user-password" data-id="${user.id}" title="Reset password">${icons.refresh}</button><button class="icon-button" data-action="toggle-user" data-id="${user.id}" title="${user.active ? "Disable" : "Enable"}" ${user.id === currentUser.id ? "disabled" : ""}>${user.active ? icons.trash : icons.check}</button></div></td></tr>`).join("")}</tbody></table></div></section>`;
  }

  function renderSettings() {
    setQuickAction("Export backup", "export-backup", icons.download);
    const bytes = new Blob([JSON.stringify(state)]).size;
    const liveSupported = "showSaveFilePicker" in window;
    const databaseConnected = serverConnected || liveFileHandle;
    $("#page-content").innerHTML = `<div class="page-head"><div><h2>JSON auto-save and settings</h2><p>Every department input is saved immediately. The local launcher maintains the on-disk JSON database.</p></div></div><section class="settings-grid"><article class="settings-card"><h3>Live JSON database file</h3><p>${serverConnected ? "Connected through the offline launcher. Every change is atomically written to data/bris-cuisine-data.json, with a rolling disk backup." : liveFileHandle ? "Connected. Every sale, expense, stock update and shift change is automatically written to the selected JSON file." : "Open the system with “Start BRI System.bat”, or choose a JSON file directly in Chrome or Edge."}</p>${serverConnected ? '<span class="status-badge success">Local JSON server connected</span>' : `<button class="button ${liveFileHandle ? "button-secondary" : "button-primary"}" data-action="connect-json">${liveFileHandle ? icons.check + " Reconnect / change file" : icons.upload + " Connect live JSON file"}</button>`}<div class="data-meter"><span>Live file status</span><strong class="${databaseConnected ? "text-success" : liveSupported ? "text-warning" : "text-danger"}">${serverConnected ? "Atomic auto-write active" : liveFileHandle ? "Connected · auto-writing" : liveSupported ? "Not connected" : "Use local launcher"}</strong></div></article><article class="settings-card"><h3>Export complete backup</h3><p>Download all users, products, sales, expenses, shifts and settings as one portable JSON file.</p><button class="button button-primary" data-action="export-backup">${icons.download} Download JSON backup</button><div class="data-meter"><span>Current JSON data size</span><strong>${bytes < 1024 ? bytes + " bytes" : (bytes/1024).toFixed(1) + " KB"}</strong></div></article><article class="settings-card"><h3>Restore from JSON backup</h3><p>Replace the current browser copy with a previously exported BRI'S CUISINE JSON backup.</p><input id="restore-file" class="file-input" type="file" accept="application/json,.json"><button class="button button-secondary" data-action="choose-backup">${icons.upload} Choose backup file</button><div class="data-meter"><span>Instant recovery copy</span><strong>JSON in browser storage</strong></div></article><article class="settings-card"><h3>Business identity</h3><p>Update the name used in this management system and exported reports.</p><form id="business-settings-form"><div class="field"><label>Business name</label><input name="businessName" required value="${escapeHTML(state.settings.businessName)}"></div><div class="form-actions" style="margin-top:14px;padding-top:14px"><button class="button button-secondary" type="submit">Save identity</button></div></form></article><article class="settings-card"><h3>Power-failure recovery</h3><p>On every action, the browser JSON is committed immediately and the disk JSON uses a temporary file plus atomic replacement. There is no Save button to forget.</p><span class="status-badge ${lastSaveError ? "danger" : "success"}">${lastSaveError ? "Save needs attention" : "Automatic recovery active"}</span><div class="data-meter"><span>Save frequency</span><strong>After every change</strong></div></article><article class="settings-card"><h3>Offline operation</h3><p>This app contains no external libraries and keeps working without an internet connection. No cloud account or remote database is used.</p><span class="status-badge success">Offline ready</span><div class="data-meter"><span>Cloud dependency</span><strong>None</strong></div></article></section>`;
  }

  function openModal(title, subtitle, body, wide = false) {
    $("#modal-root").innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title" data-modal-panel><header class="modal-header"><div><h2 id="modal-title">${title}</h2><p>${subtitle}</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close">${icons.close}</button></header><div class="modal-body">${body}</div></section></div>`;
    const first = $("#modal-root input:not([type=hidden]), #modal-root select, #modal-root button");
    setTimeout(() => first?.focus(), 40);
  }

  function closeModal() { $("#modal-root").innerHTML = ""; }

  function openStockModal(item = null) {
    const department = item?.department || allowedDepartment(ui.department);
    openModal(item ? "Edit product" : "Register product and stock", "Products and prices are created here—nothing is hard-coded.", `<form id="stock-form"><input type="hidden" name="id" value="${item?.id || ""}"><div class="form-grid">${isCEO() ? `<div class="field"><label>Department</label><select name="department" required>${departmentOptions(department)}</select></div>` : `<input type="hidden" name="department" value="${department}">`}<div class="field"><label>Product / item name</label><input name="name" required maxlength="80" value="${escapeHTML(item?.name || "")}" placeholder="e.g. Grilled chicken"></div><div class="field"><label>Category</label><input name="category" required list="category-options" maxlength="60" value="${escapeHTML(item?.category || "")}" placeholder="e.g. Main dishes"><datalist id="category-options"><option>Meals</option><option>Pastries</option><option>Snacks</option><option>Ice cream</option><option>Beer</option><option>Wine</option><option>Whisky</option><option>Juice</option></datalist></div><div class="field"><label>Unit</label><select name="unit"><option ${item?.unit === "portion" ? "selected" : ""}>portion</option><option ${item?.unit === "piece" ? "selected" : ""}>piece</option><option ${item?.unit === "bottle" ? "selected" : ""}>bottle</option><option ${item?.unit === "can" ? "selected" : ""}>can</option><option ${item?.unit === "cup" ? "selected" : ""}>cup</option><option ${item?.unit === "pack" ? "selected" : ""}>pack</option></select></div><div class="field"><label>Cost price <span>(per unit)</span></label><div class="input-prefix"><span>FCFA</span><input name="costPrice" type="number" min="0" step="1" value="${item?.costPrice ?? ""}" required placeholder="0"></div></div><div class="field"><label>Selling price <span>(per unit)</span></label><div class="input-prefix"><span>FCFA</span><input name="sellingPrice" type="number" min="0" step="1" value="${item?.sellingPrice ?? ""}" required placeholder="0"></div></div><div class="field"><label>${item ? "Current quantity" : "Opening stock quantity"}</label><input name="quantity" type="number" min="0" step="0.01" value="${item?.quantity ?? ""}" required placeholder="0" ${item ? "readonly" : ""}></div><div class="field"><label>Low-stock alert at</label><input name="lowStock" type="number" min="0" step="0.01" value="${item?.lowStock ?? 5}" required></div></div><div class="form-actions"><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">${item ? "Save changes" : "Register product"}</button></div></form>`, true);
  }

  function openRestockModal(item) {
    openModal("Restock product", `${escapeHTML(item.name)} · currently ${number(item.quantity)} ${escapeHTML(item.unit)}`, `<form id="restock-form"><input type="hidden" name="id" value="${item.id}"><div class="form-grid"><div class="field"><label>Quantity to add</label><input name="quantity" type="number" min="0.01" step="0.01" required placeholder="0"></div><div class="field"><label>Updated cost price <span>(optional)</span></label><div class="input-prefix"><span>FCFA</span><input name="costPrice" type="number" min="0" step="1" placeholder="${item.costPrice}"></div></div><div class="field span-2"><label>Supplier / note <span>(optional)</span></label><input name="note" maxlength="100" placeholder="Delivery reference or supplier"></div></div><div class="form-actions"><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Add stock</button></div></form>`);
  }

  function openExpenseModal(expense = null) {
    const department = expense?.department || allowedDepartment(ui.department);
    openModal(expense ? "Edit expenditure" : "Record expenditure", "Supplier, voucher and amount fields follow the daily tracking sheet.", `<form id="expense-form"><input type="hidden" name="id" value="${expense?.id || ""}"><div class="form-grid">${isCEO() ? `<div class="field"><label>Expense scope</label><select name="scope" id="expense-scope"><option value="department" ${expense?.scope !== "global" ? "selected" : ""}>Department expense</option><option value="global" ${expense?.scope === "global" ? "selected" : ""}>Global business expense</option></select></div><div class="field"><label>Department</label><select name="department" id="expense-form-department">${departmentOptions(department)}</select><p class="field-help">Used for department expenses only.</p></div>` : `<input type="hidden" name="scope" value="department"><input type="hidden" name="department" value="${department}">`}<div class="field"><label>Date</label><input name="date" type="date" required value="${expense?.date || ui.expenseDate || todayISO()}"></div><div class="field"><label>Expense category</label><select name="category">${EXPENSE_CATEGORIES.map(category => `<option ${expense?.category === category ? "selected" : ""}>${category}</option>`).join("")}</select></div><div class="field"><label>Supplier details</label><input name="supplier" maxlength="100" value="${escapeHTML(expense?.supplier || "")}" placeholder="Supplier or payee"></div><div class="field"><label>Voucher #</label><input name="voucher" maxlength="50" value="${escapeHTML(expense?.voucher || "")}" placeholder="Receipt / voucher reference"></div><div class="field"><label>Amount paid</label><div class="input-prefix"><span>FCFA</span><input name="amount" type="number" min="0" step="1" required value="${expense?.amount ?? ""}" placeholder="0"></div></div><div class="field"><label>Payment method</label><select name="payment">${PAYMENT_METHODS.map(method => `<option ${expense?.payment === method ? "selected" : ""}>${method}</option>`).join("")}</select></div><div class="field span-2"><label>Notes <span>(optional)</span></label><textarea name="notes" maxlength="300" placeholder="Additional explanation">${escapeHTML(expense?.notes || "")}</textarea></div></div><div class="form-actions"><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">${expense ? "Save changes" : "Record expenditure"}</button></div></form>`, true);
  }

  function openShiftModal(department) {
    department = allowedDepartment(department);
    openModal("Open a shift", "Set the daily opening cash balance before recording sales.", `<form id="open-shift-form"><div class="form-grid">${isCEO() ? `<div class="field"><label>Department</label><select name="department">${departmentOptions(department)}</select></div>` : `<input type="hidden" name="department" value="${department}">`}<div class="field"><label>Date</label><input name="date" type="date" value="${todayISO()}" max="${todayISO()}" required></div><div class="field"><label>Shift</label><select name="shift"><option>Day</option><option>Night</option></select></div><div class="field"><label>Cashier</label><input name="cashierName" required value="${escapeHTML(currentUser.name)}" maxlength="80"></div><div class="field span-2"><label>Opening cash balance</label><div class="input-prefix"><span>FCFA</span><input name="openingCash" type="number" min="0" step="1" required placeholder="0"></div></div></div><div class="form-actions"><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Open shift</button></div></form>`);
  }

  function openAccountModal() {
    openModal("My account", `${escapeHTML(currentUser.username)} · ${isCEO() ? "CEO" : departmentName(currentUser.department)}`, `<form id="account-form"><div class="form-grid"><div class="field span-2"><label>Display name</label><input name="name" required maxlength="80" value="${escapeHTML(currentUser.name)}"></div><div class="field span-2"><label>Current password</label><input name="currentPassword" type="password" required autocomplete="current-password"></div><div class="field"><label>New password</label><input name="newPassword" type="password" required minlength="8" autocomplete="new-password"></div><div class="field"><label>Confirm new password</label><input name="confirmPassword" type="password" required minlength="8" autocomplete="new-password"></div></div><p class="field-help" style="margin-top:12px">Use at least 8 characters. A mix of letters, numbers and symbols is recommended.</p><div class="form-actions"><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Update account</button></div></form>`);
  }

  function openAddUserModal() {
    openModal("Add team user", "Create a separate protected login for a department or management.", `<form id="add-user-form"><div class="form-grid"><div class="field span-2"><label>Full name</label><input name="name" required maxlength="80"></div><div class="field"><label>Username</label><input name="username" required maxlength="30" pattern="[A-Za-z0-9._-]+"></div><div class="field"><label>Starter password</label><input name="password" type="password" required minlength="8"></div><div class="field"><label>Access level</label><select name="role" id="new-user-role"><option value="department">Department</option><option value="ceo">CEO · Full access</option></select></div><div class="field"><label>Department</label><select name="department" id="new-user-department">${departmentOptions("food")}</select></div></div><div class="form-actions"><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Create user</button></div></form>`);
  }

  function openPasswordResetModal(user) {
    openModal("Reset password", `Set a temporary password for ${escapeHTML(user.name)}.`, `<form id="reset-password-form"><input type="hidden" name="id" value="${user.id}"><div class="field"><label>New temporary password</label><input name="password" type="password" required minlength="8" autocomplete="new-password"></div><p class="field-help" style="margin-top:10px">The user will be reminded to change it after signing in.</p><div class="form-actions"><button class="button button-secondary" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Reset password</button></div></form>`);
  }

  function toast(title, message = "", type = "success") {
    const id = uid("toast");
    $("#toast-region").insertAdjacentHTML("beforeend", `<div id="${id}" class="toast ${type === "error" ? "error" : ""}"><span class="toast-icon">${type === "error" ? icons.close : icons.check}</span><span><strong>${escapeHTML(title)}</strong><small>${escapeHTML(message)}</small></span><button data-action="dismiss-toast" data-id="${id}" aria-label="Dismiss">×</button></div>`);
    setTimeout(() => document.getElementById(id)?.remove(), 4500);
  }

  function completeSale() {
    const department = allowedDepartment(ui.department);
    const shift = activeSession(department);
    if (!shift) return toast("Open a shift first", "A sale cannot be completed without an open shift.", "error");
    if (!ui.cart.length) return;
    for (const line of ui.cart) {
      const item = state.inventory.find(i => i.id === line.itemId);
      if (!item || Number(item.quantity) < line.quantity) return toast("Stock changed", `${line.name} no longer has enough recorded stock.`, "error");
    }
    const payment = $("#sale-payment")?.value || "Cash";
    const now = new Date().toISOString();
    let total = 0;
    ui.cart.forEach(line => {
      const item = state.inventory.find(i => i.id === line.itemId);
      const rowTotal = Number(line.quantity) * Number(line.unitPrice);
      total += rowTotal;
      state.sales.push({ id: uid("sale"), department, itemId: item.id, itemName: item.name, quantity: line.quantity, unitPrice: line.unitPrice, total: rowTotal, payment, date: shift.date, createdAt: now, userId: currentUser.id, userName: currentUser.name, sessionId: shift.id });
      item.quantity = Number(item.quantity) - line.quantity;
      item.updatedAt = now;
      state.stockMovements.push({ id: uid("mov"), itemId: item.id, department, type: "sale", quantity: -line.quantity, note: `Sale · ${payment}`, at: now, userId: currentUser.id });
    });
    activity("Sale recorded", `${ui.cart.length} product lines · ${money(total)}`, department);
    saveState();
    ui.cart = [];
    toast("Sale completed", `${money(total)} recorded and stock updated.`);
    renderPOS();
  }

  function exportCSV(filename, rows) {
    if (!rows.length) return toast("Nothing to export", "No records are available in the current view.", "error");
    const csv = rows.map(row => row.map(value => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    downloadFile(filename, `\uFEFF${csv}`, "text/csv;charset=utf-8");
  }

  function downloadFile(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportInventory() {
    const dept = isCEO() ? ui.inventoryDept : currentUser.department;
    const rows = [["Product", "Department", "Category", "Unit", "Quantity", "Low Stock", "Cost Price FCFA", "Selling Price FCFA"]];
    state.inventory.filter(i => dept === "all" || i.department === dept).forEach(i => rows.push([i.name, departmentName(i.department), i.category, i.unit, i.quantity, i.lowStock, i.costPrice, i.sellingPrice]));
    exportCSV(`bris-cuisine-stock-${todayISO()}.csv`, rows);
  }

  function exportExpenses() {
    const dept = isCEO() ? ui.expenseDept : currentUser.department;
    const rows = [["Date", "Scope", "Department", "Category", "Supplier", "Voucher", "Payment", "Amount FCFA", "Notes"]];
    state.expenses.filter(e => e.date === ui.expenseDate && (dept === "all" || e.department === dept)).forEach(e => rows.push([e.date, e.scope, departmentName(e.department), e.category, e.supplier, e.voucher, e.payment, e.amount, e.notes]));
    exportCSV(`bris-cuisine-expenses-${ui.expenseDate}.csv`, rows);
  }

  function exportReport() {
    const data = reportData();
    const rows = [["Date", "Department", "Item", "Quantity", "Unit Price FCFA", "Payment", "Total FCFA", "Cashier"]];
    data.sales.forEach(s => rows.push([s.date, departmentName(s.department), s.itemName, s.quantity, s.unitPrice, s.payment, s.total, s.userName]));
    exportCSV(`bris-cuisine-sales-${data.start}-to-${data.end}.csv`, rows);
  }

  function handleClick(event) {
    const route = event.target.closest("[data-route]")?.dataset.route;
    if (route) return navigate(route);
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    const action = trigger.dataset.action;
    const id = trigger.dataset.id;
    if (action === "close-modal" && event.target.closest("[data-modal-panel]") && !event.target.closest(".modal-close, [type=button]")) return;
    const actions = {
      "go-sale": () => navigate("pos"),
      "open-stock": () => openStockModal(),
      "edit-stock": () => openStockModal(state.inventory.find(item => item.id === id)),
      restock: () => openRestockModal(state.inventory.find(item => item.id === id)),
      "open-expense": () => openExpenseModal(),
      "edit-expense": () => openExpenseModal(state.expenses.find(item => item.id === id)),
      "open-shift": () => openShiftModal(trigger.dataset.department || ui.department),
      "open-account": openAccountModal,
      "close-modal": closeModal,
      "cart-add": () => cartAdd(id), "cart-minus": () => cartChange(id, -1), "cart-plus": () => cartChange(id, 1),
      "cart-clear": () => { ui.cart = []; renderPOS(); }, "complete-sale": completeSale,
      "report-period": () => { ui.reportPeriod = trigger.dataset.period; renderReports(); },
      "print-report": () => window.print(), "export-report": exportReport, "export-inventory": exportInventory, "export-expenses": exportExpenses,
      "verify-session": () => verifySession(id), "add-user": openAddUserModal,
      "reset-user-password": () => openPasswordResetModal(state.users.find(user => user.id === id)),
      "toggle-user": () => toggleUser(id), "export-backup": exportBackup,
      "connect-json": connectLiveJSONFile,
      "choose-backup": () => $("#restore-file")?.click(),
      "dismiss-toast": () => document.getElementById(id)?.remove()
    };
    actions[action]?.();
  }

  function cartAdd(id) {
    const item = state.inventory.find(i => i.id === id);
    if (!item || Number(item.quantity) <= 0) return;
    const line = ui.cart.find(line => line.itemId === id);
    if (line) {
      if (line.quantity >= Number(item.quantity)) return toast("Stock limit reached", `Only ${number(item.quantity)} ${item.unit} available.`, "error");
      line.quantity++;
    } else ui.cart.push({ itemId: id, name: item.name, quantity: 1, unitPrice: Number(item.sellingPrice) });
    renderPOS();
  }

  function cartChange(id, change) {
    const line = ui.cart.find(line => line.itemId === id);
    const item = state.inventory.find(i => i.id === id);
    if (!line || !item) return;
    line.quantity += change;
    if (line.quantity <= 0) ui.cart = ui.cart.filter(line => line.itemId !== id);
    else if (line.quantity > Number(item.quantity)) { line.quantity = Number(item.quantity); toast("Stock limit reached", `Only ${number(item.quantity)} available.`, "error"); }
    renderPOS();
  }

  function verifySession(id) {
    const session = state.sessions.find(s => s.id === id);
    if (!session || !isCEO()) return;
    session.verifiedAt = new Date().toISOString(); session.verifiedBy = currentUser.name;
    activity("Shift verified", `${departmentName(session.department)} · ${session.shift} · ${session.date}`, session.department);
    saveState(); toast("Shift verified", "Management verification has been recorded."); renderReconciliation();
  }

  function toggleUser(id) {
    const user = state.users.find(u => u.id === id);
    if (!user || user.id === currentUser.id) return;
    user.active = !user.active; activity(user.active ? "User enabled" : "User disabled", user.name); saveState(); renderTeam();
  }

  function exportBackup() {
    activity("Backup exported", "Complete offline data backup"); saveState();
    downloadFile(`bris-cuisine-backup-${todayISO()}.json`, JSON.stringify({ app: "BRIS_CUISINE", exportedAt: new Date().toISOString(), data: state }, null, 2), "application/json");
    toast("Backup downloaded", "Keep the JSON file in a safe location.");
  }

  function handleSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const formId = form.getAttribute("id");
    const data = Object.fromEntries(new FormData(form).entries());
    if (formId === "login-form") return login(data);
    if (formId === "stock-form") return saveStock(data);
    if (formId === "restock-form") return saveRestock(data);
    if (formId === "expense-form") return saveExpense(data);
    if (formId === "open-shift-form") return saveOpenShift(data);
    if (formId === "close-shift-form") return saveCloseShift(data);
    if (formId === "account-form") return saveAccount(data);
    if (formId === "add-user-form") return saveUser(data);
    if (formId === "reset-password-form") return resetPassword(data);
    if (formId === "business-settings-form") return saveBusinessSettings(data);
  }

  function login(data) {
    const user = state.users.find(u => u.username.toLowerCase() === String(data.username).trim().toLowerCase());
    const error = $("#login-error");
    if (!user || user.passwordHash !== hashPassword(data.password) || !user.active) {
      error.textContent = "The username or password is incorrect, or this account is disabled."; error.hidden = false; return;
    }
    setSession(user); activity("Signed in", `${user.username} accessed the system`, user.department); saveState(); showApp();
  }

  function saveStock(data) {
    const existing = data.id ? state.inventory.find(item => item.id === data.id) : null;
    const department = isCEO() ? data.department : currentUser.department;
    const duplicate = state.inventory.find(item => item.id !== data.id && item.department === department && item.name.toLowerCase() === data.name.trim().toLowerCase());
    if (duplicate) return toast("Product already exists", "Use Edit or Restock on the existing product.", "error");
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, { department, name: data.name.trim(), category: data.category.trim(), unit: data.unit, costPrice: Number(data.costPrice), sellingPrice: Number(data.sellingPrice), lowStock: Number(data.lowStock), updatedAt: now });
      activity("Product updated", existing.name, department);
    } else {
      const item = { id: uid("item"), department, name: data.name.trim(), category: data.category.trim(), unit: data.unit, costPrice: Number(data.costPrice), sellingPrice: Number(data.sellingPrice), quantity: Number(data.quantity), lowStock: Number(data.lowStock), active: true, createdAt: now, updatedAt: now };
      state.inventory.push(item); state.stockMovements.push({ id: uid("mov"), itemId: item.id, department, type: "opening", quantity: item.quantity, note: "Opening stock", at: now, userId: currentUser.id });
      activity("Product registered", `${item.name} · ${number(item.quantity)} ${item.unit}`, department);
    }
    saveState(); closeModal(); toast(existing ? "Product updated" : "Product registered", "Stock and pricing were saved successfully."); renderRoute();
  }

  function saveRestock(data) {
    const item = state.inventory.find(i => i.id === data.id); if (!item) return;
    const quantity = Number(data.quantity); item.quantity = Number(item.quantity) + quantity;
    if (data.costPrice !== "") item.costPrice = Number(data.costPrice);
    item.updatedAt = new Date().toISOString();
    state.stockMovements.push({ id: uid("mov"), itemId: item.id, department: item.department, type: "restock", quantity, note: data.note || "Stock added", at: item.updatedAt, userId: currentUser.id });
    activity("Stock received", `${item.name} · +${number(quantity)} ${item.unit}`, item.department); saveState(); closeModal(); toast("Stock updated", `${item.name} now has ${number(item.quantity)} ${item.unit}.`); renderInventory();
  }

  function saveExpense(data) {
    const existing = data.id ? state.expenses.find(e => e.id === data.id) : null;
    const scope = isCEO() ? data.scope : "department";
    const department = isCEO() ? data.department : currentUser.department;
    const shift = scope === "department" ? activeSession(department) : null;
    const row = { scope, department, date: data.date, category: data.category, supplier: data.supplier.trim(), voucher: data.voucher.trim(), amount: Number(data.amount), payment: data.payment, notes: data.notes.trim(), updatedAt: new Date().toISOString() };
    if (existing) { Object.assign(existing, row); activity("Expense updated", `${row.category} · ${money(row.amount)}`, department); }
    else { Object.assign(row, { id: uid("exp"), createdAt: new Date().toISOString(), userId: currentUser.id, userName: currentUser.name, sessionId: shift && shift.date === data.date ? shift.id : null }); state.expenses.push(row); activity(scope === "global" ? "Global expense recorded" : "Department expense recorded", `${row.category} · ${money(row.amount)}`, department); }
    saveState(); closeModal(); toast(existing ? "Expense updated" : "Expenditure recorded", `${money(row.amount)} saved to the ${scope} log.`); renderRoute();
  }

  function saveOpenShift(data) {
    const department = isCEO() ? data.department : currentUser.department;
    if (activeSession(department)) return toast("Shift already open", `Close the current ${departmentName(department)} shift first.`, "error");
    const duplicate = state.sessions.find(s => s.department === department && s.date === data.date && s.shift === data.shift && s.status !== "cancelled");
    if (duplicate) return toast("Shift already recorded", "This department, date and shift already exist.", "error");
    const session = { id: uid("shift"), department, date: data.date, shift: data.shift, openingCash: Number(data.openingCash), cashierName: data.cashierName.trim(), openedAt: new Date().toISOString(), openedBy: currentUser.name, status: "open", actualCash: null, closedAt: null, verifiedAt: null };
    state.sessions.push(session); ui.department = department; activity("Shift opened", `${departmentName(department)} · ${data.shift} · opening ${money(data.openingCash)}`, department); saveState(); closeModal(); toast("Shift opened", `${departmentName(department)} is ready to record sales.`); renderRoute();
  }

  function saveCloseShift(data) {
    const session = state.sessions.find(s => s.id === data.sessionId && s.status === "open"); if (!session) return;
    const totals = sessionTotals(session);
    session.actualCash = Number(data.actualCash); session.expectedCash = totals.expected; session.variance = session.actualCash - totals.expected; session.status = "closed"; session.closedAt = new Date().toISOString(); session.preparedBy = currentUser.name;
    activity("Shift closed", `${departmentName(session.department)} · variance ${money(session.variance)}`, session.department); saveState(); toast("Shift reconciled", `Variance recorded: ${session.variance >= 0 ? "+" : "−"}${money(Math.abs(session.variance))}.`); renderReconciliation();
  }

  function saveAccount(data) {
    if (currentUser.passwordHash !== hashPassword(data.currentPassword)) return toast("Current password is incorrect", "Your account was not changed.", "error");
    if (data.newPassword !== data.confirmPassword) return toast("Passwords do not match", "Re-enter the new password in both fields.", "error");
    currentUser.name = data.name.trim(); currentUser.passwordHash = hashPassword(data.newPassword); currentUser.mustChange = false;
    activity("Account secured", `${currentUser.username} changed account details`, currentUser.department); saveState(); closeModal(); updateUserUI(); toast("Account updated", "Your new password is active."); renderRoute();
  }

  function saveUser(data) {
    if (state.users.some(u => u.username.toLowerCase() === data.username.trim().toLowerCase())) return toast("Username already exists", "Choose a different username.", "error");
    const user = { id: uid("usr"), name: data.name.trim(), username: data.username.trim(), passwordHash: hashPassword(data.password), role: data.role, department: data.role === "ceo" ? null : data.department, active: true, mustChange: true, createdAt: new Date().toISOString() };
    state.users.push(user); activity("User created", `${user.name} · ${user.role === "ceo" ? "CEO" : departmentName(user.department)}`); saveState(); closeModal(); toast("User created", `${user.username} can now sign in.`); renderTeam();
  }

  function resetPassword(data) {
    const user = state.users.find(u => u.id === data.id); if (!user) return;
    user.passwordHash = hashPassword(data.password); user.mustChange = true; activity("Password reset", user.name); saveState(); closeModal(); toast("Password reset", "The temporary password is ready to use."); renderTeam();
  }

  function saveBusinessSettings(data) {
    state.settings.businessName = data.businessName.trim(); activity("Business settings updated", state.settings.businessName); saveState(); toast("Settings saved", "Business identity was updated.");
  }

  function handleChange(event) {
    const target = event.target;
    if (target.id === "pos-department") { ui.department = target.value; ui.cart = []; return renderPOS(); }
    if (target.id === "inventory-department") { ui.inventoryDept = target.value; return renderInventory(); }
    if (target.id === "expense-department") { ui.expenseDept = target.value; return renderExpenses(); }
    if (target.id === "expense-date-filter") { ui.expenseDate = target.value; return renderExpenses(); }
    if (target.id === "report-anchor") { ui.reportAnchor = target.value; return renderReports(); }
    if (target.id === "report-start") { ui.customStart = target.value; return renderReports(); }
    if (target.id === "report-end") { ui.customEnd = target.value; return renderReports(); }
    if (target.id === "report-department") { ui.reportDepartment = target.value; return renderReports(); }
    if (target.id === "recon-department") { ui.department = target.value; return renderReconciliation(); }
    if (target.id === "new-user-role") { $("#new-user-department").disabled = target.value === "ceo"; }
    if (target.id === "expense-scope") { $("#expense-form-department").disabled = target.value === "global"; }
    if (target.id === "restore-file") return restoreBackup(target.files[0]);
  }

  function handleInput(event) {
    if (event.target.id === "product-search") { ui.productSearch = event.target.value; return renderPOS(); }
    if (event.target.id === "inventory-search") { ui.inventorySearch = event.target.value; return renderInventory(); }
    if (event.target.id === "actual-cash") {
      const session = activeSession(allowedDepartment(ui.department));
      if (!session) return;
      const variance = Number(event.target.value || 0) - sessionTotals(session).expected;
      const output = $("#variance-preview strong");
      output.textContent = `${variance >= 0 ? "+" : "−"}${money(Math.abs(variance))}`;
      output.className = variance < 0 ? "text-danger" : "text-success";
    }
  }

  async function restoreBackup(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const data = parsed.data || parsed;
      if (!Array.isArray(data.users) || !Array.isArray(data.sales) || !Array.isArray(data.inventory)) throw new Error("Invalid backup");
      openModal("Confirm restore", "This replaces the current records stored in this browser.", `<div class="confirm-copy">The backup contains <strong>${data.sales.length} sales</strong>, <strong>${data.inventory.length} products</strong>, and <strong>${data.expenses?.length || 0} expenses</strong>.<br><br>Export the current data first if you may need it later.</div><div class="form-actions"><button class="button button-secondary" data-action="close-modal">Cancel</button><button class="button button-danger" id="confirm-restore">Replace current data</button></div>`);
      $("#confirm-restore").addEventListener("click", () => {
        state = { ...defaultState(), ...data }; saveState(); clearSession(); closeModal(); toast("Backup restored", "Sign in using an account from the restored backup."); showLogin();
      }, { once: true });
    } catch { toast("Backup could not be restored", "Choose a valid BRI'S CUISINE JSON backup.", "error"); }
    finally { if ($("#restore-file")) $("#restore-file").value = ""; }
  }

  function touchSession() {
    if (!currentUser) return;
    try { const session = JSON.parse(sessionStorage.getItem(SESSION_KEY)); if (session) { session.lastActive = Date.now(); sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } } catch { /* no-op */ }
  }

  async function init() {
    $$("[data-toggle-password]").forEach(button => {
      button.innerHTML = icons.eye;
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.togglePassword);
        input.type = input.type === "password" ? "text" : "password";
        button.innerHTML = input.type === "password" ? icons.eye : icons.eyeOff;
      });
    });
    $("#menu-button").innerHTML = icons.menu;
    $("#menu-button").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#sidebar-scrim").hidden = false; });
    $("#sidebar-scrim").addEventListener("click", closeSidebar);
    $("#logout-button").addEventListener("click", () => { activity("Signed out", currentUser.username, currentUser.department); saveState(); clearSession(); showLogin(); });
    $("#account-button").addEventListener("click", openAccountModal);
    document.addEventListener("click", handleClick);
    document.addEventListener("submit", handleSubmit);
    document.addEventListener("change", handleChange);
    document.addEventListener("input", handleInput);
    let touchTimer = 0;
    ["click", "keydown", "mousemove", "touchstart"].forEach(type => document.addEventListener(type, () => { if (Date.now() - touchTimer > 30000) { touchTimer = Date.now(); touchSession(); } }, { passive: true }));
    setInterval(() => {
      if (!currentUser) return;
      try { const session = JSON.parse(sessionStorage.getItem(SESSION_KEY)); if (!session || Date.now() - session.lastActive > LOCK_AFTER) { clearSession(); closeModal(); showLogin(); toast("Session locked", "Sign in again to continue."); } } catch { clearSession(); showLogin(); }
    }, 60000);
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    window.addEventListener("beforeunload", () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* already surfaced in the app */ }
    });
    await loadServerJSON();
    restoreLiveFileConnection();
    restoreSession() ? showApp() : showLogin();
  }

  init();
})();
