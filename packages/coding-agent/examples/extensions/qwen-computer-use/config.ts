import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ComputerUseConfig {
	browserExecutable?: string;
	userDataDir?: string;
	sendScreenshots?: boolean;
	startUrl?: string;
	allowedOrigins?: string[];
	headless?: boolean;
	localCommands?: LocalCommandsConfig;
}

export interface LocalSearchConfig {
	url: string;
	queryParameter: string;
}

export interface LocalSiteConfig {
	aliases: string[];
	url: string;
	search?: LocalSearchConfig;
}

export interface LocalCommandsConfig {
	sites: LocalSiteConfig[];
}

const CONFIG_FILE_NAME = "qwen-computer-use.json";
const CONFIG_KEYS = new Set([
	"browserExecutable",
	"userDataDir",
	"sendScreenshots",
	"startUrl",
	"allowedOrigins",
	"headless",
	"localCommands",
]);
const LOCAL_COMMAND_KEYS = new Set(["sites"]);
const LOCAL_SITE_KEYS = new Set(["aliases", "url", "search"]);
const LOCAL_SEARCH_KEYS = new Set(["url", "queryParameter"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value;
}

function parseBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") throw new Error(`${field} must be a boolean`);
	if (value === "" || value === "0" || value.toLowerCase() === "false") return false;
	if (value === "1" || value.toLowerCase() === "true") return true;
	throw new Error(`${field} must be true, false, 1, or 0`);
}

function assertKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, field: string): void {
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) throw new Error(`unknown ${field} field: ${key}`);
	}
}

function parseWebUrl(value: unknown, field: string): string {
	const rawUrl = parseOptionalString(value, field);
	if (!rawUrl) throw new Error(`${field} must be a non-empty string`);
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error(`${field} must be an absolute URL`);
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
		throw new Error(`${field} must be an HTTP(S) URL without credentials`);
	}
	return url.href;
}

function parseLocalCommands(value: unknown): LocalCommandsConfig | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("localCommands must be an object");
	assertKnownKeys(value, LOCAL_COMMAND_KEYS, "localCommands");
	if (!Array.isArray(value.sites) || value.sites.length === 0) {
		throw new Error("localCommands.sites must be a non-empty array");
	}

	const seenAliases = new Set<string>();
	const sites = value.sites.map((siteValue, siteIndex): LocalSiteConfig => {
		const field = `localCommands.sites[${siteIndex}]`;
		if (!isRecord(siteValue)) throw new Error(`${field} must be an object`);
		assertKnownKeys(siteValue, LOCAL_SITE_KEYS, field);
		if (!Array.isArray(siteValue.aliases) || siteValue.aliases.length === 0) {
			throw new Error(`${field}.aliases must be a non-empty array`);
		}
		const aliases = siteValue.aliases.map((alias, aliasIndex) => {
			if (typeof alias !== "string" || alias.trim().length === 0) {
				throw new Error(`${field}.aliases[${aliasIndex}] must be a non-empty string`);
			}
			const normalizedAlias = alias.trim().toLocaleLowerCase();
			if (seenAliases.has(normalizedAlias)) throw new Error(`duplicate local command alias: ${alias.trim()}`);
			seenAliases.add(normalizedAlias);
			return alias.trim();
		});

		let search: LocalSearchConfig | undefined;
		if (siteValue.search !== undefined) {
			if (!isRecord(siteValue.search)) throw new Error(`${field}.search must be an object`);
			assertKnownKeys(siteValue.search, LOCAL_SEARCH_KEYS, `${field}.search`);
			const queryParameter = parseOptionalString(siteValue.search.queryParameter, `${field}.search.queryParameter`);
			if (!queryParameter || !/^[A-Za-z0-9_.~-]+$/.test(queryParameter)) {
				throw new Error(`${field}.search.queryParameter must be a URL query parameter name`);
			}
			search = {
				url: parseWebUrl(siteValue.search.url, `${field}.search.url`),
				queryParameter,
			};
		}

		return {
			aliases,
			url: parseWebUrl(siteValue.url, `${field}.url`),
			...(search ? { search } : {}),
		};
	});

	return { sites };
}

