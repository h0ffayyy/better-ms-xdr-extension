(function () {
  "use strict";

  const storageApi =
    typeof browser !== "undefined" && browser.storage
      ? browser.storage.local
      : chrome.storage.local;

  const onChangedApi =
    typeof browser !== "undefined" && browser.storage
      ? browser.storage.onChanged
      : chrome.storage.onChanged;

  const enabledToggle = document.getElementById("enabledToggle");
  const headerToggle = document.getElementById("headerToggle");
  const themeToggle = document.getElementById("themeToggle");
  const compactToggle = document.getElementById("compactToggle");
  const dimResolvedToggle = document.getElementById("dimResolvedToggle");
  const versionLabel = document.getElementById("versionLabel");

  const manifestApi =
    typeof browser !== "undefined" && browser.runtime
      ? browser.runtime
      : chrome.runtime;
  versionLabel.textContent = "v" + manifestApi.getManifest().version;

  const otherToggles = [headerToggle, themeToggle, compactToggle, dimResolvedToggle];

  function setOtherTogglesDisabled(disabled) {
    for (const toggle of otherToggles) {
      toggle.disabled = disabled;
      toggle.closest(".popup-row").classList.toggle("popup-row-disabled", disabled);
    }
  }

  // Read current state when popup opens
  storageApi.get(["xdrEnabled", "xdrHeaderHidden", "xdrCurrentTheme", "xdrCompactMode", "xdrDimResolved"]).then((result) => {
    enabledToggle.checked = result.xdrEnabled !== false;
    headerToggle.checked = result.xdrHeaderHidden === false; // checked = visible = not hidden
    themeToggle.checked = result.xdrCurrentTheme === "dark";
    compactToggle.checked = result.xdrCompactMode === true;
    dimResolvedToggle.checked = result.xdrDimResolved !== false; // default true
    setOtherTogglesDisabled(!enabledToggle.checked);
  });

  // Write to storage on toggle change; content script reacts via storage.onChanged
  enabledToggle.addEventListener("change", () => {
    storageApi.set({ xdrEnabled: enabledToggle.checked });
    setOtherTogglesDisabled(!enabledToggle.checked);
  });

  headerToggle.addEventListener("change", () => {
    storageApi.set({ xdrHeaderHidden: !headerToggle.checked });
  });

  themeToggle.addEventListener("change", () => {
    storageApi.set({ xdrToggleTheme: true });
  });

  compactToggle.addEventListener("change", () => {
    storageApi.set({ xdrCompactMode: compactToggle.checked });
  });

  dimResolvedToggle.addEventListener("change", () => {
    storageApi.set({ xdrDimResolved: dimResolvedToggle.checked });
  });

  // Keep popup in sync if the banner is toggled while the popup is open
  onChangedApi.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if ("xdrEnabled" in changes) {
      enabledToggle.checked = changes.xdrEnabled.newValue !== false;
      setOtherTogglesDisabled(!enabledToggle.checked);
    }
    if ("xdrHeaderHidden" in changes) {
      headerToggle.checked = changes.xdrHeaderHidden.newValue === false;
    }
    if ("xdrCurrentTheme" in changes) {
      themeToggle.checked = changes.xdrCurrentTheme.newValue === "dark";
    }
    if ("xdrCompactMode" in changes) {
      compactToggle.checked = changes.xdrCompactMode.newValue === true;
    }
    if ("xdrDimResolved" in changes) {
      dimResolvedToggle.checked = changes.xdrDimResolved.newValue !== false;
    }
  });
})();
