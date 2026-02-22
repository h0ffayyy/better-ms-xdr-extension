(function () {
  "use strict";

  const SELECTORS = {
    table: 'div.ms-DetailsList[data-automationid="DetailsList"]',
    listSurface: ".ms-List-surface",
    listPage: ".ms-List-page",
    listCell: '.ms-List-cell[data-automationid="ListCell"]',
    dataRow: 'div[data-automationid="DetailsRow"]',
  };

  function headerSel(key) { return `div[data-item-key="${key}"]`; }
  function cellSel(key) { return `div[data-automationid="DetailsRowCell"][data-automation-key="${key}"]`; }

  let activeSortColumn = null; // null | "id" | "name" | "topRisk" | "severity" | "status" | "firstEventTime" | "lastEventTime" | "lastUpdateTime"
  let activeSortDir = "none"; // "none" | "asc" | "desc"
  let sortIndicators = { id: null, name: null, topRisk: null, severity: null, status: null, firstEventTime: null, lastEventTime: null, lastUpdateTime: null };
  let observer = null;
  let headerObserver = null;
  let scrollHandler = null; // { target, handler }
  let initIntervalId = null;
  let sortInProgress = false;
  let extensionEnabled = true;
  let headerHidden = true;
  let compactMode = false;
  let dimResolved = true;
  let currentTheme = "light";
  let bridgeNonce = null;
  let scrollTopBtn = null;

  // ── Storage ────────────────────────────────────────────

  const SCROLL_TOP_THRESHOLD = 300;

  const storageApi =
    typeof browser !== "undefined" && browser.storage
      ? browser.storage.local
      : chrome.storage.local;

  function getSetting(key, defaultVal) {
    return storageApi.get(key).then((r) => r[key] ?? defaultVal).catch(() => defaultVal);
  }

  function setSetting(key, value) {
    storageApi.set({ [key]: value }).catch(() => {});
  }

  function getCurrentTheme() {
    // Prefer the attribute stamped by the bridge (sourced from localStorage).
    const xdr = document.documentElement.getAttribute("data-xdr-theme");
    if (xdr === "dark") return "dark";
    if (xdr === "light") return "light";
    // Fallback to the site's own attribute.
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark-mode") return "dark";
    if (attr === "light-mode") return "light";
    return "light";
  }

  function syncThemeToStorage() {
    currentTheme = getCurrentTheme();
    storageApi.set({ xdrCurrentTheme: currentTheme }).catch(() => {});
  }

  // Watch <html data-theme> for changes so we pick up the real value
  // once the XDR site sets it (may happen after our script runs).
  new MutationObserver(() => {
    const detected = getCurrentTheme();
    if (detected === currentTheme) return;
    currentTheme = detected;
    storageApi.set({ xdrCurrentTheme: currentTheme }).catch(() => {});
    const banner = document.querySelector(".xdr-sorter-banner");
    if (banner) {
      const cb = banner.querySelector('[data-setting="xdrTheme"]');
      if (cb) cb.checked = currentTheme === "dark";
      const icon = banner.querySelector(".xdr-banner-theme-icon");
      if (icon) icon.textContent = currentTheme === "dark" ? "\u263E" : "\u2600";
    }
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-xdr-theme"],
  });

  function injectThemeBridge() {
    if (document.querySelector("#xdr-theme-bridge")) return;
    const runtimeApi =
      typeof browser !== "undefined" && browser.runtime
        ? browser.runtime
        : chrome.runtime;
    bridgeNonce = crypto.randomUUID();
    document.documentElement.setAttribute("data-xdr-bridge-nonce", bridgeNonce);
    const script = document.createElement("script");
    script.id = "xdr-theme-bridge";
    script.src = runtimeApi.getURL("theme-bridge.js");
    document.documentElement.appendChild(script);
    script.addEventListener("load", () => script.remove());
  }

  function togglePageTheme() {
    window.postMessage({ type: "xdr-toggle-theme", nonce: bridgeNonce }, location.origin);
  }

  // ── Storage Change Listener ────────────────────────────
  // Reacts to changes made by the popup so the banner and page stay in sync.

  const onChangedApi =
    typeof browser !== "undefined" && browser.storage
      ? browser.storage.onChanged
      : chrome.storage.onChanged;

  function syncBannerCheckbox(setting, checked) {
    const cb = document.querySelector(`.xdr-sorter-banner [data-setting="${setting}"]`);
    if (cb) cb.checked = checked;
  }

  onChangedApi.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if ("xdrEnabled" in changes) {
      const newVal = changes.xdrEnabled.newValue !== false;
      if (newVal === extensionEnabled) return; // echo from banner write — skip
      extensionEnabled = newVal;
      if (extensionEnabled) {
        // Re-apply features with stored settings
        applyHeaderVisibility();
        applyCompactMode();
        applyResolvedDimming();
        injectSortButton();
        startObserver();
        startScrollWatcher();
        createScrollTopButton();
      } else {
        // Revert visual changes but keep settings in storage
        teardown();
        applyHeaderVisibility();
        applyCompactMode();
      }
      injectBanner();
      return;
    }

    if ("xdrHeaderHidden" in changes) {
      const newVal = changes.xdrHeaderHidden.newValue !== false;
      if (newVal === headerHidden) return; // echo — skip
      headerHidden = newVal;
      applyHeaderVisibility();
      syncBannerCheckbox("xdrHeaderHidden", !headerHidden);
    }

    if ("xdrCompactMode" in changes) {
      const newVal = changes.xdrCompactMode.newValue === true;
      if (newVal === compactMode) return;
      compactMode = newVal;
      applyCompactMode();
      syncBannerCheckbox("xdrCompactMode", compactMode);
    }

    if ("xdrDimResolved" in changes) {
      const newVal = changes.xdrDimResolved.newValue !== false;
      if (newVal === dimResolved) return;
      dimResolved = newVal;
      applyResolvedDimming();
      syncBannerCheckbox("xdrDimResolved", dimResolved);
    }

    if ("xdrToggleTheme" in changes && changes.xdrToggleTheme.newValue === true) {
      storageApi.set({ xdrToggleTheme: false });
      togglePageTheme();
      return;
    }
  });

  // ── Per-column sort configuration ─────────────────────

  function numericCompare(a, b) { return a - b; }

  function makeIntExtractor(key) {
    const sel = cellSel(key);
    return (listCell) => {
      const el = listCell.querySelector(sel);
      if (!el) return null;
      const n = parseInt(el.textContent.trim(), 10);
      return isNaN(n) ? null : n;
    };
  }

  function makeTimestampExtractor(key) {
    const sel = cellSel(key);
    return (listCell) => {
      const el = listCell.querySelector(sel);
      if (!el) return null;
      const span = el.querySelector("span[value]");
      if (!span) return null;
      const ts = new Date(span.getAttribute("value")).getTime();
      return isNaN(ts) ? null : ts;
    };
  }

  const SORT_COLUMNS = {
    id: {
      headerSelector: headerSel("id"),
      cellSelector: cellSel("id"),
      extractValue: makeIntExtractor("id"),
      compare: numericCompare,
    },
    name: {
      headerSelector: headerSel("name"),
      cellSelector: cellSel("name"),
      extractValue(listCell) {
        const el = listCell.querySelector(cellSel("name"));
        if (!el) return null;
        const link = el.querySelector("a");
        return (link ? link.textContent : el.textContent).trim() || null;
      },
      compare: (a, b) => a.localeCompare(b),
    },
    topRisk: {
      headerSelector: headerSel("TopRisk"),
      cellSelector: cellSel("TopRisk"),
      extractValue: makeIntExtractor("TopRisk"),
      compare: numericCompare,
    },
    severity: {
      headerSelector: headerSel("severity"),
      cellSelector: cellSel("severity"),
      extractValue(listCell) {
        const el = listCell.querySelector(cellSel("severity"));
        if (!el) return null;
        const inner = el.querySelector("span span span");
        return (inner ? inner.textContent : el.textContent).trim() || null;
      },
      compare(a, b) {
        const rank = { Informational: 0, Low: 1, Medium: 2, High: 3 };
        return (rank[a] ?? 99) - (rank[b] ?? 99);
      },
    },
    status: {
      headerSelector: headerSel("status"),
      cellSelector: cellSel("status"),
      extractValue(listCell) {
        const el = listCell.querySelector(cellSel("status"));
        if (!el) return null;
        const span = el.querySelector('i[data-icon-name] + span');
        return (span ? span.textContent : el.textContent).trim() || null;
      },
      compare(a, b) {
        const rank = { New: 0, Active: 1, "In progress": 2, Redirected: 3, Resolved: 4 };
        return (rank[a] ?? 99) - (rank[b] ?? 99);
      },
    },
    firstEventTime: {
      headerSelector: headerSel("firstEventTime"),
      cellSelector: cellSel("firstEventTime"),
      extractValue: makeTimestampExtractor("firstEventTime"),
      compare: numericCompare,
    },
    lastEventTime: {
      headerSelector: headerSel("lastEventTime"),
      cellSelector: cellSel("lastEventTime"),
      extractValue: makeTimestampExtractor("lastEventTime"),
      compare: numericCompare,
    },
    lastUpdateTime: {
      headerSelector: headerSel("lastUpdateTime"),
      cellSelector: cellSel("lastUpdateTime"),
      extractValue: makeTimestampExtractor("lastUpdateTime"),
      compare: numericCompare,
    },
  };

  // ── Helpers ──────────────────────────────────────────────

  function arrowForState(state) {
    if (state === "asc") return " \u25B2";
    if (state === "desc") return " \u25BC";
    return "";
  }

  function isAlertCell(listCell) {
    const row = listCell.querySelector(SELECTORS.dataRow);
    if (!row) return false;
    return (row.getAttribute("aria-label") || "").startsWith("Alert ");
  }

  // ── Sort Logic ─────────────────────────────────────────
  //
  // We use CSS `order` to visually reorder cells without touching the DOM
  // tree React manages. This keeps React's fiber tree synchronized with the
  // real DOM, allowing alert expansion/collapse to work correctly.
  //
  // The surface is made a flex column and pages get display:contents so
  // cells from all pages participate in one shared flex ordering context.
  // This allows CSS order to sort globally across page boundaries.

  async function sortRows(force) {
    if (!extensionEnabled) return;
    if (!activeSortColumn || activeSortDir === "none") return;
    if (sortInProgress) return;
    sortInProgress = true;

    const colCfg = SORT_COLUMNS[activeSortColumn];

    try {
      const surface = document.querySelector(SELECTORS.listSurface);
      if (!surface) return;

      // Enable cross-page flex ordering: surface becomes the flex container,
      // pages use display:contents so cells are direct flex children.
      surface.classList.add("xdr-sort-active");

      // Collect ALL cells across ALL pages in DOM order.
      const allCells = Array.from(surface.querySelectorAll(SELECTORS.listCell));

      // Build groups: each group = [incidentCell, ...alertCells]
      const groups = [];
      let currentGroup = null;
      for (const cell of allCells) {
        if (isAlertCell(cell)) {
          if (currentGroup) currentGroup.push(cell);
        } else {
          currentGroup = [cell];
          groups.push(currentGroup);
        }
      }

      if (groups.length === 0) return;

      const dirMultiplier = activeSortDir === "asc" ? 1 : -1;

      groups.sort((a, b) => {
        const valA = colCfg.extractValue(a[0]);
        const valB = colCfg.extractValue(b[0]);
        if (valA === null && valB === null) return 0;
        if (valA === null) return 1;
        if (valB === null) return -1;
        return dirMultiplier * colCfg.compare(valA, valB);
      });

      // Assign sequential CSS order values across all pages.
      let orderIndex = 0;
      for (const group of groups) {
        for (const cell of group) {
          cell.style.order = String(orderIndex++);
        }
      }
    } finally {
      sortInProgress = false;
    }
  }

  // Remove sort-active class and clear style.order on all cells.
  function clearSort() {
    const surface = document.querySelector(SELECTORS.listSurface);
    if (!surface) return;
    surface.classList.remove("xdr-sort-active");
    surface.querySelectorAll(SELECTORS.listCell).forEach((cell) => {
      if (cell.style.order) cell.style.order = "";
    });
  }

  // ── Teardown ───────────────────────────────────────────

  function teardown() {
    if (observer) { observer.disconnect(); observer = null; }
    if (headerObserver) { headerObserver.disconnect(); headerObserver = null; }
    if (scrollHandler) {
      scrollHandler.target.removeEventListener("scroll", scrollHandler.handler);
      scrollHandler = null;
    }
    if (scrollTopBtn) { scrollTopBtn.remove(); scrollTopBtn = null; }
    if (mutationRafId) { cancelAnimationFrame(mutationRafId); mutationRafId = null; }
    if (headerRafId) { cancelAnimationFrame(headerRafId); headerRafId = null; }
    if (initIntervalId) { clearInterval(initIntervalId); initIntervalId = null; }
    activeSortColumn = null;
    activeSortDir = "none";
    clearSort();
    const surface = document.querySelector(SELECTORS.listSurface);
    if (surface) {
      surface.querySelectorAll(".xdr-resolved").forEach((cell) => {
        cell.classList.remove("xdr-resolved");
      });
    }
    for (const colKey of Object.keys(sortIndicators)) {
      const indicator = sortIndicators[colKey];
      if (indicator && indicator.parentNode) {
        indicator.parentNode.removeChild(indicator);
      }
      sortIndicators[colKey] = null;
    }
  }

  // ── Header Visibility ──────────────────────────────────

  function applyHeaderVisibility() {
    document.documentElement.classList.toggle("xdr-header-hidden", extensionEnabled && headerHidden);
  }

  function applyCompactMode() {
    document.documentElement.classList.toggle("xdr-compact-mode", extensionEnabled && compactMode);
  }

  function applyResolvedDimming() {
    const surface = document.querySelector(SELECTORS.listSurface);
    if (!surface) return;
    const cells = surface.querySelectorAll(SELECTORS.listCell);
    for (const cell of cells) {
      if (isAlertCell(cell)) continue;
      const statusCell = cell.querySelector(cellSel("status"));
      if (!statusCell) continue;
      const span = statusCell.querySelector("i[data-icon-name] + span");
      const statusText = span ? span.textContent.trim() : "";
      if (extensionEnabled && dimResolved && statusText === "Resolved") {
        cell.classList.add("xdr-resolved");
      } else {
        cell.classList.remove("xdr-resolved");
      }
    }
  }

  // ── Banner ─────────────────────────────────────────────

  function addBannerToggle(banner, { label, icon, setting, checked, onChange }) {
    const sep = document.createElement("span");
    sep.className = "xdr-banner-sep";
    sep.textContent = "|";
    banner.appendChild(sep);
    if (icon !== undefined) {
      const iconEl = document.createElement("span");
      iconEl.className = "xdr-banner-theme-icon";
      iconEl.textContent = icon;
      banner.appendChild(iconEl);
    }
    const labelEl = document.createElement("span");
    labelEl.className = "xdr-banner-label";
    labelEl.textContent = label;
    banner.appendChild(labelEl);
    const toggleLabel = document.createElement("label");
    toggleLabel.className = "xdr-toggle";
    toggleLabel.addEventListener("click", (e) => e.stopPropagation());
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.dataset.setting = setting;
    cb.addEventListener("change", onChange);
    const slider = document.createElement("span");
    slider.className = "xdr-toggle-slider";
    toggleLabel.appendChild(cb);
    toggleLabel.appendChild(slider);
    banner.appendChild(toggleLabel);
  }

  function updateBannerState(banner) {
    const text = banner.querySelector(".xdr-banner-text");
    if (text) {
      text.textContent = extensionEnabled
        ? "Better XDR extension enabled"
        : "Better XDR extension disabled";
    }
    if (extensionEnabled) {
      banner.classList.remove("xdr-disabled");
    } else {
      banner.classList.add("xdr-disabled");
    }
    const isDark = getCurrentTheme() === "dark";
    const cb = banner.querySelector('[data-setting="xdrTheme"]');
    if (cb) cb.checked = isDark;
    const icon = banner.querySelector(".xdr-banner-theme-icon");
    if (icon) icon.textContent = isDark ? "\u263E" : "\u2600";
  }

  function injectBanner() {
    const existing = document.querySelector(".xdr-sorter-banner");
    if (existing) {
      updateBannerState(existing);
      return;
    }

    const header = document.querySelector(".scc-page-header-container");
    if (!header) return;

    const banner = document.createElement("span");
    banner.className = "xdr-sorter-banner";
    if (!extensionEnabled) banner.classList.add("xdr-disabled");

    const text = document.createElement("span");
    text.className = "xdr-banner-text";
    text.textContent = extensionEnabled
      ? "Better XDR extension enabled"
      : "Better XDR extension disabled";
    banner.appendChild(text);

    addBannerToggle(banner, {
      label: "Dark",
      icon: getCurrentTheme() === "dark" ? "\u263E" : "\u2600",
      setting: "xdrTheme",
      checked: getCurrentTheme() === "dark",
      onChange: () => togglePageTheme(),
    });

    if (location.pathname.startsWith("/incidents")) {
      addBannerToggle(banner, {
        label: "Header",
        setting: "xdrHeaderHidden",
        checked: !headerHidden,
        onChange: async (e) => {
          headerHidden = !e.target.checked;
          await setSetting("xdrHeaderHidden", headerHidden);
          applyHeaderVisibility();
        },
      });
      addBannerToggle(banner, {
        label: "Compact",
        setting: "xdrCompactMode",
        checked: compactMode,
        onChange: async (e) => {
          compactMode = e.target.checked;
          await setSetting("xdrCompactMode", compactMode);
          applyCompactMode();
        },
      });
      addBannerToggle(banner, {
        label: "Dim Resolved",
        setting: "xdrDimResolved",
        checked: dimResolved,
        onChange: async (e) => {
          dimResolved = e.target.checked;
          await setSetting("xdrDimResolved", dimResolved);
          applyResolvedDimming();
        },
      });
    }

    const breadcrumb = header.querySelector(".scc-page-header-breadcrumb");
    if (breadcrumb) {
      breadcrumb.appendChild(banner);
    } else {
      header.appendChild(banner);
    }
  }

  // ── Header Injection ──────────────────────────────────

  function injectSortButton() {
    const table = document.querySelector(SELECTORS.table);
    if (!table) return;

    for (const [colKey, colCfg] of Object.entries(SORT_COLUMNS)) {
      const header = table.querySelector(colCfg.headerSelector);
      if (!header) continue;

      const nameDiv = header.querySelector('[class*="cellName"] > div');
      if (!nameDiv) continue;

      let indicator = nameDiv.querySelector(".xdr-sort-indicator");
      if (!indicator) {
        indicator = document.createElement("span");
        indicator.className = "xdr-sort-indicator";
        nameDiv.appendChild(indicator);

        const cellTitle = header.querySelector('[class*="cellTitle"]');
        if (cellTitle) {
          cellTitle.addEventListener(
            "click",
            (e) => {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
              toggleSort(colKey);
            },
            true
          );
        }
      }

      sortIndicators[colKey] = indicator;
      // Sync indicator text to current state (handles React re-renders).
      const desired = activeSortColumn === colKey ? arrowForState(activeSortDir) : "";
      if (indicator.textContent !== desired) {
        indicator.textContent = desired;
      }
    }
  }

  async function toggleSort(colKey) {
    if (activeSortColumn === colKey) {
      // Cycle direction on the same column: none → desc → asc → none
      if (activeSortDir === "none") {
        activeSortDir = "desc";
      } else if (activeSortDir === "desc") {
        activeSortDir = "asc";
      } else {
        activeSortDir = "none";
        activeSortColumn = null;
        clearSort();
      }
    } else {
      // Switch to a new column — start at desc.
      activeSortColumn = colKey;
      activeSortDir = "desc";
    }
    updateAllIndicators();
    if (activeSortDir !== "none") {
      await sortRows(true);
    }
  }

  function updateAllIndicators() {
    for (const [colKey, indicator] of Object.entries(sortIndicators)) {
      if (!indicator) continue;
      const desired = activeSortColumn === colKey ? arrowForState(activeSortDir) : "";
      if (indicator.textContent !== desired) {
        indicator.textContent = desired;
      }
    }
  }

  // ── MutationObserver ──────────────────────────────────
  //
  // We watch the list surface for child-list changes (new pages /
  // cells being added by the virtualiser or by new data loading).
  // A short debounce collapses rapid DOM churn into a single re-sort.

  let mutationRafId = null;
  let headerRafId = null;

  function onMutation(mutations) {
    if (!extensionEnabled) return;

    // Immediately assign order to newly added cells to prevent a
    // sub-frame visual flash before the debounced re-sort runs.
    if (activeSortColumn && activeSortDir !== "none") {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const cells = node.matches(SELECTORS.listCell)
            ? [node]
            : Array.from(node.querySelectorAll(SELECTORS.listCell));
          for (const cell of cells) {
            // Copy the order from the previous sibling so the cell
            // appears roughly in the right place until re-sort runs.
            const prev = cell.previousElementSibling;
            if (prev && prev.style.order) {
              cell.style.order = prev.style.order;
            }
          }
        }
      }
    }

    // Debounce via rAF — gives the browser one paint frame to finish
    // rendering the new rows, then we immediately re-sort.  This is
    // faster than a fixed setTimeout and keeps the unsorted flash to
    // a single frame at most.
    if (mutationRafId) cancelAnimationFrame(mutationRafId);
    mutationRafId = requestAnimationFrame(() => {
      mutationRafId = null;
      injectSortButton();
      applyResolvedDimming();
      if (activeSortColumn && activeSortDir !== "none") {
        sortRows(false);
      }
    });
  }

  function startObserver() {
    if (observer) observer.disconnect();
    if (headerObserver) { headerObserver.disconnect(); headerObserver = null; }

    // Observe the list surface specifically (tighter scope = less noise)
    const surface = document.querySelector(SELECTORS.listSurface);
    const target = surface || document.querySelector(SELECTORS.table);
    if (!target) return;

    observer = new MutationObserver(onMutation);
    observer.observe(target, { childList: true, subtree: true });

    // Also observe each sortable column header so we can re-inject our
    // indicators if React re-renders the header.
    const tableEl = document.querySelector(SELECTORS.table);
    if (tableEl) {
      const headerCallback = new MutationObserver(() => {
        if (headerRafId) cancelAnimationFrame(headerRafId);
        headerRafId = requestAnimationFrame(() => {
          headerRafId = null;
          injectSortButton();
        });
      });
      for (const colCfg of Object.values(SORT_COLUMNS)) {
        const colHeader = tableEl.querySelector(colCfg.headerSelector);
        if (colHeader && colHeader !== target) {
          headerCallback.observe(colHeader, { childList: true, subtree: true });
        }
      }
      headerObserver = headerCallback;
    }
  }

  // ── Scroll watcher ────────────────────────────────────
  //
  // Scrolling is the primary trigger for the virtualiser loading
  // new pages.  We listen for scroll-end on the scrollable ancestor
  // and re-sort once scrolling settles.

  function startScrollWatcher() {
    if (scrollHandler) {
      scrollHandler.target.removeEventListener("scroll", scrollHandler.handler);
      scrollHandler = null;
    }

    // The scrollable container is typically an ancestor with
    // overflow: auto/scroll.  Walk up from the table to find it.
    const table = document.querySelector(SELECTORS.table);
    if (!table) return;

    let scrollParent = table.parentElement;
    while (scrollParent && scrollParent !== document.body) {
      const style = getComputedStyle(scrollParent);
      if (
        style.overflow === "auto" ||
        style.overflow === "scroll" ||
        style.overflowY === "auto" ||
        style.overflowY === "scroll"
      ) {
        break;
      }
      scrollParent = scrollParent.parentElement;
    }

    const target = scrollParent || window;
    let scrollTimer = null;

    const handler = () => {
      updateScrollTopVisibility();
      if (!extensionEnabled) return;
      if (!activeSortColumn || activeSortDir === "none") return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        applyResolvedDimming();
        sortRows(false);
      }, 150);
    };

    target.addEventListener("scroll", handler, { passive: true });
    scrollHandler = { target, handler };
  }

  // ── Scroll-to-top button ───────────────────────────────

  function createScrollTopButton() {
    if (scrollTopBtn) return;
    const btn = document.createElement("button");
    btn.className = "xdr-scroll-top";
    btn.setAttribute("aria-label", "Scroll to top");
    btn.setAttribute("title", "Scroll to top");
    btn.addEventListener("click", () => {
      const target = scrollHandler ? scrollHandler.target : window;
      target.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.body.appendChild(btn);
    scrollTopBtn = btn;
  }

  function updateScrollTopVisibility() {
    if (!scrollTopBtn) return;
    const target = scrollHandler ? scrollHandler.target : window;
    const scrollY = target === window
      ? (window.scrollY || window.pageYOffset)
      : target.scrollTop;
    scrollTopBtn.classList.toggle("xdr-scroll-top-visible", scrollY > SCROLL_TOP_THRESHOLD);
  }

  // ── Init ───────────────────────────────────────────────

  function init() {
    if (initIntervalId) { clearInterval(initIntervalId); initIntervalId = null; }

    initIntervalId = setInterval(() => {
      // Banner on any page with header (theme toggle works everywhere).
      // Always call injectBanner so updateBannerState re-syncs theme each tick.
      if (document.querySelector(".scc-page-header-container")) injectBanner();

      // Table-dependent features (sort, header visibility)
      const table = document.querySelector(SELECTORS.table);
      if (table) {
        clearInterval(initIntervalId);
        initIntervalId = null;
        injectBanner(); // ensure exists
        applyHeaderVisibility();
        applyCompactMode();
        applyResolvedDimming();
        if (extensionEnabled) {
          injectSortButton();
          startObserver();
          startScrollWatcher();
          createScrollTopButton();
        }
      }
    }, 500);

    setTimeout(() => {
      if (initIntervalId) { clearInterval(initIntervalId); initIntervalId = null; }
    }, 60000);
  }

  // Load persisted state, then initialize
  Promise.all([
    getSetting("xdrEnabled", true),
    getSetting("xdrHeaderHidden", true),
    getSetting("xdrCompactMode", false),
    getSetting("xdrDimResolved", true),
  ]).then(([enabled, hidden, compact, dim]) => {
    extensionEnabled = enabled;
    headerHidden = hidden;
    compactMode = compact;
    dimResolved = dim;
    syncThemeToStorage();
    injectThemeBridge();
    init();
  });

  // Re-init on SPA navigation
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      teardown();
      syncThemeToStorage();
      init();
    }
  }, 1000);
})();
