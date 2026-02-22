// Runs in the page's MAIN world (injected by content.js).
// Captures pristine built-in references before page scripts can tamper.
(function () {
  const _objectKeys = Object.keys;
  const _jsonParse = JSON.parse;
  const _jsonStringify = JSON.stringify;
  const _storageGetItem = Storage.prototype.getItem;
  const _storageSetItem = Storage.prototype.setItem;
  const _setAttribute = Element.prototype.setAttribute;
  const _getAttribute = Element.prototype.getAttribute;
  const _removeAttribute = Element.prototype.removeAttribute;
  const _stringStartsWith = String.prototype.startsWith;
  const _dateNow = Date.now;

  // Read nonce set by content.js, then immediately remove it from the DOM.
  const bridgeNonce = _getAttribute.call(document.documentElement, "data-xdr-bridge-nonce");
  _removeAttribute.call(document.documentElement, "data-xdr-bridge-nonce");

  // On load: reads the authoritative theme from localStorage and stamps it
  // onto a DOM attribute so the content script can read it reliably.
  const keys = _objectKeys(localStorage);
  const themeKey = keys.find((k) => _stringStartsWith.call(k, "localConfig-prefersTheme-"));
  if (themeKey) {
    try {
      const obj = _jsonParse(_storageGetItem.call(localStorage, themeKey));
      if (obj && obj.value) {
        _setAttribute.call(document.documentElement, "data-xdr-theme", obj.value);
      }
    } catch (e) {}
  }

  // Toggle theme on request from the content script.
  let lastReloadTime = 0;
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== "xdr-toggle-theme") return;

    // Reject messages without the correct nonce.
    if (!bridgeNonce || e.data.nonce !== bridgeNonce) return;

    // Reload cooldown: ignore requests within 5 seconds of the last reload.
    const now = _dateNow();
    if (now - lastReloadTime < 5000) return;
    lastReloadTime = now;

    const toggleKeys = _objectKeys(localStorage);
    const toggleThemeKey = toggleKeys.find((k) => _stringStartsWith.call(k, "localConfig-prefersTheme-"));
    if (toggleThemeKey) {
      try {
        const obj = _jsonParse(_storageGetItem.call(localStorage, toggleThemeKey));
        const newValue = obj.value === "dark" ? "light" : "dark";
        obj.value = newValue;
        obj.lastVisit = new Date().toISOString();
        _storageSetItem.call(localStorage, toggleThemeKey, _jsonStringify(obj));
      } catch (err) {
        console.error("[XDR] failed to toggle theme:", err);
      }
    }

    window.location.reload();
  });
})();