function parseConfigFile(path: string, required: boolean): ComputerUseConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (!required && isRecord(error) && error.code === "ENOENT") return {};
		throw new Error(`failed to read Computer Use config: ${path}`);
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		const detail = error instanceof Error ? error.message : "invalid JSON";
		throw new Error(`failed to parse Computer Use config ${path}: ${detail}`);
	}
	if (!isRecord(value)) throw new Error(`Computer Use config must be an object: ${path}`);
	for (const key of Object.keys(value)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`unknown Computer Use config field: ${key}`);
	}

	let allowedOrigins: string[] | undefined;
	if (value.allowedOrigins !== undefined) {
		if (!Array.isArray(value.allowedOrigins)) throw new Error("allowedOrigins must be an array of strings");
		allowedOrigins = value.allowedOrigins.map((origin) => {
			if (typeof origin !== "string" || origin.trim().length === 0) {
				throw new Error("allowedOrigins must contain only non-empty strings");
			}
			return origin;
		});
	}

	const browserExecutable = parseOptionalString(value.browserExecutable, "browserExecutable");
	const userDataDirValue = parseOptionalString(value.userDataDir, "userDataDir");
	const sendScreenshots = parseBoolean(value.sendScreenshots, "sendScreenshots");
	const startUrl = parseOptionalString(value.startUrl, "startUrl");
	const headless = parseBoolean(value.headless, "headless");
	const localCommands = parseLocalCommands(value.localCommands);
	return {
		...(browserExecutable ? { browserExecutable } : {}),
		...(userDataDirValue ? { userDataDir: resolve(dirname(path), userDataDirValue) } : {}),
		...(sendScreenshots !== undefined ? { sendScreenshots } : {}),
		...(startUrl ? { startUrl } : {}),
		...(allowedOrigins ? { allowedOrigins } : {}),
		...(headless !== undefined ? { headless } : {}),
		...(localCommands ? { localCommands } : {}),
	};
}

export function loadComputerUseConfig(env: NodeJS.ProcessEnv = process.env): ComputerUseConfig {
	const explicitPath = parseOptionalString(env.PI_CUA_CONFIG_PATH, "PI_CUA_CONFIG_PATH");
	const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const configPath = explicitPath || join(agentDir, CONFIG_FILE_NAME);
	const config = parseConfigFile(configPath, explicitPath !== undefined);

	const browserExecutable = parseOptionalString(env.PI_CUA_BROWSER_EXECUTABLE, "PI_CUA_BROWSER_EXECUTABLE");
	const userDataDirValue = parseOptionalString(env.PI_CUA_USER_DATA_DIR, "PI_CUA_USER_DATA_DIR");
	const sendScreenshots = parseBoolean(env.PI_CUA_SEND_SCREENSHOTS, "PI_CUA_SEND_SCREENSHOTS");
	const startUrl = parseOptionalString(env.PI_CUA_START_URL, "PI_CUA_START_URL");
	const allowedOrigins = env.PI_CUA_ALLOWED_ORIGINS?.split(",")
		.map((origin) => origin.trim())
		.filter((origin) => origin.length > 0);
	const headless = parseBoolean(env.PI_CUA_HEADLESS, "PI_CUA_HEADLESS");

	return {
		...config,
		...(browserExecutable ? { browserExecutable } : {}),
		...(userDataDirValue ? { userDataDir: resolve(userDataDirValue) } : {}),
		...(sendScreenshots !== undefined ? { sendScreenshots } : {}),
		...(startUrl ? { startUrl } : {}),
		...(allowedOrigins && allowedOrigins.length > 0 ? { allowedOrigins } : {}),
		...(headless !== undefined ? { headless } : {}),
	};
}
