async function refresh() {
  const el = document.getElementById("status");
  try {
    const res = await fetch("http://127.0.0.1:3847/status");
    const data = await res.json();
    const ops = data.graphqlOpCounts || {};
    const opLines = Object.entries(ops)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    el.className = data.eventCount > 0 ? "ok" : "bad";
    el.textContent = [
      `Server: ok`,
      `Events: ${data.eventCount || 0}`,
      `Last: ${(data.lastUrl || "").slice(0, 60)}`,
      opLines ? `GraphQL:\n${opLines}` : "GraphQL: none yet — reload the Hilton tab",
    ].join("\n");
  } catch {
    el.className = "bad";
    el.textContent = "Server not reachable on :3847\nAsk the agent to restart it.";
  }
}

refresh();
setInterval(refresh, 1500);
