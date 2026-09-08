(function recorderPageHook() {
  if (window.__goRecorderHook) return;
  window.__goRecorderHook = true;

  const CHANNEL = "GO_HILTON_RECORDER";

  function emit(payload) {
    try {
      window.postMessage({ source: CHANNEL, ...payload }, "*");
    } catch {
      /* ignore */
    }
  }

  function extractOperationName(url, postData) {
    try {
      const u = new URL(url, location.origin);
      const q = u.searchParams.get("operationName") || u.searchParams.get("originalOpName");
      if (q) return q;
    } catch {
      /* ignore */
    }
    try {
      return postData ? JSON.parse(postData)?.operationName || null : null;
    } catch {
      return null;
    }
  }

  function deepFindCtyhocns(node, out = new Set()) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      for (const item of node) deepFindCtyhocns(item, out);
      return out;
    }
    for (const [k, v] of Object.entries(node)) {
      if ((/^ctyhocn$/i.test(k) || /^propCode$/i.test(k)) && typeof v === "string" && /^[A-Z0-9]{4,10}$/i.test(v)) {
        out.add(v.toUpperCase());
      } else if (v && typeof v === "object") {
        deepFindCtyhocns(v, out);
      }
    }
    return out;
  }

  function countRateHints(json) {
    if (!json) return 0;
    try {
      const text = JSON.stringify(json);
      return (text.match(/"rateAmount"|"amountBeforeTax"|"averageRate"|"cashRate"|"dailyRate"/g) || []).length;
    } catch {
      return 0;
    }
  }

  function shouldInspect(url) {
    return /hilton\.com\/graphql|\/graphql\/customer/i.test(String(url || ""));
  }

  function parseBody(body) {
    if (!body) return null;
    if (typeof body === "string") return body;
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
    return null;
  }

  function getUrl(input) {
    if (typeof input === "string") return input;
    try {
      return input?.url || String(input);
    } catch {
      return "";
    }
  }

  function getBodyText(input, init) {
    const fromInit = parseBody(init?.body);
    if (fromInit) return fromInit;
    try {
      // Request bodies are streams; we cannot re-read them. Operation name usually is in the URL.
      return null;
    } catch {
      return null;
    }
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return { _raw: String(text).slice(0, 4000) };
    }
  }

  async function handleGraphQL(url, bodyText, response) {
    try {
      let text = "";
      try {
        text = await response.clone().text();
      } catch (err) {
        emit({
          type: "hook_error",
          href: location.href,
          message: `clone/text failed: ${err}`,
          url: String(url),
        });
        return;
      }

      let json = null;
      if (text && text !== "Success") {
        try {
          json = JSON.parse(text);
        } catch {
          json = { _rawText: text.slice(0, 500) };
        }
      } else {
        json = { _rawText: String(text).slice(0, 200) };
      }

      emit({
        type: "graphql",
        href: location.href,
        url: String(url),
        status: response.status,
        operationName: extractOperationName(url, bodyText),
        ctyhocns: json ? [...deepFindCtyhocns(json)] : [],
        dailyRateHints: countRateHints(json),
        requestBody: bodyText ? safeJson(bodyText) : null,
        response: json,
      });
    } catch (err) {
      emit({
        type: "hook_error",
        href: location.href,
        message: String(err),
        url: String(url),
      });
    }
  }

  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function (input, init) {
        // IMPORTANT: do not default init to {}. Passing {} breaks fetch(Request).
        const args = init === undefined ? [input] : [input, init];
        const result = originalFetch.apply(this, args);

        Promise.resolve(result)
          .then((response) => {
            try {
              const url = getUrl(input);
              if (shouldInspect(url)) {
                handleGraphQL(url, getBodyText(input, init), response);
              }
            } catch {
              /* never break Hilton */
            }
            return response;
          })
          .catch(() => {});

        return result;
      };
    }
  } catch (err) {
    emit({ type: "hook_error", href: location.href, message: `fetch wrap failed: ${err}` });
  }

  try {
    const xhrOpen = XMLHttpRequest.prototype.open;
    const xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__recUrl = url;
      return xhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      this.__recBody = parseBody(body);
      this.addEventListener("load", () => {
        try {
          if (!shouldInspect(this.__recUrl)) return;
          const text = this.responseText;
          handleGraphQL(this.__recUrl, this.__recBody, {
            status: this.status,
            clone() {
              return { text: async () => text };
            },
          });
        } catch {
          /* ignore */
        }
      });
      return xhrSend.call(this, body);
    };
  } catch (err) {
    emit({ type: "hook_error", href: location.href, message: `xhr wrap failed: ${err}` });
  }

  window.addEventListener(
    "click",
    (event) => {
      try {
        const el = event.target?.closest?.("a,button,[role='button'],[data-testid]") || event.target;
        if (!el) return;
        emit({
          type: "click",
          href: location.href,
          text: (el.innerText || el.getAttribute?.("aria-label") || "").trim().slice(0, 160),
          link: el.href || el.getAttribute?.("href") || null,
          testId: el.getAttribute?.("data-testid") || null,
        });
      } catch {
        /* ignore */
      }
    },
    true
  );

  emit({ type: "hook_ready", href: location.href, url: location.href });
  emit({ type: "nav", href: location.href, url: location.href });
})();
