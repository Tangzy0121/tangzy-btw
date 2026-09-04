/**
 * tangzy-btw —— KimiCode 式 /btw 侧问扩展(pi 用户级)
 *
 * 设计参考 MoonshotAI/kimi-cli PR #1743;底部 overlay 面板(不接管终端),
 * markdown 流式渲染,面板内多轮追问,只读主会话快照,绝不污染主 transcript。
 *
 * 纯逻辑见 ./tangzy-btw/lib.ts(可 node --test 单测)。
 */

import {
	estimateTokens,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	Markdown,
	Text,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildMessages,
	charTokenEstimate,
	DEFAULT_CONTEXT_TOKEN_BUDGET,
	extractMessages,
	packContext,
	SIDE_SYSTEM_PROMPT,
	type SideTurn,
} from "./tangzy-btw/lib.ts";

// ---------- 模块级侧线状态(进程内存,退出即焚) ----------

/** 一条侧问对话:标题(先截断兜底,首答后模型生成摘要)+ 轮次 */
interface SideConvo {
	title: string;
	turns: SideTurn[];
	createdAt: number;
}

interface SideState {
	convos: SideConvo[];
	active: number;
	streaming: boolean;
	abort?: AbortController;
	/** busy 提示的一次性标记(渲染后清除) */
	busyNotice: boolean;
	/** 本轮发问起点(渲染耗时用) */
	startedAt: number;
	/** 新答案到达后,下一帧渲染定位到最新一轮的开头(从上往下读),而非吸底 */
	seekLatestTurn: boolean;
}

const state: SideState = {
	convos: [{ title: "", turns: [], createdAt: Date.now() }],
	active: 0,
	streaming: false,
	busyNotice: false,
	startedAt: 0,
	seekLatestTurn: false,
};

function activeConvo(): SideConvo {
	const c = state.convos[state.active];
	if (c) return c;
	state.convos[0] = { title: "", turns: [], createdAt: Date.now() };
	state.active = 0;
	return state.convos[0];
}

// ---------- i18n 中英双语:auto = LANG/LC_ALL 环境检测(默认 en);/btw lang zh|en|auto 覆盖并持久化到 ~/.pi/agent/tangzy-btw.json ----------

type Lang = "zh" | "en";

const STRINGS = {
	en: {
		cmdDesc:
			"Side question: quick Q&A without touching the main session (bottom panel, markdown, follow-ups; /btw clear, /btw lang zh 中文)",
		welcome:
			"Ask away — this side thread never touches your main session. Type below, Enter to send.",
		thinking: (s: number) => `🤔 thinking… ${s}s (Esc to abort)`,
		header: (turns: string, modelId: string) =>
			` btw · turn ${turns} · ${modelId}`,
		scrollUp: (n: number) => ` (↑↓ scroll · ${n} lines from bottom)`,
		scrollBottom: " (↑↓ scroll · at bottom)",
		busy: " answering, hold on…",
		hints: " Enter send · Esc close · Alt+←/→ convos · ^P/^N turns",
		newConvo: "btw: new conversation started",
		historyTitle: "btw conversations",
		emptyTag: "(empty)",
		noteAborted: "[aborted]",
		noteError: "[error]",
		noOutput: "(no output)",
		noText: "(no text output)",
		toolIgnored:
			"\n\n*(the model tried to call tools — ignored; side questions never execute anything)*",
		errPrefix: "Error: ",
		unknownError: "unknown error",
		noModel: "btw: no model available",
		tuiOnly: "btw is interactive-mode only",
		cleared: "btw side thread cleared",
		langNow: (l: string) => `btw language: ${l}`,
		langSet: (l: string) => `btw language: ${l} (saved)`,
	},
	zh: {
		cmdDesc:
			"侧问:不打扰主会话的快速问答(底部面板,markdown,支持追问;/btw clear 清空,/btw lang en English)",
		welcome: "侧问不打扰主会话:直接在下方输入问题,Enter 发送。",
		thinking: (s: number) => `🤔 思考中… ${s}s(Esc 中止)`,
		header: (turns: string, modelId: string) =>
			` btw · 第 ${turns} 轮 · ${modelId}`,
		scrollUp: (n: number) => ` (↑↓ 滚动 · 距底部 ${n} 行)`,
		scrollBottom: " (↑↓ 滚动 · 已吸底)",
		busy: " 回答中,稍等…",
		hints: " Enter 发送 · Esc 关闭 · Alt+←/→ 对话 · ^P/^N 轮次",
		newConvo: "btw:已开新对话",
		historyTitle: "btw 侧问对话",
		emptyTag: "(空对话)",
		noteAborted: "[已中止]",
		noteError: "[出错]",
		noOutput: "(无输出)",
		noText: "(无文本输出)",
		toolIgnored: "\n\n*(模型尝试调用工具,已忽略——侧问不执行任何操作)*",
		errPrefix: "出错:",
		unknownError: "未知错误",
		noModel: "btw: 当前没有可用模型",
		tuiOnly: "btw 仅支持交互模式",
		cleared: "btw 侧线已清空",
		langNow: (l: string) => `btw 界面语言:${l}`,
		langSet: (l: string) => `btw 界面语言已切换为 ${l}(已保存)`,
	},
};

