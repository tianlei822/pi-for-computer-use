import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertAllowedNavigation,
	assertAllowedPageTarget,
	type BrowserObservation,
	type ComputerUseBrowser,
	type ComputerUseRequest,
	scaleCoordinate,
} from "../examples/extensions/qwen-computer-use/browser-runtime.ts";
import { loadComputerUseConfig } from "../examples/extensions/qwen-computer-use/config.ts";
import {
	createComputerUseTool,
	createInitialObservationMessage,
	isManualVerificationDetails,
	isManualVerificationObservation,
	retainLatestComputerUseScreenshot,
} from "../examples/extensions/qwen-computer-use/tool.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";

const observation: BrowserObservation = {
	pageId: "page-1",
	title: "Fixture",
	url: "http://127.0.0.1:4321/fixture",
	viewport: { width: 1280, height: 720 },
	text: "Local fixture",
	screenshot: "c2NyZWVuc2hvdA==",
};

const textOnlyObservation: BrowserObservation = {
	pageId: "page-1",
	title: "Fixture",
	url: "http://127.0.0.1:4321/fixture",
	viewport: { width: 1280, height: 720 },
	text: "Local fixture",
};

const baiduVerificationObservation: BrowserObservation = {
	pageId: "page-1",
	title: "百度安全验证",
	url: "https://wappass.baidu.com/static/captcha/tuxing_v2.html?backurl=https%3A%2F%2Fwww.baidu.com%2Fs",
	viewport: { width: 1280, height: 720 },
	text: "请完成下方验证后继续操作",
};

const googleVerificationObservation: BrowserObservation = {
	pageId: "page-1",
	title: "Sorry...",
	url: "https://www.google.com/sorry/index?continue=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dweather",
	viewport: { width: 1280, height: 720 },
	text: "Our systems have detected unusual traffic from your computer network.",
};

class FakeBrowser implements ComputerUseBrowser {
	readonly requests: ComputerUseRequest[] = [];

	async observe(): Promise<BrowserObservation> {
		return observation;
	}

	async execute(request: ComputerUseRequest): Promise<BrowserObservation> {
		this.requests.push(request);
		return observation;
	}

	async close(): Promise<void> {}
}

