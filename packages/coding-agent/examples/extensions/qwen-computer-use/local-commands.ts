import type { ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { ComputerUseBrowser, ComputerUseRequest } from "./browser-runtime.ts";
import type { LocalCommandsConfig, LocalSiteConfig } from "./config.ts";
import { isManualVerificationObservation } from "./tool.ts";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const LOCAL_COMMAND_DICTIONARY = {
	requestPrefixes: ["请帮我", "麻烦帮我", "帮我", "麻烦", "请"],
	openVerbs: ["打开", "访问", "进入", "前往", "去"],
	searchVerbs: ["搜索", "搜", "查找", "查询", "查", "检索", "找"],
	searchParticles: ["一下"],
	siteSuffixes: ["网站", "网页", "官网"],
} as const;

function dictionaryPattern(values: readonly string[]): string {
	return [...values]
		.sort((left, right) => right.length - left.length)
		.map(escapeRegExp)
		.join("|");
}

function createSearchRequest(site: LocalSiteConfig, query: string): ComputerUseRequest | undefined {
	if (!site.search) return undefined;
	const url = new URL(site.search.url);
	url.searchParams.set(site.search.queryParameter, query);
	return { action: "navigate", url: url.href };
}

export function createLocalBrowserCommandMatcher(
	config: LocalCommandsConfig | undefined,
): (text: string) => ComputerUseRequest | undefined {
	if (!config) return () => undefined;
	const prefix = `(?:(?:${dictionaryPattern(LOCAL_COMMAND_DICTIONARY.requestPrefixes)})\\s*)?`;
	const openVerb = dictionaryPattern(LOCAL_COMMAND_DICTIONARY.openVerbs);
	const searchVerb = dictionaryPattern(LOCAL_COMMAND_DICTIONARY.searchVerbs);
	const searchParticle = dictionaryPattern(LOCAL_COMMAND_DICTIONARY.searchParticles);
	const siteSuffix = dictionaryPattern(LOCAL_COMMAND_DICTIONARY.siteSuffixes);
	const openRules: Array<{ pattern: RegExp; site: LocalSiteConfig }> = [];
	const searchRules: Array<{ pattern: RegExp; site: LocalSiteConfig }> = [];
	const aliases = (config.sites ?? [])
		.flatMap((site) => site.aliases.map((alias) => ({ alias, site })))
		.sort((left, right) => right.alias.length - left.alias.length);

	for (const { alias, site } of aliases) {
		const escapedAlias = escapeRegExp(alias);
		openRules.push(
			{ pattern: new RegExp(`^/open\\s+${escapedAlias}$`, "iu"), site },
			{ pattern: new RegExp(`^(?:open|visit)\\s+${escapedAlias}$`, "iu"), site },
			{
				pattern: new RegExp(
					`^${prefix}(?:${openVerb})(?:\\s*(?:${searchParticle}))?\\s*${escapedAlias}(?:\\s*(?:${siteSuffix}))?$`,
					"iu",
				),
				site,
			},
		);
		if (site.search) {
			searchRules.push(
				{ pattern: new RegExp(`^(?:/search|search)\\s+${escapedAlias}\\s+(.+)$`, "iu"), site },
				{ pattern: new RegExp(`^${prefix}${escapedAlias}\\s*(?:${searchParticle})\\s*(.+)$`, "iu"), site },
				{
					pattern: new RegExp(
						`^${prefix}(?:在\\s*${escapedAlias}\\s*(?:上\\s*)?|用\\s*${escapedAlias}\\s*)(?:${searchVerb})(?:\\s*(?:${searchParticle}))?\\s*(.+)$`,
						"iu",
					),
					site,
				},
				{
					pattern: new RegExp(
						`^${prefix}${escapedAlias}\\s*(?:${searchVerb})(?:\\s*(?:${searchParticle}))?\\s*(.+)$`,
						"iu",
					),
					site,
				},
			);
		}
	}

	return (text) => {
		const command = text
			.trim()
			.replace(/[。！]$/u, "")
			.trimEnd();
		if (!command) return undefined;
		for (const rule of openRules) {
			if (rule.pattern.test(command)) return { action: "navigate", url: new URL(rule.site.url).href };
		}
		for (const rule of searchRules) {
			const query = rule.pattern.exec(command)?.[1]?.trim();
			if (query) return createSearchRequest(rule.site, query);
		}
		return undefined;
	};
}

export function matchLocalBrowserCommand(
	text: string,
	config: LocalCommandsConfig | undefined,
): ComputerUseRequest | undefined {
	return createLocalBrowserCommandMatcher(config)(text);
}

export function createLocalBrowserInputHandler(
	config: LocalCommandsConfig | undefined,
	getBrowser: () => Promise<ComputerUseBrowser>,
): (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult> {
	const matchCommand = createLocalBrowserCommandMatcher(config);
	return async (event, ctx) => {
		if (event.source === "extension" || event.images?.length || !ctx.isIdle()) return { action: "continue" };
		const request = matchCommand(event.text);
		if (!request) return { action: "continue" };

		try {
			const observation = await (await getBrowser()).execute(request);
			if (isManualVerificationObservation(observation)) {
				ctx.ui.notify("Local browser command reached a manual verification page.", "warning");
			} else {
				ctx.ui.notify(`Opened locally without a model: ${observation.title || observation.url}`, "info");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Local browser command failed: ${message}`, "error");
		}

		return { action: "handled" };
	};
}