type Strings = (typeof STRINGS)["en"];

function detectLang(): Lang {
	const v =
		`${process.env.LANG ?? ""} ${process.env.LC_ALL ?? ""} ${process.env.LANGUAGE ?? ""}`.toLowerCase();
	return v.includes("zh") ? "zh" : "en";
}

const LANG_FILE = join(homedir(), ".pi", "agent", "tangzy-btw.json");

function loadLang(): Lang {
	try {
		const raw = JSON.parse(readFileSync(LANG_FILE, "utf-8")) as { lang?: string };
		if (raw.lang === "zh" || raw.lang === "en") return raw.lang;
	} catch {
		return detectLang(); // 无配置或损坏 → 自动检测
	}
	return detectLang();
}

function saveLang(lang: Lang | "auto"): void {
	try {
		mkdirSync(dirname(LANG_FILE), { recursive: true });
		writeFileSync(
			LANG_FILE,
			JSON.stringify(lang === "auto" ? {} : { lang }),
			"utf-8",
		);
	} catch {
		return; // 持久化失败不致命
	}
}

let uiLang: Lang = loadLang();
const S = (): Strings => STRINGS[uiLang];
/** 面板固定 chrome 行数:上下边框 + 头部 + 输入行 + 提示行 */
const CHROME_ROWS = 6;
/** 历史区最少可见行数 */
const MIN_CONTENT_ROWS = 6;

function contentRows(): number {
	const rows = process.stdout.rows ?? 30;
	return Math.max(MIN_CONTENT_ROWS, Math.floor(rows * 0.5) - CHROME_ROWS);
}

// ---------- 面板组件 ----------

interface PanelOpts {
	tui: TUI;
	theme: any;
	modelId: string;
	onAsk: (question: string) => void;
	onClose: () => void;
}

class BtwPanel implements Component, Focusable {
	private input = new Input();
	private mdTheme = getMarkdownTheme();
	private mdCache = new Map<string, string[]>();
	/** 0 = 吸底跟随最新;>0 = 向上滚动的行数 */
	private scrollUp = 0;
	/** 最新一轮在 contentLines 里的起始行(答案完成后定位到开头用) */
	private lastTurnStart = 0;
	/** 每一轮的起始行(Alt+↑/↓ 轮次跳转用) */
	private turnStarts: number[] = [];
	/** 上一帧渲染的总量:总行数/可见行数/视口顶行(jumpTurn 计算用) */
	private lastTotal = 0;
	private lastRows = 0;
	private viewTop = 0;
	private _focused = true;

