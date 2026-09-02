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
}

const CONFIG_FILE_NAME = "qwen-computer-use.json";
const CONFIG_KEYS = new Set([
	"browserExecutable",
	"userDataDir",
	"sendScreenshots",
	"startUrl",
	"allowedOrigins",
	"headless",
]);

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
	return {
		...(browserExecutable ? { browserExecutable } : {}),
		...(userDataDirValue ? { userDataDir: resolve(dirname(path), userDataDirValue) } : {}),
		...(sendScreenshots !== undefined ? { sendScreenshots } : {}),
		...(startUrl ? { startUrl } : {}),
		...(allowedOrigins ? { allowedOrigins } : {}),
		...(headless !== undefined ? { headless } : {}),
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
