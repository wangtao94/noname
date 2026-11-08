// Opt-in inspection of the real worker immediately before the opening deal.
export function install({ lib, game, get, ui }, post) {
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
