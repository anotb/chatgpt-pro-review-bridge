export async function importChatGPTBridge({ cacheBust = true } = {}) {
  const runtimeUrl = new URL("./node/chatgpt-bridge.bundle.mjs", import.meta.url);
  return import(cacheBust ? `${runtimeUrl.href}?t=${Date.now()}` : runtimeUrl.href);
}
