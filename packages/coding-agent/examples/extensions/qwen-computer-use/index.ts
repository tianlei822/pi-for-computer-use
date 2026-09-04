import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ComputerUseBrowser } from "./browser-runtime.ts";
import { ChromeCdpBrowser } from "./chrome-cdp-browser.ts";
import { type ComputerUseConfig, loadComputerUseConfig } from "./config.ts";
import { createLocalBrowserInputHandler } from "./local-commands.ts";
import {
	createComputerUseTool,
	createInitialObservationMessage,
	isManualVerificationDetails,
	retainLatestComputerUseScreenshot,
} from "./tool.ts";

function createBrowser(config: ComputerUseConfig): ComputerUseBrowser {
	return new ChromeCdpBrowser({
		...(config.browserExecutable ? { executablePath: config.browserExecutable } : {}),
		...(config.userDataDir ? { userDataDir: config.userDataDir } : {}),
		...(config.sendScreenshots !== undefined ? { captureScreenshots: config.sendScreenshots } : {}),
		...(config.startUrl ? { startUrl: config.startUrl } : {}),
		...(config.allowedOrigins ? { allowedOrigins: config.allowedOrigins } : {}),
		...(config.headless !== undefined ? { headless: config.headless } : {}),
	});
}

export default function qwenComputerUse(pi: ExtensionAPI) {
	const config = loadComputerUseConfig();
	let browser: ComputerUseBrowser | undefined;
	const getBrowser = async () => {
		browser ??= createBrowser(config);
		return browser;
	};

	pi.registerTool(createComputerUseTool(getBrowser));
	pi.on("input", createLocalBrowserInputHandler(config.localCommands, getBrowser));
	pi.on("tool_result", (event) => {
		if (event.toolName === "computer_use" && isManualVerificationDetails(event.details)) {
			return { isError: true };
		}
	});

	pi.on("context", (event) => ({
		messages: retainLatestComputerUseScreenshot(event.messages),
	}));

	pi.on("before_agent_start", async () => {
		const observation = await (await getBrowser()).observe();
		return { message: createInitialObservationMessage(observation) };
	});

	pi.on("session_shutdown", async () => {
		const activeBrowser = browser;
		browser = undefined;
		await activeBrowser?.close();
	});
}
