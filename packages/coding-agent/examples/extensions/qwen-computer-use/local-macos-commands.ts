import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { LocalMacosCommandsConfig } from "./config.ts";

export type LocalMacosAction =
	| { action: "replace_focused_input"; text: string }
	| { action: "insert_focused_input"; text: string }
	| { action: "clear_focused_input" }
	| { action: "activate_application"; bundleId: string }
	| { action: "cycle_window"; direction: "next" | "previous" };

type RunCommand = ExtensionAPI["exec"];

const REQUEST_PREFIX = "(?:(?:请帮我|麻烦帮我|帮我|麻烦|请)\\s*)?";
const MAX_INPUT_LENGTH = 2000;
const COMMAND_TIMEOUT_MS = 5000;

const FOCUSED_INPUT_PATTERNS: ReadonlyArray<{
	pattern: RegExp;
	action: "replace_focused_input" | "insert_focused_input";
}> = [
	{ pattern: /^\/input\s+replace\s+([\s\S]+)$/iu, action: "replace_focused_input" },
	{ pattern: /^\/input\s+insert\s+([\s\S]+)$/iu, action: "insert_focused_input" },
	{
		pattern: new RegExp(
			`^${REQUEST_PREFIX}(?:把|将)\\s*(?:当前|现在)?\\s*(?:焦点)?\\s*(?:输入框|输入)(?:内容)?\\s*(?:改成|修改为|替换为|设为)\\s*([\\s\\S]+)$`,
			"u",
		),
		action: "replace_focused_input",
	},
	{
		pattern: new RegExp(
			`^${REQUEST_PREFIX}(?:修改|替换|重写|设置)\\s*(?:当前|现在|焦点)?\\s*(?:输入框|输入)(?:内容)?\\s*(?:为|成)\\s*([\\s\\S]+)$`,
			"u",
		),
		action: "replace_focused_input",
	},
	{
		pattern: new RegExp(
			`^${REQUEST_PREFIX}(?:在|往)\\s*(?:当前|焦点)\\s*(?:输入框|输入)(?:中|里)?\\s*(?:输入|填写|插入)\\s*([\\s\\S]+)$`,
			"u",
		),
		action: "insert_focused_input",
	},
];
const CLEAR_INPUT_PATTERN = new RegExp(
	`^${REQUEST_PREFIX}(?:清空|清除)\\s*(?:当前|焦点)?\\s*(?:输入框|输入)(?:内容)?$`,
	"u",
);
const NEXT_WINDOW_PATTERN = new RegExp(`^${REQUEST_PREFIX}(?:(?:切换到?)?下一个窗口|切换窗口)$`, "u");
const PREVIOUS_WINDOW_PATTERN = new RegExp(`^${REQUEST_PREFIX}(?:(?:切换到?)?上一个窗口)$`, "u");

const FOCUSED_INPUT_SCRIPT = `on run argv
	tell application "System Events"
		if UI elements enabled is false then error "Accessibility permission is required" number 1000
		set frontProcess to first application process whose frontmost is true
		set focusedElement to value of attribute "AXFocusedUIElement" of frontProcess
		set operationName to item 1 of argv
		if operationName is "clear" then
			set value of attribute "AXValue" of focusedElement to ""
		else if operationName is "replace" then
			set value of attribute "AXValue" of focusedElement to item 2 of argv
		else if operationName is "insert" then
			set value of attribute "AXSelectedText" of focusedElement to item 2 of argv
		end if
	end tell
end run`;

const CYCLE_WINDOW_SCRIPT = `on run argv
	tell application "System Events"
		if UI elements enabled is false then error "Accessibility permission is required" number 1000
		if item 1 of argv is "next" then
			key code 50 using {command down}
		else
			key code 50 using {command down, shift down}
		end if
	end tell
end run`;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function focusedInputAction(input: string): LocalMacosAction | undefined {
	for (const { pattern, action } of FOCUSED_INPUT_PATTERNS) {
		const text = pattern.exec(input)?.[1]?.trim();
		if (text && text.length <= MAX_INPUT_LENGTH) return { action, text };
	}
	return undefined;
}