describe("qwen computer use contract", () => {
	it("loads browser settings from the agent config file", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-cua-config-test-"));
		try {
			await writeFile(
				join(agentDir, "qwen-computer-use.json"),
				JSON.stringify({
					userDataDir: "browser-profile",
					sendScreenshots: false,
					startUrl: "https://www.baidu.com",
					allowedOrigins: ["https://www.baidu.com", "https://example.com"],
					headless: true,
				}),
			);

			expect(loadComputerUseConfig({ PI_CODING_AGENT_DIR: agentDir })).toEqual({
				userDataDir: join(agentDir, "browser-profile"),
				sendScreenshots: false,
				startUrl: "https://www.baidu.com",
				allowedOrigins: ["https://www.baidu.com", "https://example.com"],
				headless: true,
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("lets environment variables override the Computer Use config file", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-cua-config-test-"));
		try {
			await writeFile(
				join(agentDir, "qwen-computer-use.json"),
				JSON.stringify({
					userDataDir: "file-profile",
					sendScreenshots: false,
					startUrl: "https://example.com",
					allowedOrigins: ["https://example.com"],
					headless: false,
				}),
			);

			expect(
				loadComputerUseConfig({
					PI_CODING_AGENT_DIR: agentDir,
					PI_CUA_USER_DATA_DIR: join(agentDir, "env-profile"),
					PI_CUA_SEND_SCREENSHOTS: "true",
					PI_CUA_START_URL: "https://www.baidu.com",
					PI_CUA_ALLOWED_ORIGINS: "https://www.baidu.com,https://example.com",
					PI_CUA_HEADLESS: "true",
				}),
			).toEqual({
				userDataDir: join(agentDir, "env-profile"),
				sendScreenshots: true,
				startUrl: "https://www.baidu.com",
				allowedOrigins: ["https://www.baidu.com", "https://example.com"],
				headless: true,
			});
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("rejects unknown Computer Use config fields", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-cua-config-test-"));
		try {
			await writeFile(
				join(agentDir, "qwen-computer-use.json"),
				JSON.stringify({ allowOrigins: ["https://x.test"] }),
			);

			expect(() => loadComputerUseConfig({ PI_CODING_AGENT_DIR: agentDir })).toThrow(
				"unknown Computer Use config field: allowOrigins",
			);
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("loads as an explicit Pi extension", async () => {
		const extensionPath = fileURLToPath(
			new URL("../examples/extensions/qwen-computer-use/index.ts", import.meta.url),
		);
		const result = await loadExtensions([extensionPath], process.cwd());

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.tools.has("computer_use")).toBe(true);
	});

	it("scales normalized Qwen coordinates to the local CSS viewport", () => {
		expect(scaleCoordinate([500, 250], { width: 1280, height: 720 })).toEqual({ x: 640, y: 180 });
	});

	it("allows configured origins and rejects other navigation targets", () => {
		const allowedOrigins = new Set(["http://127.0.0.1:4321"]);

		expect(assertAllowedNavigation("http://127.0.0.1:4321/fixture", allowedOrigins).href).toBe(
			"http://127.0.0.1:4321/fixture",
		);
		expect(() => assertAllowedNavigation("https://example.com", allowedOrigins)).toThrow("not allowed");
		expect(() => assertAllowedNavigation("http://user:pass@127.0.0.1:4321", allowedOrigins)).toThrow("credentials");
	});

	it("treats a transient empty Chrome page target as about:blank", () => {
		const allowedOrigins = new Set(["http://127.0.0.1:4321"]);

		expect(assertAllowedPageTarget("", allowedOrigins).href).toBe("about:blank");
		expect(() => assertAllowedNavigation("", allowedOrigins)).toThrow("invalid");
	});

	it("registers a sequential tool and returns a fresh screenshot", async () => {
		const browser = new FakeBrowser();
		const tool = createComputerUseTool(async () => browser);

		expect(tool.name).toBe("computer_use");
		expect(tool.executionMode).toBe("sequential");

		const result = await tool.execute(
			"call-1",
			{ action: "left_click", coordinate: [500, 250] },
			undefined,
			undefined,
			{} as never,
		);

		expect(browser.requests).toEqual([{ action: "left_click", coordinate: [500, 250] }]);
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					ok: true,
					action: "left_click",
					pageId: "page-1",
					title: "Fixture",
					url: "http://127.0.0.1:4321/fixture",
					viewport: { width: 1280, height: 720 },
					pageText: "Local fixture",
				}),
			},
			{ type: "image", data: "c2NyZWVuc2hvdA==", mimeType: "image/jpeg" },
		]);
	});

	it("normalizes migrated Browser Use actions before execution", async () => {
		const browser = new FakeBrowser();
		const tool = createComputerUseTool(async () => browser);
		const calls = [
			{ action: "go_back" as const },
			{ action: "close_page" as const, pageId: "page-2" },
			{ action: "wait" as const, seconds: 2 },
			{ action: "find_text" as const, text: "needle" },
			{ action: "search_page" as const, pattern: "price" },
			{ action: "find_elements" as const, selector: "a.result", attributes: ["href"] },
			{ action: "click_element" as const, index: 4 },
			{ action: "input_element" as const, index: 5, text: "hello" },
			{ action: "select_dropdown" as const, index: 6, text: "Option B" },
		];

		for (const [index, params] of calls.entries()) {
			await tool.execute(`migrated-${index}`, params, undefined, undefined, {} as never);
		}

		expect(browser.requests).toEqual([
			{ action: "go_back" },
			{ action: "close_page", pageId: "page-2" },
			{ action: "wait", seconds: 2 },
			{ action: "find_text", text: "needle" },
			{
				action: "search_page",
				pattern: "price",
				regex: false,
				caseSensitive: false,
				contextChars: 150,
				maxResults: 25,
			},
			{
				action: "find_elements",
				selector: "a.result",
				attributes: ["href"],
				includeText: true,
				maxResults: 50,
			},
			{ action: "click_element", index: 4 },
			{ action: "input_element", index: 5, text: "hello", clear: true },
			{ action: "select_dropdown", index: 6, text: "Option B" },
		]);
	});

	it("returns indexed elements, page metrics, browser events, and action data", async () => {
		const browser = new FakeBrowser();
		browser.execute = async (request) => {
			browser.requests.push(request);
			return {
				...textOnlyObservation,
				interactiveElements: [
					{
						index: 7,
						role: "button",
						name: "Submit",
						bounds: { x: 10, y: 20, width: 80, height: 30 },
					},
				],
				pageInfo: {
					scrollX: 0,
					scrollY: 720,
					contentWidth: 1280,
					contentHeight: 2160,
					pagesAbove: 1,
					pagesBelow: 1,
				},
				recentEvents: ["Opened a new tab"],
				actionResult: { type: "find_text", found: true, text: "needle" },
			};
		};
		const tool = createComputerUseTool(async () => browser);

		const result = await tool.execute(
			"rich-observation",
			{ action: "find_text", text: "needle" },
			undefined,
			undefined,
			{} as never,
		);
		const payload = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");

		expect(payload).toMatchObject({
			interactiveElements: [{ index: 7, role: "button", name: "Submit" }],
			pageInfo: { pagesAbove: 1, pagesBelow: 1 },
			recentEvents: ["Opened a new tab"],
			actionResult: { type: "find_text", found: true, text: "needle" },
		});
	});

	it("warns when the same action leaves the browser state unchanged", async () => {
		const browser = new FakeBrowser();
		const tool = createComputerUseTool(async () => browser);
		let payload: Record<string, unknown> = {};

		for (let index = 0; index < 5; index++) {
			const result = await tool.execute(
				`stalled-${index}`,
				{ action: "scroll", direction: "down", amount: 500 },
				undefined,
				undefined,
				{} as never,
			);
			payload = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");
		}

		expect(payload.progressWarning).toContain("repeated");
		expect(payload.progressWarning).toContain("browser state has not changed");
	});

	it("rejects incomplete actions before they reach the browser", async () => {
		const browser = new FakeBrowser();
		const tool = createComputerUseTool(async () => browser);

		await expect(tool.execute("call-2", { action: "left_click" }, undefined, undefined, {} as never)).rejects.toThrow(
			"coordinate",
		);
		expect(browser.requests).toEqual([]);
		await expect(
			tool.execute("call-3", { action: "click_element" }, undefined, undefined, {} as never),
		).rejects.toThrow("index");
		await expect(
			tool.execute("call-4", { action: "find_elements" }, undefined, undefined, {} as never),
		).rejects.toThrow("selector");
	});

	it("detects Baidu and Google manual verification pages", () => {
		expect(isManualVerificationObservation(baiduVerificationObservation)).toBe(true);
		expect(isManualVerificationObservation(googleVerificationObservation)).toBe(true);
		expect(
			isManualVerificationObservation({
				...googleVerificationObservation,
				title: "weather - Google Search",
				url: "https://www.google.com/search?q=weather",
			}),
		).toBe(false);
		expect(isManualVerificationObservation(observation)).toBe(false);
	});

	it("blocks automated input while Baidu manual verification is pending", async () => {
		const browser = new FakeBrowser();
		browser.observe = async () => baiduVerificationObservation;
		const tool = createComputerUseTool(async () => browser);

		const result = await tool.execute(
			"call-verification",
			{ action: "left_click", coordinate: [188, 581] },
			undefined,
			undefined,
			{} as never,
		);

		expect(browser.requests).toEqual([]);
		expect(result.details).toMatchObject({ manualVerificationRequired: true, blocked: true });
		expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}")).toMatchObject({
			ok: false,
			blocked: true,
			manualVerificationRequired: true,
		});
	});

	it("blocks automated input while Google manual verification is pending", async () => {
		const browser = new FakeBrowser();
		browser.observe = async () => googleVerificationObservation;
		const tool = createComputerUseTool(async () => browser);

		const result = await tool.execute(
			"call-google-verification",
			{ action: "type", text: "weather" },
			undefined,
			undefined,
			{} as never,
		);

		expect(browser.requests).toEqual([]);
		expect(result.details).toMatchObject({ manualVerificationRequired: true, blocked: true });
		expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}")).toMatchObject({
			ok: false,
			blocked: true,
			manualVerificationRequired: true,
		});
	});

	it("marks a Baidu challenge reached after an action for manual verification", async () => {
		const browser = new FakeBrowser();
		browser.execute = async (request) => {
			browser.requests.push(request);
			return baiduVerificationObservation;
		};
		const tool = createComputerUseTool(async () => browser);

		const result = await tool.execute(
			"call-search",
			{ action: "key", key: "Enter" },
			undefined,
			undefined,
			{} as never,
		);

		expect(browser.requests).toEqual([{ action: "key", keys: ["Enter"] }]);
		expect(isManualVerificationDetails(result.details)).toBe(true);
		expect(JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}")).toMatchObject({
			ok: false,
			manualVerificationRequired: true,
		});
	});

	it("injects the initial local screenshot as a hidden user-context message", () => {
		expect(createInitialObservationMessage(observation)).toEqual({
			customType: "computer-use-observation",
			display: false,
			details: {
				pageId: "page-1",
				title: "Fixture",
				url: "http://127.0.0.1:4321/fixture",
				viewport: { width: 1280, height: 720 },
				pageText: "Local fixture",
			},
			content: [
				{
					type: "text",
					text: JSON.stringify({
						message: "Current local browser observation.",
						pageId: "page-1",
						title: "Fixture",
						url: "http://127.0.0.1:4321/fixture",
						viewport: { width: 1280, height: 720 },
						pageText: "Local fixture",
					}),
				},
				{ type: "image", data: "c2NyZWVuc2hvdA==", mimeType: "image/jpeg" },
			],
		});
	});

	it("returns browser text without an image when screenshots are disabled", async () => {
		const browser = new FakeBrowser();
		browser.observe = async () => textOnlyObservation;
		const tool = createComputerUseTool(async () => browser);

		const initial = createInitialObservationMessage(textOnlyObservation);
		expect(initial.content).toHaveLength(1);
		expect(initial.content[0]?.type).toBe("text");

		const result = await tool.execute("call-text", { action: "screenshot" }, undefined, undefined, {} as never);
		expect(result.content).toEqual([
			{
				type: "text",
				text: JSON.stringify({
					ok: true,
					action: "screenshot",
					pageId: "page-1",
					title: "Fixture",
					url: "http://127.0.0.1:4321/fixture",
					viewport: { width: 1280, height: 720 },
					pageText: "Local fixture",
				}),
			},
		]);
	});

	it("sends only the latest Computer Use screenshot to the model", () => {
		const messages = [
			{
				role: "custom" as const,
				customType: "computer-use-observation",
				content: [
					{ type: "text" as const, text: "initial state" },
					{ type: "image" as const, data: "initial-image", mimeType: "image/jpeg" as const },
				],
				display: false,
				timestamp: 1,
			},
			{
				role: "user" as const,
				content: [{ type: "image" as const, data: "user-image", mimeType: "image/png" as const }],
				timestamp: 2,
			},
			{
				role: "toolResult" as const,
				toolCallId: "call-1",
				toolName: "computer_use",
				content: [
					{ type: "text" as const, text: "latest state" },
					{ type: "image" as const, data: "latest-image", mimeType: "image/jpeg" as const },
				],
				isError: false,
				timestamp: 3,
			},
		];

		const filtered = retainLatestComputerUseScreenshot(messages);

		expect(filtered[0]).toMatchObject({ content: [{ type: "text", text: "initial state" }] });
		expect(filtered[1]).toMatchObject({
			content: [{ type: "image", data: "user-image", mimeType: "image/png" }],
		});
		expect(filtered[2]).toMatchObject({
			content: [
				{ type: "text", text: "latest state" },
				{ type: "image", data: "latest-image", mimeType: "image/jpeg" },
			],
		});
	});

	it("drops historical Computer Use screenshots when the latest state is text-only", () => {
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "call-1",
				toolName: "computer_use",
				content: [
					{ type: "text" as const, text: "old state" },
					{ type: "image" as const, data: "old-image", mimeType: "image/jpeg" as const },
				],
				isError: false,
				timestamp: 1,
			},
			{
				role: "custom" as const,
				customType: "computer-use-observation",
				content: [{ type: "text" as const, text: "current text state" }],
				display: false,
				timestamp: 2,
			},
		];

		const filtered = retainLatestComputerUseScreenshot(messages);

		expect(filtered[0]).toMatchObject({ content: [{ type: "text", text: "old state" }] });
		expect(filtered[1]).toMatchObject({ content: [{ type: "text", text: "current text state" }] });
	});
});
