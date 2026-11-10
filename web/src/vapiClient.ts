// Part 1 -> Part 3: Vapi Web SDK wrapper. `npm i @vapi-ai/web` in web/.
// Usage: const jamie = await startJamie(SERVER_URL); ... jamie.stop();
import Vapi from "@vapi-ai/web";

export async function startJamie(serverUrl: string) {
  const { publicKey, assistant } = await (await fetch(`${serverUrl}/assistant`)).json();
  const vapi = new Vapi(publicKey);
  let callId: string | undefined;

  // Relay transcripts + speech updates to the server (backup for the webhook; server dedupes).
  vapi.on("message", (message: any) => {
    if (!["transcript", "speech-update", "status-update"].includes(message?.type)) return;
    fetch(`${serverUrl}/vapi/client-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId, message }),
    }).catch(() => {});
  });
  vapi.on("error", (e: any) => console.error("[vapi] error", e));

  // Fallback (d): server has no controlUrl, so the browser speaks.
  const ws = new WebSocket(serverUrl.replace(/^http/, "ws") + "/live");
  ws.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.type === "jamie" && e.clientShouldSpeak && e.text) vapi.say(e.text, false);
  };

  const call: any = await vapi.start(assistant);
  callId = call?.id;
  await fetch(`${serverUrl}/vapi/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ call }),
  });

  return {
    vapi,
    stop: () => {
      vapi.stop();
      ws.close();
    },
  };
}