export function createLocalMacosCommandMatcher(
	config: LocalMacosCommandsConfig | undefined,
): (text: string) => LocalMacosAction | undefined {
	if (!config) return () => undefined;
	const applications = config.applications
		.flatMap((application) => application.aliases.map((alias) => ({ alias, application })))
		.sort((left, right) => right.alias.length - left.alias.length)
		.map(({ alias, application }) => ({
			pattern: new RegExp(
				`^(?:/app\\s+${escapeRegExp(alias)}|${REQUEST_PREFIX}(?:切换到|转到|回到|打开)\\s*(?:应用\\s*)?${escapeRegExp(alias)}(?:\\s*应用)?)$`,
				"iu",
			),
			bundleId: application.bundleId,
		}));

	return (text) => {
		const input = text.trim();
		if (!input) return undefined;
		const focusedInput = focusedInputAction(input);
		if (focusedInput) return focusedInput;
		const command = input.replace(/[。！]$/u, "").trimEnd();
		if (/^\/input\s+clear$/iu.test(command) || CLEAR_INPUT_PATTERN.test(command)) {
			return { action: "clear_focused_input" };
		}
		if (/^\/window\s+next$/iu.test(command) || NEXT_WINDOW_PATTERN.test(command)) {
			return { action: "cycle_window", direction: "next" };
		}
		if (/^\/window\s+previous$/iu.test(command) || PREVIOUS_WINDOW_PATTERN.test(command)) {
			return { action: "cycle_window", direction: "previous" };
		}
		for (const application of applications) {
			if (application.pattern.test(command)) {
				return { action: "activate_application", bundleId: application.bundleId };
			}
		}
		return undefined;
	};
}

export function matchLocalMacosCommand(
	text: string,
	config: LocalMacosCommandsConfig | undefined,
): LocalMacosAction | undefined {
	return createLocalMacosCommandMatcher(config)(text);
}

export function createMacosSystemExecutor(
	runCommand: RunCommand,
	platform: NodeJS.Platform = process.platform,
): (action: LocalMacosAction) => Promise<void> {
	return async (action) => {
		if (platform !== "darwin") throw new Error("local system commands require macOS");
		let result: Awaited<ReturnType<RunCommand>>;
		if (action.action === "activate_application") {
			result = await runCommand("open", ["-b", action.bundleId], { timeout: COMMAND_TIMEOUT_MS });
		} else if (action.action === "cycle_window") {
			result = await runCommand("osascript", ["-e", CYCLE_WINDOW_SCRIPT, action.direction], {
				timeout: COMMAND_TIMEOUT_MS,
			});
		} else {
			const operation =
				action.action === "clear_focused_input"
					? "clear"
					: action.action.startsWith("replace")
						? "replace"
						: "insert";
			const args = ["-e", FOCUSED_INPUT_SCRIPT, operation];
			if ("text" in action) args.push(action.text);
			result = await runCommand("osascript", args, { timeout: COMMAND_TIMEOUT_MS });
		}
		if (result.code === 0 && !result.killed) return;
		if (/assistive access|accessibility permission|1000|-1719/i.test(result.stderr)) {
			throw new Error("Accessibility permission is required");
		}
		if (/not authorized to send apple events|-1743/i.test(result.stderr)) {
			throw new Error("Automation permission for System Events is required");
		}
		throw new Error(`macOS system action failed with exit code ${result.code}`);
	};
}

export function createLocalMacosInputHandler(
	config: LocalMacosCommandsConfig | undefined,
	execute: (action: LocalMacosAction) => Promise<void>,
): (event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult> {
	const matchCommand = createLocalMacosCommandMatcher(config);
	return async (event, ctx) => {
		if (event.source === "extension" || event.images?.length || !ctx.isIdle()) return { action: "continue" };
		const action = matchCommand(event.text);
		if (!action) return { action: "continue" };
		try {
			await execute(action);
			ctx.ui.notify("Completed local macOS command without a model.", "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Local macOS command failed: ${message}`, "error");
		}
		return { action: "handled" };
	};
}
