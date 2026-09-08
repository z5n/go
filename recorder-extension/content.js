(() => {
  const CHANNEL = "GO_HILTON_RECORDER";
  let eventCount = 0;
  let gqlCount = 0;
  let lastNav = "";

  function forward(payload) {
    eventCount += 1;
    if (payload.type === "graphql") gqlCount += 1;
    updateBadge();
    chrome.runtime.sendMessage({ type: "FORWARD_EVENT", payload }, () => {
      void chrome.runtime.lastError;
    });
  }

  // Inject MAIN-world hook via script tag (more reliable than world:MAIN alone)
  function injectHook() {
    if (document.documentElement?.dataset.goRecorderInjected === "1") return;
    if (document.documentElement) document.documentElement.dataset.goRecorderInjected = "1";
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-hook.js");
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
  }
  injectHook();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL) return;
    forward(data);
  });

  const notifyNav = () => {
    if (location.href === lastNav) return;
    lastNav = location.href;
    forward({ type: "nav", url: location.href, href: location.href });
  };
  setInterval(notifyNav, 1000);

  function updateBadge() {
    const el = document.getElementById("go-hilton-recorder-badge");
    if (!el) return;
    el.textContent = `REC · ${gqlCount} GraphQL · ${eventCount} events`;
    el.style.background = gqlCount > 0 ? "#1f6b43" : "#b42318";
  }

  function mountBadge() {
    if (document.getElementById("go-hilton-recorder-badge")) return;
    const badge = document.createElement("div");
    badge.id = "go-hilton-recorder-badge";
    badge.textContent = "REC · waiting for Hilton traffic…";
    Object.assign(badge.style, {
      position: "fixed",
      zIndex: "2147483647",
      right: "16px",
      top: "16px",
      padding: "10px 14px",
      borderRadius: "999px",
      background: "#b42318",
      color: "#fff",
      font: "600 13px/1.2 system-ui, sans-serif",
      boxShadow: "0 10px 30px rgba(0,0,0,.25)",
      pointerEvents: "none",
    });
    document.documentElement.appendChild(badge);
  }

  if (document.documentElement) mountBadge();
  else document.addEventListener("DOMContentLoaded", mountBadge);
  // Remount if Hilton wipes DOM
  setInterval(mountBadge, 2000);
  setInterval(updateBadge, 1000);

  forward({ type: "content_ready", href: location.href, url: location.href });
})();
