// Server-side overrides that turn the engine's "relay host" into a seatless authoritative host.
//
// Legacy model: the room owner's browser is the host AND occupies seat `game.me`.
// Server model: every seat (including the engine's `game.me`) is bound to a remote client or to AI.
// `game.notMe = true` + `_status.auto = true` make `isMine()` false everywhere, so the engine takes the
// `isOnline()` (remote) or AI branch for every seat.

export function installHostOverrides({ lib, game, get, _status, ui }) {
	const serverInit = lib.message.server.init;
	lib.message.server.init = function (version, config, bannedInfo) {
		// reconnect (known player id) and in-game joins keep the legacy behaviour
		if (!_status.waitingForPlayer || (config?.id && lib.playerOL?.[config.id])) {
			return serverInit.call(this, version, config, bannedInfo);
		}
		this.onlineKey = config?.onlineKey;
		this.avatar = config?.avatar;
		this.nickname = config?.nickname || "无名玩家";
		const slot = game.connectPlayers.find(p => !p.classList.contains("unselectable2") && (!p.playerid || p === game.me) && !p.ws);
		if (!slot) {
			this.send("denied", "number");
			lib.node.clients.remove(this);
			this.closed = true;
			return;
		}
		slot.playerid = this.id;
		slot.initOL(this.nickname, this.avatar);
		slot.ws = this;
		this.send("init", this.id, lib.configOL, game.ip, false, game.roomId);
	};

	/** Same as Game#randomMapOL, but `game.me` is a regular seat that may be bound to a client. */
	game.randomMapOL = function (type) {
		if (type == "hidden") {
			ui.arena.classList.add("playerhidden");
		}
		game.prepareArena();
		const seats = game.players.slice(0);
		const clients = lib.node.clients.filter(c => !c.closed && !lib.node.observing.includes(c));
		for (const client of clients) {
			if (!seats.length) break;
			const seat = seats.randomRemove();
			seat.ws = client;
			seat.playerid = client.id;
			seat.nickname = client.nickname;
			seat.setNickname();
		}
		const map = [];
		for (const player of game.players) {
			if (!player.playerid) {
				player.playerid = get.id();
				player.nickname = "AI";
				player.setNickname();
			}
			map.push([player.playerid, player.nickname]);
			lib.playerOL[player.playerid] = player;
		}
		game.notMe = true;
		_status.auto = true;
		game.broadcast(
			function (map, config, hidden) {
				if (hidden) {
					ui.arena.classList.add("playerhidden");
				}
				lib.configOL = config;
				ui.create.players();
				ui.create.me();
				game.me.playerid = game.onlineID;
				game.me.nickname = get.connectNickname();
				for (let i = 0; i < map.length; i++) {
					if (map[i][0] == game.me.playerid) {
						map = map.concat(map.splice(0, i));
						break;
					}
				}
				for (let i = 0; i < game.players.length; i++) {
					game.players[i].playerid = map[i][0];
					game.players[i].nickname = map[i][1];
					game.players[i].setNickname();
					lib.playerOL[game.players[i].playerid] = game.players[i];
				}
				_status.mode = lib.configOL[lib.configOL.mode + "_mode"];
			},
			map,
			lib.configOL,
			type == "hidden"
		);
		_status.mode = lib.configOL[lib.configOL.mode + "_mode"];
		return game.chooseCharacterOL();
	};
}

/** Default lib.configOL for a mode: its `connect_*` option inits with the prefix stripped. */
export function defaultConfigOL(lib, mode) {
	const config = { mode };
	for (const [key, cfg] of Object.entries(lib.mode[mode]?.connect ?? {})) {
		if (key === "update" || !cfg || typeof cfg !== "object" || !("init" in cfg)) continue;
		config[key.slice(8)] = cfg.init;
	}
	config.characterPack = lib.connectCharacterPack.slice(0);
	config.cardPack = lib.connectCardPack.slice(0);
	config.banned = [];
	config.bannedcards = [];
	return config;
}
