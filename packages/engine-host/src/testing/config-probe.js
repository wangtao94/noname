// Opt-in inspection of the real worker immediately before the opening deal.
export function install({ lib, game, get, ui, _status }, post) {
	const offered = [];
	const record = (player, dialog) => {
		if (!Array.isArray(dialog)) return;
		for (const part of dialog) {
			if (Array.isArray(part) && ["character", "characterx"].includes(part[1]) && Array.isArray(part[0])) {
				offered.push({ seat: player.playerid, identity: player.identity, candidates: [...part[0]], alternatives: Object.fromEntries(part[0].map(id => [id, [...(lib.characterReplace[id] ?? [id])]])) });
			}
		}
	};
	const chooseButton = lib.element.player.chooseButton;
	lib.element.player.chooseButton = function (...args) {
		const next = chooseButton.apply(this, args);
		const set = next.set;
		const player = this;
		next.set = function (key, value) {
			if (key === "createDialog") record(player, value);
			return set.call(this, key, value);
		};
		return next;
	};
	const chooseButtonOL = lib.element.player.chooseButtonOL;
	lib.element.player.chooseButtonOL = function (list, ...args) {
		for (const [player, dialog] of list) record(player, dialog);
		return chooseButtonOL.call(this, list, ...args);
	};
	const draw = lib.element.content.gameDraw;
	lib.element.content.gameDraw = async function (...args) {
		get.cards(0);
		const signature = card => JSON.stringify([card.suit, card.number, card.name, card.nature || ""]);
		const fromTuple = tuple => signature({ suit: tuple[0], number: tuple[1], name: tuple[2] === "huosha" || tuple[2] === "leisha" ? "sha" : tuple[2], nature: tuple[2] === "huosha" ? "fire" : tuple[2] === "leisha" ? "thunder" : tuple[3] });
		post({
			t: "log",
			args: [
				"config-selftest",
				JSON.stringify({
					config: lib.configOL,
					offered,
					characterlist: _status.characterlist,
					standard: Object.keys(lib.characterPack.standard),
					seats: game.players.map(p => p.playerid),
					chosen: game.players.flatMap(p => [p.name1 || p.name, p.name2].filter(Boolean)),
					pile: [...ui.cardPile.childNodes].map(signature),
					packCards: Object.fromEntries(lib.connectCardPack.map(id => [id, (lib.cardPackList[id] ?? []).map(fromTuple)])),
				}),
			],
		});
		lib.element.content.gameDraw = draw;
		return draw.apply(this, args);
	};
}