	get focused(): boolean {
		return this._focused;
	}
	set focused(v: boolean) {
		this._focused = v;
		this.input.focused = v;
	}

	constructor(private opts: PanelOpts) {
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			const q = value.trim();
			if (!q) return;
			this.input.setValue("");
			if (state.streaming) {
				state.busyNotice = true; // 回答中不排队,内联提示
			} else {
				this.scrollUp = 0;
				opts.onAsk(q);
			}
			opts.tui.requestRender();
		};
		this.input.onEscape = () => opts.onClose();
	}

	invalidate(): void {
		this.mdCache.clear();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.opts.onClose();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scrollUp += 1;
			this.opts.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scrollUp = Math.max(0, this.scrollUp - 1);
			this.opts.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollUp += contentRows();
			this.opts.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollUp = Math.max(0, this.scrollUp - contentRows());
			this.opts.tui.requestRender();
			return;
		}
		// Ctrl 在部分终端(如 Warp)被占作按词跳转不转发,Alt 双保险
		if (matchesKey(data, Key.ctrl("left")) || matchesKey(data, Key.alt("left"))) {
			this.switchConvo(-1);
			return;
		}
		if (
			matchesKey(data, Key.ctrl("right")) ||
			matchesKey(data, Key.alt("right"))
		) {
			this.switchConvo(1);
			return;
		}
		// Alt+↑/↓ 按轮次跳转(落在那一轮的问题开头);Alt 已被 Warp 验证可转发
		if (matchesKey(data, Key.alt("up"))) {
			this.jumpTurn(-1);
			return;
		}
		if (matchesKey(data, Key.alt("down"))) {
			this.jumpTurn(1);
			return;
		}
		// 轮次跳转备选:Ctrl+P/N(readline 惯例;Warp 会截 Alt+↑/↓,这对键久经考验)
		if (matchesKey(data, Key.ctrl("p"))) {
			this.jumpTurn(-1);
			return;
		}
		if (matchesKey(data, Key.ctrl("n"))) {
			this.jumpTurn(1);
			return;
		}
		this.input.handleInput(data);
		this.opts.tui.requestRender();
	}

	/** Ctrl+←/→ 在多条侧问对话间循环切换;切换后定位到对话顶部,便于从头回顾 */
	private switchConvo(dir: number): void {
		const n = state.convos.length;
		if (n < 2) return;
		state.active = (state.active + dir + n) % n;
		state.seekLatestTurn = false;
		this.scrollToTop();
	}

	/** Alt+↑/↓ 按轮次跳转:目标轮次的问题行置顶;到顶/到底就不动 */
	private jumpTurn(dir: number): void {
		const starts = this.turnStarts;
		if (starts.length === 0) return;
		let target: number | undefined;
		if (dir < 0) {
			for (let i = starts.length - 1; i >= 0; i--) {
				const s = starts[i] ?? 0;
				if (s < this.viewTop - 1) {
					target = s;
					break;
				}
			}
		} else {
			for (const s of starts) {
				if (s > this.viewTop + 1) {
					target = s;
					break;
				}
			}
		}
		if (target === undefined) return;
		state.seekLatestTurn = false;
		this.scrollUp = Math.max(0, this.lastTotal - this.lastRows - target);
		this.opts.tui.requestRender();
	}

	/** 定位到内容顶部(scrollUp 会在 render 里被 clamp 到 maxScroll) */
	scrollToTop(): void {
		this.scrollUp = Number.MAX_SAFE_INTEGER;
		this.opts.tui.requestRender();
	}

	/** 流式期间未闭合的 ``` 代码栅栏会让 Markdown 解析器把后半截全吞成代码,补一个 closing fence 再渲染 */
	private closeUnclosedFences(text: string): string {
		const fences = text.match(/^```/gm);
		if (fences && fences.length % 2 === 1) return `${text}\n\`\`\``;
		return text;
	}

	private renderMarkdown(text: string, width: number): string[] {
		const key = `${width}:${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`;
		const cached = this.mdCache.get(key);
		if (cached) return cached;
		const lines = new Markdown(
			this.closeUnclosedFences(text.trim()),
			1,
			0,
			this.mdTheme,
		).render(width);
		// LRU 逐出最旧一条;不整体 clear(历史上整体 clear 曾把历史答案精排缓存全冲掉)
		if (this.mdCache.size > 60)
			this.mdCache.delete(this.mdCache.keys().next().value as string);
		this.mdCache.set(key, lines);
		return lines;
	}

	private contentLines(width: number): string[] {
		const th = this.opts.theme;
		const lines: string[] = [];
		this.turnStarts = [];
		const convo = activeConvo();
		convo.turns.forEach((turn, i) => {
			this.turnStarts.push(lines.length);
			if (i === convo.turns.length - 1) this.lastTurnStart = lines.length;
			// 用户问题走纯文本渲染,防注入(Kimi 评审教训);● 标记+accent 粗体+悬挂缩进,问答之间空行分隔
			if (lines.length > 0)
				lines.push(th.fg("dim", "┄".repeat(Math.max(4, width))));
			const qWrapped = new Text(turn.question, 0, 0).render(
				Math.max(8, width - 2),
			);
			qWrapped.forEach((qline, i) => {
				lines.push(th.fg("accent", th.bold((i === 0 ? "● " : "  ") + qline)));
			});
			let note = "";
			if (turn.aborted) note = S().noteAborted;
			else if (turn.error) note = S().noteError;
			if (note) lines.push(th.fg("warning", note.trim()));
			lines.push("");
			lines.push(...this.renderMarkdown(turn.answer, width));
			lines.push("");
		});
		if (state.streaming) {
			// 整段模式:等待指示器由 500ms 心跳驱动刷新,Esc 可中止
			const secs = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
			lines.push(th.fg("muted", S().thinking(secs)));
		}
		if (convo.turns.length === 0 && !state.streaming) {
			lines.push(th.fg("muted", S().welcome));
		}
		return lines;
	}

	render(width: number): string[] {
		const th = this.opts.theme;
		const innerW = Math.max(1, width - 2);
		const rows = contentRows();
		const pad = (s: string) => truncateToWidth(s, innerW, "…", true);
		const border = (c: string) => th.fg("dim", c);

		const all = this.contentLines(innerW - 2);
		const maxScroll = Math.max(0, all.length - rows);
		if (state.seekLatestTurn) {
			state.seekLatestTurn = false;
			// 新答案定位到最新一轮开头(从上往下读);答案不足一屏时自然吸底
			this.scrollUp = Math.max(0, all.length - rows - this.lastTurnStart);
		}
		this.scrollUp = Math.min(this.scrollUp, maxScroll);
		const start = Math.max(0, all.length - rows - this.scrollUp);
		const visible = all.slice(start, start + rows);
		// 记录渲染量,供 jumpTurn(Alt+↑/↓)计算目标轮次
		this.lastTotal = all.length;
		this.lastRows = rows;
		this.viewTop = start;
		const convoTag =
			state.convos.length > 1
				? ` · #${state.active + 1}/${state.convos.length}`
				: "";
		// 表头显示视口顶所在的轮次:第 当前/总数 轮
		const total = activeConvo().turns.length;
		let cur = 0;
		for (const s of this.turnStarts) if (s <= this.viewTop) cur += 1;
		const turnStr = total === 0 ? "0" : `${Math.max(1, cur)}/${total}`;
		const header =
			S().header(`${turnStr}${state.streaming ? "+" : ""}`, this.opts.modelId) +
			convoTag;
		let scrollHint = "";
		if (maxScroll > 0)
			scrollHint =
				this.scrollUp > 0 ? S().scrollUp(this.scrollUp) : S().scrollBottom;
		const busy = state.busyNotice ? th.fg("warning", S().busy) : "";
		state.busyNotice = false;
		const hints = `${S().hints}${scrollHint}`;

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(
			border("│") +
				pad(` ${th.fg("accent", th.bold(header.trim()))}`) +
				border("│"),
		);
		for (const l of visible) lines.push(border("│") + pad(` ${l}`) + border("│"));
		for (let i = visible.length; i < rows; i++)
			lines.push(border("│") + pad("") + border("│"));
		const [inputLine = ""] = this.input.render(Math.max(1, innerW - 4));
		lines.push(border("│") + pad(` › ${inputLine}`) + border("│"));
		lines.push(border("│") + pad(th.fg("dim", hints) + busy) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}
}

// ---------- 侧问调用 ----------

/** token 估算:优先 pi 官方 estimateTokens(接收消息对象,这里做适配),异常回退字符估算 */
function makeTokenEstimator(): (text: string) => number {
	return (text: string) => {
		try {
			return estimateTokens({
				role: "user",
				content: [{ type: "text", text }],
				timestamp: 0,
			} as any);
		} catch {
			return charTokenEstimate(text);
		}
	};
}

/** 对话标题兜底:截取问题首行 */
function fallbackTitle(question: string): string {
	const nl = question.indexOf("\n");
	const first = (nl >= 0 ? question.slice(0, nl) : question).trim();
	return truncateToWidth(first, 24, "…");
}

/** 首答完成后后台生成对话小标题(模型摘要,失败保留截断兜底) */
async function generateConvoTitle(
	ctx: ExtensionCommandContext,
	question: string,
	convo: SideConvo,
	tui: TUI,
): Promise<void> {
	const model = ctx.model;
	if (!model) return;
	try {
		const final = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt:
					"用与问题相同的语言,把用户问题的主题概括成不超过 12 个字的短标题;只输出标题本身,不要标点结尾,不要解释。",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: question }],
						timestamp: Date.now(),
					} as any,
				],
			},
			{ reasoning: "off" as any },
		);
		const text = (final.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string)
			.join("")
			.trim();
		const nl = text.indexOf("\n");
		const first = (nl >= 0 ? text.slice(0, nl) : text).trim();
		if (first) {
			convo.title = truncateToWidth(first, 30, "…");
			tui.requestRender();
		}
	} catch {
		return; // 标题生成失败不致命
	}
}

