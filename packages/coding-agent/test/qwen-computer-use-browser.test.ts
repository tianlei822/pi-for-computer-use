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
