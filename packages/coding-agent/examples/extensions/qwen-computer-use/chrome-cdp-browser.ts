import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertAllowedNavigation,
	type BrowserObservation,
	type BrowserPageSummary,
	type BrowserViewport,
	type ComputerUseBrowser,
	type ComputerUseRequest,
	scaleCoordinate,
} from "./browser-runtime.ts";

interface ChromeCdpBrowserOptions {
	executablePath?: string;
	userDataDir?: string;
	captureScreenshots?: boolean;
	startUrl?: string;
	allowedOrigins?: Iterable<string>;
	headless?: boolean;
	actionDelayMs?: number;
	requestTimeoutMs?: number;
}

interface CdpTarget {
	id: string;
	title: string;
	url: string;
	webSocketDebuggerUrl: string;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
	signal?: AbortSignal;
	abortHandler?: () => void;
}

type CdpEventHandler = (params: unknown) => void;

class CdpEventTimeoutError extends Error {
	readonly method: string;

	constructor(method: string) {
		super(`CDP event timed out: ${method}`);
		this.name = "CdpEventTimeoutError";
		this.method = method;
	}
}

const DEFAULT_ALLOWED_ORIGINS = ["http://127.0.0.1", "http://localhost"];
const DEFAULT_ACTION_DELAY_MS = 300;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_WINDOW_SIZE = "1280,720";
const MAX_PAGE_TEXT_CHARS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function requirePositiveNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a positive number`);
	}
	return value;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const finish = (error?: unknown) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => finish(signal?.reason);
		const timer = setTimeout(() => finish(), milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeAllowedOrigins(origins: Iterable<string>): Set<string> {
	const normalized = new Set<string>();
	for (const rawOrigin of origins) {
		let url: URL;
		try {
			url = new URL(rawOrigin);
		} catch {
			throw new Error(`invalid allowed origin: ${rawOrigin}`);
		}
		if (url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
			throw new Error(`invalid allowed origin: ${rawOrigin}`);
		}
		normalized.add(url.origin);
	}
	return normalized;
}

async function discoverChromeExecutable(): Promise<string> {
	const candidates =
		process.platform === "darwin"
			? [
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
					"/Applications/Chromium.app/Contents/MacOS/Chromium",
				]
			: process.platform === "win32"
				? [
						join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
						join(
							process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
							"Google/Chrome/Application/chrome.exe",
						),
					]
				: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	throw new Error("Chrome executable not found; set PI_CUA_BROWSER_EXECUTABLE");
}

class CdpClient {
	private readonly socket: WebSocket;
	private readonly timeoutMs: number;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly eventHandlers = new Map<string, Set<CdpEventHandler>>();
	private nextId = 1;

	private constructor(socket: WebSocket, timeoutMs: number) {
		this.socket = socket;
		this.timeoutMs = timeoutMs;
		this.socket.addEventListener("message", (event) => {
			void this.handleMessage(event.data);
		});
		this.socket.addEventListener("close", () => this.rejectPending(new Error("CDP connection closed")));
		this.socket.addEventListener("error", () => this.rejectPending(new Error("CDP connection failed")));
	}

	static async connect(url: string, timeoutMs: number, signal?: AbortSignal): Promise<CdpClient> {
		const socket = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error("CDP connection timed out")), timeoutMs);
			const onOpen = () => finish();
			const onError = () => finish(new Error("CDP connection failed"));
			const onAbort = () =>
				finish(signal?.reason instanceof Error ? signal.reason : new Error("CDP connection aborted"));
			const finish = (error?: Error) => {
				clearTimeout(timer);
				socket.removeEventListener("open", onOpen);
				socket.removeEventListener("error", onError);
				signal?.removeEventListener("abort", onAbort);
				if (error) {
					socket.close();
					reject(error);
				} else {
					resolve();
				}
			};
			socket.addEventListener("open", onOpen);
			socket.addEventListener("error", onError);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		return new CdpClient(socket, timeoutMs);
	}

	async send(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
		signal?.throwIfAborted();
		if (this.socket.readyState !== WebSocket.OPEN) throw new Error("CDP connection is not open");
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const abortHandler = () =>
				this.finish(id, signal?.reason instanceof Error ? signal.reason : new Error("CDP request aborted"));
			const timer = setTimeout(() => this.finish(id, new Error(`CDP request timed out: ${method}`)), this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer, signal, abortHandler });
			signal?.addEventListener("abort", abortHandler, { once: true });
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close(): void {
		this.socket.close();
	}

	on(method: string, handler: CdpEventHandler): () => void {
		const handlers = this.eventHandlers.get(method) ?? new Set<CdpEventHandler>();
		handlers.add(handler);
		this.eventHandlers.set(method, handlers);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.eventHandlers.delete(method);
		};
	}

	waitForEvent(method: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error: Error | undefined, params?: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				dispose();
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve(params);
			};
			const onAbort = () =>
				finish(signal?.reason instanceof Error ? signal.reason : new Error(`CDP event aborted: ${method}`));
			const dispose = this.on(method, (params) => finish(undefined, params));
			const timer = setTimeout(() => finish(new CdpEventTimeoutError(method)), timeoutMs);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private finish(id: number, error: Error | undefined, value?: unknown): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.abortHandler) pending.signal?.removeEventListener("abort", pending.abortHandler);
		if (error) pending.reject(error);
		else pending.resolve(value);
	}

	private rejectPending(error: Error): void {
		for (const id of this.pending.keys()) this.finish(id, error);
	}

	private async handleMessage(data: unknown): Promise<void> {
		let text: string;
		if (typeof data === "string") text = data;
		else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
		else if (data instanceof Blob) text = await data.text();
		else return;

		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			return;
		}
		if (!isRecord(payload)) return;
		if (typeof payload.method === "string") {
			for (const handler of this.eventHandlers.get(payload.method) ?? []) handler(payload.params);
			return;
		}
		if (typeof payload.id !== "number") return;
		if (payload.error !== undefined) {
			const error =
				isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : "CDP error";
			this.finish(payload.id, new Error(error));
			return;
		}
		this.finish(payload.id, undefined, payload.result);
	}
}

export class ChromeCdpBrowser implements ComputerUseBrowser {
	private readonly executablePath: string | undefined;
	private readonly userDataDir: string | undefined;
	private readonly captureScreenshots: boolean;
	private readonly startUrl: URL;
	private readonly allowedOrigins: ReadonlySet<string>;
	private readonly headless: boolean;
	private readonly actionDelayMs: number;
	private readonly requestTimeoutMs: number;
	private process: ChildProcess | undefined;
	private profileDir: string | undefined;
	private profileDirIsTemporary = false;
	private endpoint: string | undefined;
	private selectedPageId: string | undefined;
	private starting: Promise<void> | undefined;

	constructor(options: ChromeCdpBrowserOptions = {}) {
		this.executablePath = options.executablePath;
		this.userDataDir = options.userDataDir;
		this.captureScreenshots = options.captureScreenshots ?? true;
		this.allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
		this.startUrl = assertAllowedNavigation(options.startUrl ?? "about:blank", this.allowedOrigins);
		this.headless = options.headless ?? false;
		this.actionDelayMs = options.actionDelayMs ?? DEFAULT_ACTION_DELAY_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	async observe(signal?: AbortSignal): Promise<BrowserObservation> {
		await this.ensureStarted(signal);
		const targets = await this.listTargets(signal);
		for (const candidate of targets) assertAllowedNavigation(candidate.url, this.allowedOrigins);
		const target = this.selectTarget(targets);
		return this.capture(target, targets, signal);
	}

	async execute(request: ComputerUseRequest, signal?: AbortSignal): Promise<BrowserObservation> {
		signal?.throwIfAborted();
		await this.ensureStarted(signal);

		if (request.action === "screenshot" || request.action === "list_pages") return this.observe(signal);
		if (request.action === "switch_page") {
			const targets = await this.listTargets(signal);
			const target = targets.find((candidate) => candidate.id === request.pageId);
			if (!target) throw new Error(`unknown pageId: ${request.pageId}`);
			assertAllowedNavigation(target.url, this.allowedOrigins);
			await this.withClient(target, signal, (client) => client.send("Page.bringToFront", {}, signal));
			this.selectedPageId = target.id;
			return this.observe(signal);
		}

		const targets = await this.listTargets(signal);
		const target = this.selectTarget(targets);
		assertAllowedNavigation(target.url, this.allowedOrigins);
		await this.withClient(target, signal, async (client) => {
			if (request.action === "navigate") {
				const url = assertAllowedNavigation(request.url, this.allowedOrigins);
				await this.navigate(client, url, signal);
				return;
			}
			await this.withNavigationGuard(
				client,
				async () => {
					if (request.action === "type") {
						await client.send("Input.insertText", { text: request.text }, signal);
						return;
					}
					if (request.action === "key") {
						await this.pressKeys(client, request.keys, signal);
						return;
					}

					const viewport = await this.readViewport(client, signal);
					if (request.action === "left_click" || request.action === "double_click") {
						const { x, y } = scaleCoordinate(request.coordinate, viewport);
						const clickCount = request.action === "double_click" ? 2 : 1;
						await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, signal);
						await client.send(
							"Input.dispatchMouseEvent",
							{ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount },
							signal,
						);
						await client.send(
							"Input.dispatchMouseEvent",
							{ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount },
							signal,
						);
						return;
					}
					if (request.action !== "scroll") throw new Error(`unsupported computer use action: ${request.action}`);
					const coordinate = request.coordinate ?? [500, 500];
					const { x, y } = scaleCoordinate(coordinate, viewport);
					const horizontal = request.direction === "left" || request.direction === "right";
					const sign = request.direction === "up" || request.direction === "left" ? -1 : 1;
					await client.send(
						"Input.dispatchMouseEvent",
						{
							type: "mouseWheel",
							x,
							y,
							deltaX: horizontal ? request.amount * sign : 0,
							deltaY: horizontal ? 0 : request.amount * sign,
						},
						signal,
					);
				},
				false,
				signal,
			);
		});

		const finalTargets = await this.listTargets(signal);
		for (const candidate of finalTargets) assertAllowedNavigation(candidate.url, this.allowedOrigins);
		return this.observe(signal);
	}

	async close(): Promise<void> {
		const child = this.process;
		this.process = undefined;
		this.endpoint = undefined;
		this.selectedPageId = undefined;
		if (child && child.exitCode === null) {
			child.kill("SIGTERM");
			await Promise.race([
				new Promise<void>((resolve) => child.once("exit", () => resolve())),
				new Promise<void>((resolve) => setTimeout(resolve, 2000)),
			]);
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		const profileDir = this.profileDir;
		const profileDirIsTemporary = this.profileDirIsTemporary;
		this.profileDir = undefined;
		this.profileDirIsTemporary = false;
		if (profileDir && profileDirIsTemporary) await rm(profileDir, { recursive: true, force: true });
	}

	private async ensureStarted(signal?: AbortSignal): Promise<void> {
		if (this.endpoint) return;
		this.starting ??= this.launch(signal);
		try {
			await this.starting;
		} catch (error) {
			await this.close();
			throw error;
		} finally {
			this.starting = undefined;
		}
	}

	private async launch(signal?: AbortSignal): Promise<void> {
		const executablePath = this.executablePath ?? (await discoverChromeExecutable());
		try {
			await access(executablePath, constants.X_OK);
		} catch {
			throw new Error(`Chrome executable is not usable: ${executablePath}`);
		}
		if (this.userDataDir) {
			await mkdir(this.userDataDir, { recursive: true });
			this.profileDir = this.userDataDir;
			this.profileDirIsTemporary = false;
		} else {
			this.profileDir = await mkdtemp(join(tmpdir(), "pi-cua-chrome-"));
			this.profileDirIsTemporary = true;
		}
		const args = [
			"--remote-debugging-address=127.0.0.1",
			"--remote-debugging-port=0",
			`--user-data-dir=${this.profileDir}`,
			`--window-size=${DEFAULT_WINDOW_SIZE}`,
			"--force-device-scale-factor=1",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			"--metrics-recording-only",
			"--password-store=basic",
			...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
			...(this.headless ? ["--headless=new"] : []),
			"about:blank",
		];
		this.process = spawn(executablePath, args, { stdio: "ignore" });
		let launchError: Error | undefined;
		this.process.once("error", (error) => {
			launchError = error;
		});

		const activePortPath = join(this.profileDir, "DevToolsActivePort");
		const deadline = Date.now() + this.requestTimeoutMs;
		while (Date.now() < deadline) {
			signal?.throwIfAborted();
			if (launchError) throw new Error(`Chrome failed to start: ${launchError.message}`);
			if (this.process.exitCode !== null) throw new Error(`Chrome exited during startup: ${this.process.exitCode}`);
			let portLine: string;
			try {
				[portLine] = (await readFile(activePortPath, "utf8")).trim().split("\n");
			} catch {
				await sleep(50, signal);
				continue;
			}
			const port = Number(portLine);
			if (!Number.isInteger(port) || port <= 0 || port > 65535) {
				await sleep(50, signal);
				continue;
			}
			const endpoint = `http://127.0.0.1:${port}`;
			try {
				const response = await fetch(`${endpoint}/json/version`, {
					signal: requestSignal(signal, Math.min(this.requestTimeoutMs, 1000)),
				});
				if (!response.ok) {
					await sleep(50, signal);
					continue;
				}
			} catch {
				await sleep(50, signal);
				continue;
			}
			this.endpoint = endpoint;
			await this.waitForPage(signal);
			if (this.startUrl.href !== "about:blank") {
				const target = this.selectTarget(await this.listTargets(signal));
				await this.withClient(target, signal, (client) => this.navigate(client, this.startUrl, signal));
				const finalTarget = this.selectTarget(await this.listTargets(signal));
				assertAllowedNavigation(finalTarget.url, this.allowedOrigins);
			}
			return;
		}
		await this.close();
		throw new Error("Chrome DevTools endpoint did not start in time");
	}

	private async waitForPage(signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + this.requestTimeoutMs;
		while (Date.now() < deadline) {
			const targets = await this.listTargets(signal);
			if (targets.length > 0) {
				this.selectedPageId = targets[0].id;
				return;
			}
			await sleep(50, signal);
		}
		throw new Error("Chrome did not create a page target");
	}

	private async listTargets(signal?: AbortSignal): Promise<CdpTarget[]> {
		if (!this.endpoint) throw new Error("Chrome is not started");
		const response = await fetch(`${this.endpoint}/json/list`, {
			signal: requestSignal(signal, this.requestTimeoutMs),
		});
		if (!response.ok) throw new Error(`Chrome target discovery failed: HTTP ${response.status}`);
		const payload: unknown = await response.json();
		if (!Array.isArray(payload)) throw new Error("Chrome target discovery returned a non-array payload");
		const targets: CdpTarget[] = [];
		for (const entry of payload) {
			if (!isRecord(entry) || entry.type !== "page") continue;
			if (
				typeof entry.id !== "string" ||
				typeof entry.title !== "string" ||
				typeof entry.url !== "string" ||
				typeof entry.webSocketDebuggerUrl !== "string"
			) {
				continue;
			}
			targets.push({
				id: entry.id,
				title: entry.title,
				url: entry.url,
				webSocketDebuggerUrl: entry.webSocketDebuggerUrl,
			});
		}
		return targets;
	}

	private selectTarget(targets: CdpTarget[]): CdpTarget {
		if (targets.length === 0) throw new Error("Chrome has no page targets");
		const selected = targets.find((target) => target.id === this.selectedPageId) ?? targets[0];
		this.selectedPageId = selected.id;
		return selected;
	}

	private async capture(target: CdpTarget, targets: CdpTarget[], signal?: AbortSignal): Promise<BrowserObservation> {
		return this.withClient(target, signal, async (client) => {
			await client.send("Page.enable", {}, signal);
			const viewport = await this.readViewport(client, signal);
			const evaluated = requireRecord(
				await client.send(
					"Runtime.evaluate",
					{ expression: "document.body?.innerText ?? ''", returnByValue: true },
					signal,
				),
				"Runtime.evaluate result",
			);
			const remoteResult = requireRecord(evaluated.result, "Runtime.evaluate remote result");
			const text = typeof remoteResult.value === "string" ? remoteResult.value.slice(0, MAX_PAGE_TEXT_CHARS) : "";
			let screenshot: string | undefined;
			if (this.captureScreenshots) {
				const result = requireRecord(
					await client.send(
						"Page.captureScreenshot",
						{ format: "jpeg", quality: 80, fromSurface: true, captureBeyondViewport: false },
						signal,
					),
					"Page.captureScreenshot result",
				);
				screenshot = requireString(result.data, "Page.captureScreenshot data");
			}
			const freshTargets = await this.listTargets(signal);
			for (const candidate of freshTargets) assertAllowedNavigation(candidate.url, this.allowedOrigins);
			const freshTarget = freshTargets.find((candidate) => candidate.id === target.id) ?? target;
			const pages: BrowserPageSummary[] = freshTargets.map((page) => ({
				pageId: page.id,
				title: page.title,
				url: page.url,
				isActive: page.id === this.selectedPageId,
			}));
			return {
				pageId: freshTarget.id,
				title: freshTarget.title,
				url: freshTarget.url,
				viewport,
				text,
				...(screenshot ? { screenshot } : {}),
				pages:
					pages.length > 0
						? pages
						: targets.map((page) => ({
								pageId: page.id,
								title: page.title,
								url: page.url,
								isActive: page.id === this.selectedPageId,
							})),
			};
		});
	}

	private async readViewport(client: CdpClient, signal?: AbortSignal): Promise<BrowserViewport> {
		const metrics = requireRecord(
			await client.send("Page.getLayoutMetrics", {}, signal),
			"Page.getLayoutMetrics result",
		);
		const viewport = requireRecord(metrics.cssVisualViewport ?? metrics.cssLayoutViewport, "CSS viewport");
		return {
			width: requirePositiveNumber(viewport.clientWidth, "viewport width"),
			height: requirePositiveNumber(viewport.clientHeight, "viewport height"),
		};
	}

	private async withClient<T>(
		target: CdpTarget,
		signal: AbortSignal | undefined,
		operation: (client: CdpClient) => Promise<T>,
	): Promise<T> {
		const client = await CdpClient.connect(target.webSocketDebuggerUrl, this.requestTimeoutMs, signal);
		try {
			return await operation(client);
		} finally {
			client.close();
		}
	}

	private async navigate(client: CdpClient, url: URL, signal?: AbortSignal): Promise<void> {
		await this.withNavigationGuard(
			client,
			async () => {
				await client.send("Page.navigate", { url: url.href }, signal);
			},
			true,
			signal,
		);
	}

	private async withNavigationGuard(
		client: CdpClient,
		operation: () => Promise<void>,
		waitForLoad: boolean,
		signal?: AbortSignal,
	): Promise<void> {
		let blockedError: Error | undefined;
		let unblock: (() => void) | undefined;
		let mainFrameId: string | undefined;
		const blocked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const pausedRequests: Promise<unknown>[] = [];
		const dispose = client.on("Fetch.requestPaused", (params) => {
			try {
				const event = requireRecord(params, "Fetch.requestPaused params");
				const requestId = requireString(event.requestId, "Fetch requestId");
				const request = requireRecord(event.request, "Fetch request");
				const requestUrl = requireString(request.url, "Fetch request URL");
				const frameId = requireString(event.frameId, "Fetch frameId");
				if (frameId !== mainFrameId) {
					pausedRequests.push(client.send("Fetch.continueRequest", { requestId }, signal));
					return;
				}
				assertAllowedNavigation(requestUrl, this.allowedOrigins);
				pausedRequests.push(client.send("Fetch.continueRequest", { requestId }, signal));
			} catch (error) {
				blockedError = error instanceof Error ? error : new Error("document navigation was blocked");
				const event = isRecord(params) ? params : {};
				if (typeof event.requestId === "string") {
					pausedRequests.push(
						client.send(
							"Fetch.failRequest",
							{ requestId: event.requestId, errorReason: "BlockedByClient" },
							signal,
						),
					);
				}
				unblock?.();
			}
		});
		const waitController = new AbortController();
		const waitSignal = signal ? AbortSignal.any([signal, waitController.signal]) : waitController.signal;
		try {
			await client.send("Page.enable", {}, signal);
			const frameTreeResponse = requireRecord(await client.send("Page.getFrameTree", {}, signal), "frame tree");
			const frameTree = requireRecord(frameTreeResponse.frameTree, "frame tree root");
			const mainFrame = requireRecord(frameTree.frame, "main frame");
			mainFrameId = requireString(mainFrame.id, "main frame id");
			await client.send(
				"Fetch.enable",
				{ patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] },
				signal,
			);
			let completed: Promise<{ status: "completed" } | { status: "failed"; error: unknown }> | undefined;
			if (waitForLoad) {
				await client.send("Page.stopLoading", {}, signal);
				completed = client.waitForEvent("Page.domContentEventFired", this.requestTimeoutMs, waitSignal).then(
					() => ({ status: "completed" as const }),
					(error: unknown) => ({ status: "failed" as const, error }),
				);
			}
			await operation();
			completed ??= sleep(this.actionDelayMs, waitSignal).then(
				() => ({ status: "completed" as const }),
				(error: unknown) => ({ status: "failed" as const, error }),
			);
			const result = await Promise.race([completed, blocked.then(() => ({ status: "completed" as const }))]);
			if (result.status === "failed") {
				const { error } = result;
				if (
					!(waitForLoad && error instanceof CdpEventTimeoutError && error.method === "Page.domContentEventFired")
				) {
					throw error;
				}
			}
			waitController.abort();
			await Promise.all(pausedRequests);
		} finally {
			waitController.abort();
			dispose();
			try {
				await client.send("Fetch.disable", {}, signal);
			} catch {}
		}
		if (blockedError) {
			await client.send("Page.navigate", { url: "about:blank" }, signal);
			throw blockedError;
		}
	}

	private async pressKeys(client: CdpClient, keys: string[], signal?: AbortSignal): Promise<void> {
		const modifiers = new Map<string, number>([
			["ALT", 1],
			["CTRL", 2],
			["CONTROL", 2],
			["META", 4],
			["CMD", 4],
			["SHIFT", 8],
		]);
		let mask = 0;
		const held: { key: string; code: string; virtualKeyCode: number; modifier: number }[] = [];
		for (const rawKey of keys) {
			const normalized = rawKey.trim().toUpperCase();
			const modifier = modifiers.get(normalized);
			if (modifier) {
				mask |= modifier;
				const key =
					normalized === "CMD"
						? "Meta"
						: normalized === "CTRL"
							? "Control"
							: normalized[0] + normalized.slice(1).toLowerCase();
				const virtualKeyCode = modifier === 1 ? 18 : modifier === 2 ? 17 : modifier === 4 ? 91 : 16;
				const code = `${key}Left`;
				held.push({ key, code, virtualKeyCode, modifier });
				await client.send(
					"Input.dispatchKeyEvent",
					{ type: "rawKeyDown", key, code, windowsVirtualKeyCode: virtualKeyCode, modifiers: mask },
					signal,
				);
				continue;
			}
			const key = this.describeKey(rawKey);
			await client.send(
				"Input.dispatchKeyEvent",
				{
					type: "rawKeyDown",
					key: key.key,
					code: key.code,
					windowsVirtualKeyCode: key.virtualKeyCode,
					modifiers: mask,
				},
				signal,
			);
			await client.send(
				"Input.dispatchKeyEvent",
				{
					type: "keyUp",
					key: key.key,
					code: key.code,
					windowsVirtualKeyCode: key.virtualKeyCode,
					modifiers: mask,
				},
				signal,
			);
		}
		for (const modifier of held.reverse()) {
			mask &= ~modifier.modifier;
			await client.send(
				"Input.dispatchKeyEvent",
				{
					type: "keyUp",
					key: modifier.key,
					code: modifier.code,
					windowsVirtualKeyCode: modifier.virtualKeyCode,
					modifiers: mask,
				},
				signal,
			);
		}
	}

	private describeKey(rawKey: string): { key: string; code: string; virtualKeyCode: number } {
		const normalized = rawKey.trim().toUpperCase();
		const special = new Map<string, { key: string; code: string; virtualKeyCode: number }>([
			["ENTER", { key: "Enter", code: "Enter", virtualKeyCode: 13 }],
			["TAB", { key: "Tab", code: "Tab", virtualKeyCode: 9 }],
			["ESC", { key: "Escape", code: "Escape", virtualKeyCode: 27 }],
			["ESCAPE", { key: "Escape", code: "Escape", virtualKeyCode: 27 }],
			["BACKSPACE", { key: "Backspace", code: "Backspace", virtualKeyCode: 8 }],
			["DELETE", { key: "Delete", code: "Delete", virtualKeyCode: 46 }],
			["ARROWLEFT", { key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 }],
			["ARROWUP", { key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38 }],
			["ARROWRIGHT", { key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 }],
			["ARROWDOWN", { key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40 }],
			["SPACE", { key: " ", code: "Space", virtualKeyCode: 32 }],
		]);
		const known = special.get(normalized);
		if (known) return known;
		if (rawKey.length !== 1 || !/^[a-zA-Z0-9]$/.test(rawKey)) throw new Error(`unsupported browser key: ${rawKey}`);
		const upper = rawKey.toUpperCase();
		return {
			key: rawKey,
			code: /[A-Z]/.test(upper) ? `Key${upper}` : `Digit${upper}`,
			virtualKeyCode: upper.charCodeAt(0),
		};
	}
}