async function runSideQuestion(
	ctx: ExtensionCommandContext,
	question: string,
	tui: TUI,
): Promise<void> {
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify(S().noModel, "error");
		return;
	}
	const convo = activeConvo();
	if (!convo.title) convo.title = fallbackTitle(question);
	state.streaming = true;
	state.startedAt = Date.now();
	state.abort = new AbortController();
	// 整段模式(2026-09-04 用户拍板砍流式):500ms 心跳驱动等待指示器计时刷新
	const ticker = setInterval(() => tui.requestRender(), 500);
	try {
		const packed = packContext(
			extractMessages(ctx.sessionManager.getBranch()),
			DEFAULT_CONTEXT_TOKEN_BUDGET,
			makeTokenEstimator(),
		);
		const messages = buildMessages(packed, convo.turns, question).map((m) => ({
			...m,
			timestamp: Date.now(),
		}));
		const context = {
			systemPrompt: SIDE_SYSTEM_PROMPT,
			messages: messages as any,
		};
		const final = await ctx.modelRegistry.complete(model, context, {
			signal: state.abort.signal,
			reasoning: ctx.thinkingLevel as any,
		});

		// 混合 text+tool 响应:只采纳文本块(Kimi 评审教训)
		const textParts = (final.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string);
		const hadToolCalls = (final.content as Array<{ type: string }>).some(
			(c) => c.type === "toolCall",
		);
		let answer = textParts.join("\n") || S().noText;
		if (hadToolCalls) answer += S().toolIgnored;
		if (final.stopReason === "aborted") {
			convo.turns.push({ question, answer: S().noOutput, aborted: true });
		} else if (final.stopReason === "error") {
			convo.turns.push({
				question,
				answer: `${S().errPrefix}${(final as any).errorMessage ?? S().unknownError}`,
				error: true,
			});
		} else {
			convo.turns.push({ question, answer });
			// 首轮答案落地后,后台让模型给这条对话起个小标题(用户拍板:模型生成摘要)
			if (convo.turns.length === 1)
				void generateConvoTitle(ctx, question, convo, tui);
		}
	} catch (e) {
		if (state.abort?.signal.aborted) {
			convo.turns.push({ question, answer: S().noOutput, aborted: true });
		} else {
			convo.turns.push({
				question,
				answer: `${S().errPrefix}${e instanceof Error ? e.message : String(e)}`,
				error: true,
			});
		}
	} finally {
		clearInterval(ticker);
		state.streaming = false;
		state.seekLatestTurn = true; // 答案落地,定位到本轮开头
		state.startedAt = 0;
		state.abort = undefined;
		tui.requestRender();
	}
}

