import { lib, ui, _status, game, get } from "noname";
const NativeWebSocket = typeof WebSocket === "undefined" ? void 0 : WebSocket;
function notifyShell(type2, detail = {}) {
  try {
    window.parent?.postMessage({ type: `noname:${type2}`, ...detail }, location.origin);
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
function connectServerRoom(game2, _status2) {
  const params = _status2.serverRoom;
  if (params.defer && !params.game) {
    const onMessage = (e) => {
      if (e.origin !== location.origin || e.data?.type !== "noname:attach" || !e.data.game) return;
      window.removeEventListener("message", onMessage);
      params.game = e.data.game;
      connectServerRoom(game2, _status2);
    };
    window.addEventListener("message", onMessage);
    notifyShell("game-preloaded");
    return;
  }
  const { room, uid, token, game: gameId } = params;
  game2.onlineID = uid;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws/game?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}${gameId ? `&game=${encodeURIComponent(gameId)}` : ""}`;
  const previous = window.WebSocket;
  window.WebSocket = ResumableSocket;
  try {
    game2.connect(url, (success) => {
      if (!success) notifyShell("game-connect-failed", { room });
    });
  } finally {
    window.WebSocket = previous;
  }
}
const type = "mode";
const connect = {
  name: "connect",
  async start(event, trigger, player) {
    const directstartmode = lib.config.directstartmode;
    ui.create.menu(true);
    if (_status.serverRoom) {
      if (!game.onlineKey) {
        game.onlineKey = localStorage.getItem(`${lib.configprefix}key`) || get.id();
        localStorage.setItem(`${lib.configprefix}key`, game.onlineKey);
      }
      connectServerRoom(game, _status);
      setTimeout(lib.init.onfree, 1e3);
      return;
    }
    event.textnode = ui.create.div("", "输入联机地址");
    const createNode = () => {
      if (event.created) {
        return;
      }
      if (directstartmode && lib.node) {
        ui.exitroom = ui.create.system(
          "退出房间",
          () => {
            game.saveConfig("directstartmode");
            game.reload();
          },
          true
        );
        game.switchMode(directstartmode);
        return;
      }
      if (lib.node && window.require) {
        ui.startServer = ui.create.system(
          "启动服务器",
          (e) => {
            ui.click.shortcut(false);
            e.stopPropagation();
            ui.click.connectMenu();
          },
          true
        );
      }
      event.created = true;
      const node = ui.create.div(".shadowed");
      node.style.width = "400px";
      node.style.height = "30px";
      node.style.lineHeight = "30px";
      node.style.fontFamily = "xinwei";
      node.style.fontSize = "30px";
      node.style.padding = "10px";
      node.style.left = "calc(50% - 210px)";
      node.style.top = "calc(50% - 20px)";
      node.style.whiteSpace = "nowrap";
      node.textContent = lib.config.last_ip || lib.hallURL;
      node.contentEditable = true;
      node.style.webkitUserSelect = "text";
      node.style.textAlign = "center";
      node.style.overflow = "hidden";
      let connectionStarted = false;
      const connect2 = (e, invitationText) => {
        connectionStarted = true;
        event.textnode.textContent = "正在连接...";
        clearTimeout(event.timeout);
        if (e) {
          e.preventDefault();
        }
        const ip = node.textContent;
        game.requireSandboxOn(ip);
        game.saveConfig("last_ip", ip);
        game.connect(ip, (success) => {
          if (success) {
            if (invitationText) {
              _status.read_clipboard_text = invitationText;
              return;
            }
            const info = lib.config.reconnect_info;
            if (info && info[0] === _status.ip) {
              game.onlineID = info[1];
              if (typeof (game.roomId = info[2]) === "string") {
                game.roomIdServer = true;
              }
            }
            return;
          }
          if (event.textnode) {
            alert(invitationText ? "邀请链接解析失败" : "连接失败");
            event.textnode.textContent = "输入联机地址";
          }
        });
      };
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          connect2(e);
        }
      });
      ui.window.appendChild(node);
      ui.ipnode = node;
      const text = event.textnode;
      Object.assign(text.style, {
        width: "400px",
        height: "30px",
        lineHeight: "30px",
        fontFamily: "xinwei",
        fontSize: "30px",
        padding: "10px",
        left: "calc(50% - 200px)",
        top: "calc(50% - 80px)",
        textAlign: "center"
      });
      ui.window.appendChild(text);
      ui.iptext = text;
      const button = ui.create.div(".menubutton.highlight.large.pointerdiv", "连接", connect2);
      Object.assign(button.style, {
        width: "70px",
        left: "calc(50% - 35px)",
        top: "calc(50% + 60px)"
      });
      ui.window.appendChild(button);
      ui.ipbutton = button;
      ui.hall_button = ui.create.system(
        "联机大厅",
        () => {
          node.textContent = get.config("hall_ip") || lib.hallURL;
          connect2();
        },
        true
      );
      if (!get.config("hall_button")) {
        ui.hall_button.style.display = "none";
      }
      ui.recentIP = ui.create.system("最近连接", null, true);
      const clickLink = function() {
        node.textContent = this.textContent;
        connect2();
      };
      lib.setPopped(
        ui.recentIP,
        () => {
          if (!lib.config.recentIP.length) {
            return;
          }
          const uiintro = ui.create.dialog("hidden");
          uiintro.listen((e) => {
            e.stopPropagation();
          });
          const list = ui.create.div(".caption");
          for (const ip of lib.config.recentIP) {
            ui.create.div(".text.textlink", list, clickLink).textContent = get.trimip(ip);
          }
          uiintro.add(list);
          const clear = uiintro.add('<div class="text center">清除</div>');
          clear.style.paddingTop = 0;
          clear.style.paddingBottom = "3px";
          clear.listen(() => {
            lib.config.recentIP.length = 0;
            game.saveConfig("recentIP", []);
            uiintro.delete();
          });
          return uiintro;
        },
        220
      );
      if (get.config("read_clipboard", "connect")) {
        let ced = false;
        const read = (text2) => {
          if (connectionStarted) {
            return;
          }
          try {
            const text22 = text2.split("\n")[2];
            if (!text22?.startsWith("联机地址:")) {
              return;
            }
            const ip = text22.slice(5);
            if (ip.length > 0 && (ced || confirm("是否根据剪贴板的邀请链接以进入联机地址和房间？"))) {
              node.textContent = ip;
              connect2(null, text2);
            }
          } catch (e) {
            console.log(e);
          }
        };
        const promptInvite = () => {
          if (connectionStarted) {
            return;
          }
          if (confirm("是否输入邀请链接以进入联机地址和房间？")) {
            ced = true;
            game.promises.prompt("请输入邀请链接").then((text2) => {
              if (typeof text2 === "string" && text2.length > 0) {
                read(text2);
              }
            });
          }
        };
        window.focus();
        if (navigator.clipboard && lib.node) {
          navigator.clipboard.readText().then(read).catch(promptInvite);
        } else {
          const input = ui.create.node("textarea", ui.window, { opacity: "0" });
          input.select();
          const result = document.execCommand("paste");
          input.blur();
          ui.window.removeChild(input);
          if (result || input.value.length > 0) {
            read(input.value);
          } else {
            promptInvite();
          }
        }
      }
      lib.init.onfree();
    };
    createNode();
    if (!game.onlineKey) {
      game.onlineKey = localStorage.getItem(`${lib.configprefix}key`);
      if (!game.onlineKey) {
        game.onlineKey = get.id();
        localStorage.setItem(`${lib.configprefix}key`, game.onlineKey);
      }
    }
    _status.connectDenied = createNode;
    setTimeout(lib.init.onfree, 1e3);
  }
};
export {
  connect as default,
  type
};
