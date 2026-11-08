function getServerRoomParams() {
  if (typeof location === "undefined") return null;
  const params = new URLSearchParams(location.search);
  const room = params.get("sa-room");
  const uid = params.get("sa-uid");
  const token = params.get("sa-token");
  if (!room || !uid || !token) return null;
  return { room, uid, token, game: params.get("sa-game"), defer: params.get("sa-defer") === "1" };
}
function applyServerRoomConfig(lib, _status) {
  const params = getServerRoomParams();
  if (!params) return false;
  const extensions = [...new Set((new URLSearchParams(location.search).get("sa-ext") || "").split(",").map((n) => n.trim()).filter(Boolean))];
  for (const name of lib.config.extensions || []) lib.config[`extension_${name}_enable`] = false;
  lib.config.extensions = extensions;
  for (const name of extensions) lib.config[`extension_${name}_enable`] = true;
  lib.config.extension_auto_import = false;
  _status.serverRoom = params;
  lib.config.mode = "connect";
  lib.config.show_splash = "off";
  lib.config.new_tutorial = true;
  window.alert = (message) => {
    console.error("[noname]", message);
    notifyShell("game-error", { message: String(message).slice(0, 300) });
  };
  return true;
}
const NativeWebSocket = typeof WebSocket === "undefined" ? void 0 : WebSocket;
function notifyShell(type, detail = {}) {
  try {
    window.parent?.postMessage({ type: `noname:${type}`, ...detail }, location.origin);
  } catch {
  }
}
class ResumableSocket {
  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._nocallback = false;
    this.readyState = 0;
    this.serverSeq = 0;
    this.clientSeq = 0;
    this.outbox = [];
    this.attempt = 0;
    this.everOpened = false;
    this.closedByUser = false;
    this.ackTimer = setInterval(() => this.#ack(), 2e3);
    this.#open();
  }
  #open() {
    const url = new URL(this.url);
    if (this.everOpened) {
      url.searchParams.set("resume", String(this.serverSeq));
      url.searchParams.set("cseq", String(this.clientSeq));
    }
    const ws = new NativeWebSocket(url.href);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.readyState = 1;
      if (!this.everOpened) {
        this.everOpened = true;
        this.onopen?.({ target: this });
      } else {
        notifyShell("game-reconnected");
      }
    };
    ws.onmessage = (e) => this.#receive(String(e.data));
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.readyState = 0;
      if (this.closedByUser) return;
      if ([4e3, 4001, 4002, 4401, 4404, 4410].includes(e.code)) return this.#giveUp(e.code);
      if (!this.everOpened && !opened && this.attempt >= 3) {
        this.onerror?.({ target: this });
        return this.#giveUp(e.code);
      }
      notifyShell("game-reconnecting", { attempt: this.attempt });
      const delay = Math.min(5e3, 300 * 2 ** this.attempt++);
      setTimeout(() => this.#open(), delay);
    };
  }
  #receive(frame) {
    if (frame.charCodeAt(0) === 6) {
      if (frame === "fresh") {
        this.closedByUser = true;
        notifyShell("game-reload");
        location.reload();
        return;
      }
      if (frame.startsWith("resume:")) {
        const got = Number(frame.slice(8));
        this.outbox = this.outbox.filter(([seq2]) => seq2 > got);
        for (const [seq2, data] of this.outbox) this.ws.send(`${seq2}
${data}`);
      }
      return;
    }
    const nl = frame.indexOf("\n");
    const seq = Number(frame.slice(0, nl));
    if (seq <= this.serverSeq) return;
    if (this.serverSeq === 0) notifyShell("game-connected");
    this.serverSeq = seq;
    this.onmessage?.({ data: frame.slice(nl + 1), target: this });
  }
  #ack() {
    if (this.readyState === 1 && this.ws.readyState === NativeWebSocket.OPEN) this.ws.send(`ack:${this.serverSeq}`);
  }
  /** @param {string} data */
  send(data) {
    const seq = ++this.clientSeq;
    this.outbox.push([seq, data]);
    if (this.outbox.length > 2e3) this.outbox.shift();
    if (this.readyState === 1 && this.ws.readyState === NativeWebSocket.OPEN) this.ws.send(`${seq}
${data}`);
  }
  #giveUp(code) {
    clearInterval(this.ackTimer);
    this.readyState = 3;
    if (code === 4e3) {
      this.closedByUser = true;
      notifyShell("game-reload");
      location.reload();
      return;
    }
    notifyShell("game-closed", { code });
  }
  close() {
    this.closedByUser = true;
    clearInterval(this.ackTimer);
    this.readyState = 3;
    this.ws?.close(1e3);
    if (!this._nocallback) this.onclose?.({ target: this, code: 1e3 });
  }
}
function connectServerRoom(game, _status) {
  const params = _status.serverRoom;
  if (params.defer && !params.game) {
    const onMessage = (e) => {
      if (e.origin !== location.origin || e.data?.type !== "noname:attach" || !e.data.game) return;
      window.removeEventListener("message", onMessage);
      params.game = e.data.game;
      connectServerRoom(game, _status);
    };
    window.addEventListener("message", onMessage);
    notifyShell("game-preloaded");
    return;
  }
  const { room, uid, token, game: gameId } = params;
  game.onlineID = uid;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws/game?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}${gameId ? `&game=${encodeURIComponent(gameId)}` : ""}`;
  const previous = window.WebSocket;
  window.WebSocket = ResumableSocket;
  try {
    game.connect(url, (success) => {
      if (!success) notifyShell("game-connect-failed", { room });
    });
  } finally {
    window.WebSocket = previous;
  }
}
export {
  ResumableSocket,
  applyServerRoomConfig,
  connectServerRoom,
  getServerRoomParams
};