// ---------- 扩展入口 ----------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: S().cmdDesc,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(S().tuiOnly, "error");
				return;
			}
			let q = (args ?? "").trim();
			const langArg = q.match(/^lang(?:\s+(zh|en|auto))?$/i);
			if (langArg) {
				const target = (langArg[1] ?? "").toLowerCase();
				if (!target) {
					ctx.ui.notify(S().langNow(uiLang), "info");
				} else if (target === "auto") {
					uiLang = detectLang();
					saveLang("auto");
					ctx.ui.notify(S().langSet(`auto → ${uiLang}`), "info");
				} else {
					uiLang = target as Lang;
					saveLang(uiLang);
					ctx.ui.notify(S().langSet(uiLang), "info");
				}
				return;
			}
			let openAtTop = false;
			if (q === "new") {
				state.convos.push({ title: "", turns: [], createdAt: Date.now() });
				state.active = state.convos.length - 1;
				ctx.ui.notify(S().newConvo, "info");
				q = ""; // 消费掉指令,继续往下打开空面板
			} else if (q === "history") {
				const options = state.convos.map(
					(c, i) => `${i + 1}. ${c.title || S().emptyTag}`,
				);
				const choice = await ctx.ui.select(S().historyTitle, options);
				if (!choice) return;
				const idx = options.indexOf(choice);
				if (idx >= 0) {
					state.active = idx;
					openAtTop = true;
				}
				q = ""; // 消费掉指令,继续往下打开面板回顾
			} else if (q === "clear") {
				state.abort?.abort();
				const convo = activeConvo();
				convo.turns.length = 0;
				convo.title = "";
				state.startedAt = 0;
				ctx.ui.notify(S().cleared, "info");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify(S().noModel, "error");
				return;
			}

			let panel: BtwPanel | undefined;
			await ctx.ui.custom<null>(
				(tui, theme, _kb, done) => {
					panel = new BtwPanel({
						tui,
						theme,
						modelId: ctx.model?.id ?? "unknown",
						onAsk: (question) => {
							void runSideQuestion(ctx, question, tui);
						},
						onClose: () => {
							// Esc:中止进行中的侧问(只动自己的 AbortController),保留历史
							state.abort?.abort();
							done(null);
						},
					});
					// /btw history 切换而来:定位到对话顶部,从头回顾
					if (openAtTop && panel) panel.scrollToTop();
					// /btw <问题>:面板打开后立即发问
					if (q && !state.streaming) {
						const tuiRef = tui;
						queueMicrotask(() => {
							void runSideQuestion(ctx, q, tuiRef);
						});
					}
					return panel;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						anchor: "bottom-center",
						maxHeight: "55%",
					},
				},
			);
		},
	});
}
