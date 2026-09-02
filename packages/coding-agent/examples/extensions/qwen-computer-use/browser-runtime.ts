export type NormalizedCoordinate = [number, number];

export interface BrowserViewport {
	width: number;
	height: number;
}

export interface BrowserPageSummary {
	pageId: string;
	title: string;
	url: string;
	isActive: boolean;
}

export interface BrowserObservation {
	pageId: string;
	title: string;
	url: string;
	viewport: BrowserViewport;
	text: string;
	screenshot?: string;
	pages?: BrowserPageSummary[];
}

export type ComputerUseRequest =
	| { action: "screenshot" }
	| { action: "list_pages" }
	| { action: "switch_page"; pageId: string }
	| { action: "navigate"; url: string }
	| { action: "left_click" | "double_click"; coordinate: NormalizedCoordinate }
	| { action: "type"; text: string }
	| { action: "key"; keys: string[] }
	| {
			action: "scroll";
			direction: "up" | "down" | "left" | "right";
			amount: number;
			coordinate?: NormalizedCoordinate;
	  };

export interface ComputerUseBrowser {
	observe(signal?: AbortSignal): Promise<BrowserObservation>;
	execute(request: ComputerUseRequest, signal?: AbortSignal): Promise<BrowserObservation>;
	close(): Promise<void>;
}

export function scaleCoordinate(coordinate: NormalizedCoordinate, viewport: BrowserViewport): { x: number; y: number } {
	const [normalizedX, normalizedY] = coordinate;
	if (
		!Number.isFinite(normalizedX) ||
		!Number.isFinite(normalizedY) ||
		normalizedX < 0 ||
		normalizedX > 1000 ||
		normalizedY < 0 ||
		normalizedY > 1000
	) {
		throw new Error("coordinate values must be between 0 and 1000");
	}
	if (
		!Number.isFinite(viewport.width) ||
		!Number.isFinite(viewport.height) ||
		viewport.width <= 0 ||
		viewport.height <= 0
	) {
		throw new Error("browser viewport must have positive dimensions");
	}
	return {
		x: Math.round((normalizedX / 1000) * viewport.width),
		y: Math.round((normalizedY / 1000) * viewport.height),
	};
}

export function assertAllowedNavigation(rawUrl: string, allowedOrigins: ReadonlySet<string>): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("navigation URL is invalid");
	}
	if (url.username || url.password) {
		throw new Error("navigation URLs must not contain credentials");
	}
	if (url.href === "about:blank") return url;
	if (!allowedOrigins.has(url.origin)) {
		throw new Error(`navigation origin is not allowed: ${url.origin}`);
	}
	return url;
}

export function assertAllowedPageTarget(rawUrl: string, allowedOrigins: ReadonlySet<string>): URL {
	return assertAllowedNavigation(rawUrl === "" ? "about:blank" : rawUrl, allowedOrigins);
}
