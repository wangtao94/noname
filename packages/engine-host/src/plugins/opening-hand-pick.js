import { parentPort } from "node:worker_threads";

const identities = ["zhu", "zhong", "fan", "nei"];
const normalized = identity => identities.includes(identity) ? identity : "fan";

/** Budget counts every seat; ties reduce nei, fan, zhong, zhu. */
export function defaultGroups({ identities: seats, startCount, pileSize }) {
	const groups = { zhu: 2, zhong: 2, fan: 2, nei: 3 };
	const counts = Object.fromEntries(identities.map(id => [id, seats.filter(seat => normalized(seat) === id).length]));
	const cost = () => identities.reduce((sum, id) => sum + counts[id] * groups[id] * startCount, 0);
	while (cost() > Math.floor(pileSize * 0.6)) {
		const candidates = ["nei", "fan", "zhong", "zhu"].filter(id => counts[id] && groups[id] > 1);
		candidates.sort((a, b) => groups[b] - groups[a]);
		if (!candidates.length) break;
		groups[candidates[0]]--;
	}
	return groups;
}

export function bestGroup(groups, player, get) {
	const scores = groups.map(cards => cards.reduce((sum, card) => sum + (Number(get.value(card, player)) || 0), 0));
	return scores.indexOf(Math.max(...scores));
}

// Sent as source to the client: keep this function free of module closures.
function chooseRemote(groups, labels, best, timeout) {
	const dialog = ui.create.dialog("开局手牌：请选择一组", "hidden");
	for (let i = 0; i < groups.length; i++) {
		dialog.addText(labels[i]);
		dialog.add(groups[i]);
	}
	dialog.open();
	const previousTimer = game.me.forceCountChoose;
	game.me.forceCountChoose = { ...previousTimer, chooseControl: timeout };
	const next = game.me.chooseControl(labels).set("dialog", dialog).set("choice", best).set("openingHandPick", true);
	next.forResult().then(() => {
		dialog.close();
		game.me.forceCountChoose = previousTimer;
	});
	game.resume();
}

export async function chooseGroup(current, groups, config, engine) {
	const fallback = () => bestGroup(groups, current, engine.get);
	if (groups.length === 1 || !current.isOnline()) return fallback();
	const labels = groups.map((_, index) => `第${index + 1}组`);
	return new Promise(resolve => {
		let timer;
		current.wait(result => {
			clearTimeout(timer);
			const index = labels.indexOf(result?.control);
			resolve(index < 0 ? fallback() : index);
			return false;
		});
		// Replace the engine's generic timeout (which disconnects the seat) with this choice's timeout.
		clearTimeout(engine.lib.node.torespondtimeout[current.playerid]);
		timer = setTimeout(() => {
			current.send(() => { if (_status.event?.name === "chooseControl" && _status.event.openingHandPick) { _status.event.result = { control: "ai" }; game.resume(); } });
			current.unwait("ai");
		}, Number(config.timeout) * 1000);
		current.send(chooseRemote, groups, labels, fallback(), Number(config.timeout));
	});
}

function allCards(game, ui) {
	return [...ui.cardPile.childNodes, ...ui.discardPile.childNodes, ...game.players.flatMap(player => player.getCards("h"))];
}

export default {
	id: "opening-hand-pick",
	name: "开局手牌 N 组选 1",
	modes: ["identity"],
	enabledByDefault: true,
	options: [
		...identities.map((id, index) => ({ key: `n_${id}`, name: `${["主公", "忠臣", "反贼", "内奸"][index]}手牌组数`, init: "auto", item: { auto: "自动", 1: "1（关闭）", 2: "2", 3: "3", 4: "4", 5: "5" } })),
		{ key: "timeout", name: "开局选牌时限", init: "15", item: { 10: "10秒", 15: "15秒", 30: "30秒" } },
	],
	setup(engine, config) {
		const { lib, game, get, _status, ui } = engine;
		const original = lib.element.content.gameDraw;
		lib.element.content.gameDraw = async function (event, trigger, player) {
			if (!_status.connectMode || _status.brawl?.noGameDraw) return original.call(this, event, trigger, player);
			// The engine materializes the initial pile lazily on the first get.cards call.
			get.cards(0);
			const before = allCards(game, ui);
			const targets = event.targets;
			const count = current => typeof event.num === "function" ? event.num(current) : event.num;
			const defaults = defaultGroups({ identities: targets.map(p => p.identity), startCount: Math.max(0, ...targets.map(count)), pileSize: ui.cardPile.childNodes.length });
			const oldPile = event.otherPile;
			const deals = [];
			let current = player;
			do {
				if (targets.includes(current)) {
					const id = normalized(current.identity);
					const setting = config[`n_${id}`];
					let n = setting === "auto" ? defaults[id] : Math.max(1, Math.min(5, Number(setting) || 1));
					const num = count(current);
					// Candidate groups come from the normal draw pile; original gameDraw still
					// applies opening tags and any extra draws when it receives the selected group.
					if (n > 1 && num > 0) {
						const remaining = targets.filter(p => !deals.some(d => d.player === p) && p !== current).reduce((sum, p) => sum + count(p), 0);
						n = Math.min(n, Math.max(1, Math.floor((ui.cardPile.childNodes.length - remaining) / num)));
						if (n > 1) deals.push({ player: current, num, groups: Array.from({ length: n }, () => get.cards(num)) });
					}
				}
				current = current.next;
			} while (current !== player);
			const choices = await Promise.all(deals.map(deal => chooseGroup(deal.player, deal.groups, config, engine)));
			const returned = [];
			event.otherPile = { ...oldPile };
			deals.forEach((deal, index) => {
				const selected = deal.groups[choices[index]];
				returned.push(...deal.groups.filter((_, i) => i !== choices[index]).flat());
				event.otherPile[deal.player.playerid] = { ...oldPile?.[deal.player.playerid], getCards: () => selected };
			});
			if (returned.length) {
				// Shuffle with the engine's randomSort and move through its pile API. This is not a
				// discard wash: avoid incrementing shuffleNumber or triggering wash skills at setup.
				await game.cardsGotoPile([...ui.cardPile.childNodes, ...returned].randomSort());
			}
			try {
				await original.call(this, event, trigger, player);
			} finally {
				event.otherPile = oldPile;
			}
			if (process.env.NONAME_PLUGIN_SELFTEST === "1") {
				const after = allCards(game, ui);
				parentPort?.postMessage({ t: "log", args: ["selftest", JSON.stringify({
					before: before.length, after: after.length, unique: new Set(after).size,
					conserved: before.every(card => after.includes(card)),
					hands: targets.map(p => ({ actual: p.countCards("h"), expected: count(p) })),
					groups: deals.map((deal, index) => ({ identity: deal.player.identity, n: deal.groups.length, selected: choices[index] })),
				})] });
			}
		};
	},
};
