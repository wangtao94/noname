// Server-authoritative room client ("server room" mode).
//
// The game page is opened by the lobby shell as
//   /index.html?sa-room=<code>&sa-uid=<uid>&sa-token=<token>
// In this mode the page skips the splash/IP screen and connects straight to the game server's
// /ws/game endpoint; the engine then runs its normal online-client code path.

/**
 * @returns {{ room: string, uid: string, token: string, game: string | null } | null}
 */
export function getServerRoomParams() {
	if (typeof location === "undefined") return null;
	const params = new URLSearchParams(location.search);
	const room = params.get("sa-room");
	const uid = params.get("sa-uid");
	const token = params.get("sa-token");
	if (!room || !uid || !token) return null;
	return { room, uid, token, game: params.get("sa-game") };
}

/**
 * Apply in-memory (not saved) config overrides right after the local config is loaded.
 * @param {import("noname").Library} lib
 * @param {typeof import("noname")._status} _status
 */
export function applyServerRoomConfig(lib, _status) {
	const params = getServerRoomParams();
	if (!params) return false;
	_status.serverRoom = params;
	lib.config.mode = "connect";
	lib.config.show_splash = "off";
	lib.config.new_tutorial = true;
	return true;
}

/**
 * Connect to the room's game socket (called from the connect mode's start instead of the IP screen).
 * @param {typeof import("noname").game} game
 * @param {typeof import("noname")._status} _status
 */
export function connectServerRoom(game, _status) {
	const { room, uid, token, game: gameId } = _status.serverRoom;
	game.onlineID = uid;
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const url = `${proto}://${location.host}/ws/game?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}${gameId ? `&game=${encodeURIComponent(gameId)}` : ""}`;
	game.connect(url, success => {
		if (!success) {
			window.parent?.postMessage({ type: "noname:game-connect-failed", room }, location.origin);
		}
	});
}
