/** Lobby-only preset marker. Start with engine defaults; these overrides keep standard-only
 * eight-seat games approachable and leave enough distinct characters for every candidate list. */
export function beginnerPreset(defaults: Record<string, unknown>): Record<string, unknown> {
	return {
		...defaults,
		preset: "beginner",
		identity_mode: "normal",
		characterPack: ["standard"],
		cardPack: ["standard", "extra"],
		banned: [],
		bannedcards: [],
		change_card: false,
		double_character: false,
		choice_zhu: 3,
		choice_zhong: 3,
		choice_fan: 3,
		choice_nei: 3,
	};
}
