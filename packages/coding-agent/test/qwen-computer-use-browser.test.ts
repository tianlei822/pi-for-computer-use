import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChromeCdpBrowser } from "../examples/extensions/qwen-computer-use/chrome-cdp-browser.ts";

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe.runIf(process.platform === "darwin" && existsSync(CHROME_PATH))("qwen computer use Chrome integration", () => {
	let browser: ChromeCdpBrowser | undefined;
	let server: Server;
	let origin: string;

	beforeEach(async () => {
		server = createServer((request, response) => {
			if (request.url === "/elements") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(`<!doctype html>
<html>
<head><title>elements</title></head>
<body>
  <button aria-label="Change title" onclick="document.title='button-clicked'">Change title</button>
  <input aria-label="Indexed input" value="old" oninput="document.title='input:' + this.value">
  <select aria-label="Choice" onchange="document.title='select:' + this.value">
    <option value="a">Option A</option><option value="b">Option B</option>
  </select>
  <button aria-label="Open tab" onclick="window.open('/second', '_blank')">Open tab</button>
  <button aria-label="Open dialog" onclick="alert('fixture dialog')">Open dialog</button>
  <a class="result" href="/second" data-kind="fixture">Second page</a>
  <div style="height:1600px"></div>
  <p>Bottom needle text</p>
</body>
</html>`);
				return;
			}
			if (request.url === "/second") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end("<!doctype html><html><head><title>second</title></head><body>Second page</body></html>");
				return;
			}
			if (request.url === "/profile") {
				const restored = request.headers.cookie?.includes("pi-cua-profile=restored") ?? false;
				response.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					...(!restored ? { "set-cookie": "pi-cua-profile=restored; Path=/; Max-Age=3600; SameSite=Lax" } : {}),
				});
				response.end(
					`<!doctype html><html><head><title>profile:${restored ? "restored" : "new"}</title></head></html>`,
				);
				return;
			}
			if (request.url === "/delayed-navigation") {
				setTimeout(() => {
					response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
					response.end("<!doctype html><html><head><title>delayed navigation</title></head></html>");
				}, 1500);
				return;
			}
			if (request.url === "/slow-load") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.write("<!doctype html><html><head><title>slow load</title></head><body>loading");
				setTimeout(() => response.end("</body></html>"), 1500);
				return;
			}
			if (request.url === "/external-frame") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(`<!doctype html>
<html>
<head><title>external frame</title></head>
<body style="margin:0">
  <button style="width:100vw;height:100vh"
    onclick="const frame=document.createElement('iframe');frame.src='http://127.0.0.1:1/blocked';document.body.append(frame)">
    Load external frame
  </button>
</body>
</html>`);
				return;
			}
			if (request.url === "/redirect") {
				response.writeHead(302, { location: "http://127.0.0.1:1/blocked" });
				response.end();
				return;
			}
			if (request.url === "/external-link") {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(`<!doctype html>
<html>
<head><title>external link</title></head>
<body style="margin:0">
  <button style="width:100vw;height:100vh" onclick="location.href='http://127.0.0.1:1/blocked'">Leave</button>
</body>
</html>`);
				return;
			}
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(`<!doctype html>
<html>
<head><title>ready</title></head>
<body style="margin:0">
  <input autofocus aria-label="Computer Use input"
    style="box-sizing:border-box;width:100vw;height:50vh;font-size:32px"
    oninput="document.title='typed:' + this.value">
  <div style="height:50vh;background:#2457d6;color:white;font:32px sans-serif">Local fixture</div>
</body>
</html>`);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
		origin = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await browser?.close();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	});

	it("captures and controls a local page through CDP", async () => {
		browser = new ChromeCdpBrowser({
			executablePath: CHROME_PATH,
			startUrl: origin,
			allowedOrigins: [origin],
			headless: true,
			actionDelayMs: 50,
		});

		const initial = await browser.observe();
		expect(initial.url).toBe(`${origin}/`);
		expect(initial.text).toContain("Local fixture");
		expect(initial.screenshot?.length).toBeGreaterThan(1000);
		expect(initial.viewport.width).toBeGreaterThan(0);
		expect(initial.viewport.height).toBeGreaterThan(0);

		await browser.execute({ action: "left_click", coordinate: [500, 250] });
		const typed = await browser.execute({ action: "type", text: "hello" });

		expect(typed.title).toBe("typed:hello");
		expect(typed.pages).toHaveLength(1);
		expect(typed.pages?.[0]?.isActive).toBe(true);
	});

	it("returns visible page text without capturing a screenshot", async () => {
		browser = new ChromeCdpBrowser({
			executablePath: CHROME_PATH,
			startUrl: origin,
			allowedOrigins: [origin],
			headless: true,
			captureScreenshots: false,
			actionDelayMs: 50,
		});

		const observation = await browser.observe();

		expect(observation.text).toContain("Local fixture");
		expect(observation.screenshot).toBeUndefined();
	});

	it("searches page text, queries elements, finds text, waits, and goes back", async () => {
		browser = new ChromeCdpBrowser({
			executablePath: CHROME_PATH,
			startUrl: `${origin}/elements`,
			allowedOrigins: [origin],
			headless: true,
			captureScreenshots: false,
			actionDelayMs: 50,
		});

		const initial = await browser.observe();
		expect(initial.pageInfo).toMatchObject({ scrollY: 0 });
		expect(initial.pageInfo?.pagesBelow).toBeGreaterThan(1);

		const search = await browser.execute({
			action: "search_page",
			pattern: "option [ab]",
			regex: true,
			caseSensitive: false,
			contextChars: 20,
			maxResults: 10,
		});
		expect(search.actionResult).toMatchObject({ type: "search_page", total: 2 });

		const foundElements = await browser.execute({
			action: "find_elements",
			selector: "a.result",
			attributes: ["href", "data-kind"],
			includeText: true,
			maxResults: 10,
		});
		expect(foundElements.actionResult).toMatchObject({
			type: "find_elements",
			total: 1,
			elements: [{ tag: "a", text: "Second page", attributes: { href: "/second", "data-kind": "fixture" } }],
		});

		const foundText = await browser.execute({ action: "find_text", text: "Bottom needle" });
		expect(foundText.actionResult).toMatchObject({ type: "find_text", found: true });
		expect(foundText.pageInfo?.scrollY).toBeGreaterThan(0);

		const waited = await browser.execute({ action: "wait", seconds: 0 });
		expect(waited.actionResult).toEqual({ type: "wait", seconds: 0 });

		await browser.execute({ action: "navigate", url: `${origin}/second` });
		const returned = await browser.execute({ action: "go_back" });
		expect(returned.url).toBe(`${origin}/elements`);
		expect(returned.actionResult).toEqual({ type: "go_back", navigated: true });
	});

	it("uses indexed accessible elements and manages tabs and dialogs", async () => {
		browser = new ChromeCdpBrowser({
			executablePath: CHROME_PATH,
			startUrl: `${origin}/elements`,
			allowedOrigins: [origin],
			headless: true,
			captureScreenshots: false,
			actionDelayMs: 50,
		});

		const initial = await browser.observe();
		const titleButton = initial.interactiveElements?.find((element) => element.name === "Change title");
		const input = initial.interactiveElements?.find((element) => element.name === "Indexed input");
		const select = initial.interactiveElements?.find((element) => element.name === "Choice");
		const openTab = initial.interactiveElements?.find((element) => element.name === "Open tab");
		const openDialog = initial.interactiveElements?.find((element) => element.name === "Open dialog");
		expect(titleButton?.role).toBe("button");
		expect(input?.role).toBe("textbox");
		expect(select?.role).toBe("combobox");

		const clicked = await browser.execute({ action: "click_element", index: titleButton?.index ?? 0 });
		expect(clicked.title).toBe("button-clicked");

		const typed = await browser.execute({
			action: "input_element",
			index: input?.index ?? 0,
			text: "new value",
			clear: true,
		});
		expect(typed.title).toBe("input:new value");

		const selected = await browser.execute({
			action: "select_dropdown",
			index: select?.index ?? 0,
			text: "Option B",
		});
		expect(selected.title).toBe("select:b");

		const dialog = await browser.execute({ action: "click_element", index: openDialog?.index ?? 0 });
		expect(dialog.recentEvents).toContain("Dismissed JavaScript dialog: fixture dialog");

		const newTab = await browser.execute({ action: "click_element", index: openTab?.index ?? 0 });
		expect(newTab.url).toBe(`${origin}/second`);
		expect(newTab.pages).toHaveLength(2);
		const closed = await browser.execute({ action: "close_page" });
		expect(closed.url).toBe(`${origin}/elements`);
		expect(closed.actionResult).toMatchObject({ type: "close_page", closed: true });
	});

	it("preserves site data in a configured user data directory", async () => {
		const userDataDir = await mkdtemp(join(tmpdir(), "pi-cua-persistent-profile-test-"));
		try {
			browser = new ChromeCdpBrowser({
				executablePath: CHROME_PATH,
				userDataDir,
				startUrl: `${origin}/profile`,
				allowedOrigins: [origin],
				headless: true,
				actionDelayMs: 50,
			});
			expect((await browser.observe()).title).toBe("profile:new");
			await browser.close();

			browser = new ChromeCdpBrowser({
				executablePath: CHROME_PATH,
				userDataDir,
				startUrl: `${origin}/profile`,
				allowedOrigins: [origin],
				headless: true,
				actionDelayMs: 50,
			});
			expect((await browser.observe()).title).toBe("profile:restored");
		} finally {
			await browser?.close();
			browser = undefined;
			await rm(userDataDir, { recursive: true, force: true });
		}
	});

	it("blocks document redirects outside the configured origins", async () => {
		browser = new ChromeCdpBrowser({
			executablePath: CHROME_PATH,
			startUrl: origin,
			allowedOrigins: [origin],
			headless: true,
			actionDelayMs: 50,
		});
		await browser.observe();

		await expect(browser.execute({ action: "navigate", url: `${origin}/redirect` })).rejects.toThrow("not allowed");
	});

	it("returns an observation when a page remains loading past the CDP event timeout", async () => {
		browser = new ChromeCdpBrowser({
			executablePath: CHROME_PATH,
			startUrl: origin,
			allowedOrigins: [origin],
			headless: true,
			actionDelayMs: 50,
			requestTimeoutMs: 1000,
		});
		await browser.observe();

		const observation = await browser.execute({ action: "navigate", url: `${origin}/slow-load` });

		expect(observation.url).toBe(`${origin}/slow-load`);
		expect(observation.title).toBe("slow load");
		expect(observation.screenshot?.length).toBeGreaterThan(1000);
	});

	it("handles the event timeout while Page.navigate is still pending", async () => {
		browser = new ChromeCdpBrowser({
			executablePath: CHROME_PATH,
			startUrl: origin,
			allowedOrigins: [origin],
			headless: true,
			actionDelayMs: 50,
			requestTimeoutMs: 1000,
		});
		await browser.observe();

		await expect(browser.execute({ action: "navigate", url: `${origin}/delayed-navigation` })).rejects.toThrow(
			"CDP request timed out: Page.navigate",
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 600));
	});

	it("blocks click-triggered navigation outside the configured origins", async () => {
		browser = new ChromeCdpBrowser({
			executablePath: CHROME_PATH,
			startUrl: `${origin}/external-link`,
			allowedOrigins: [origin],
			headless: true,
			actionDelayMs: 50,
		});
		await browser.observe();

		await expect(browser.execute({ action: "left_click", coordinate: [500, 500] })).rejects.toThrow("not allowed");
	});

	it("does not treat cross-origin subframes as top-level navigation", async () => {
		browser = new ChromeCdpBrowser({
			executablePath: CHROME_PATH,
			startUrl: `${origin}/external-frame`,
			allowedOrigins: [origin],
			headless: true,
			actionDelayMs: 50,
		});

		await browser.observe();
		const observation = await browser.execute({ action: "left_click", coordinate: [500, 500] });

		expect(observation.title).toBe("external frame");
		expect(observation.url).toBe(`${origin}/external-frame`);
	});
});
