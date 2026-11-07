/* Thin promise wrapper around chrome.runtime messaging. */
(() => {
  const LB = (globalThis.LB = globalThis.LB || {});

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            resolve({
              ok: false,
              error: { code: "extension_error", message: runtimeError.message }
            });
            return;
          }
          resolve(
            response || {
              ok: false,
              error: { code: "empty_response", message: "The extension worker did not respond." }
            }
          );
        });
      } catch (error) {
        resolve({
          ok: false,
          error: { code: "extension_error", message: String(error && error.message ? error.message : error) }
        });
      }
    });
  }

  LB.messaging = {
    send,
    getSettings: () => send({ type: "LB_GET_SETTINGS" }),
    translate: (payload) => send({ type: "LB_TRANSLATE", payload }),
    ping: (backendUrl) => send({ type: "LB_PING", payload: { backendUrl } }),
    clearCache: () => send({ type: "LB_CLEAR_CACHE" })
  };
})();
