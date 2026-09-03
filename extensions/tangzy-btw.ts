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

interface SideState {
	turns: SideTurn[];
	streaming: boolean;
	abort?: AbortController;
	/** 流式中的部分答案 */
	partial: string;
	/** busy 提示的一次性标记(渲染后清除) */
	busyNotice: boolean;
	/** 流式回退提示只发一次 */
	fallbackNotified: boolean;
	/** 流式中的思考文本(thinking 模型,仅用于进度展示,不入答案) */
	thinking: string;
	/** 本轮发问起点(渲染耗时用) */
	startedAt: number;
}

const state: SideState = { turns: [], streaming: false, partial: "", busyNotice: false, fallbackNotified: false, thinking: "", startedAt: 0 };
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
		this.input.handleInput(data);
		this.opts.tui.requestRender();
	}

	/** 流式期间的纯文本快速渲染:不跑 Markdown 解析,逐字顺滑;完成后由 renderMarkdown 精排接管 */
	private renderPlain(text: string, width: number): string[] {
		const key = `plain:${width}:${text.length}`;
		const cached = this.mdCache.get(key);
		if (cached) return cached;
		const lines = new Text(text, 0, 0).render(width);
		if (this.mdCache.size > 40) this.mdCache.clear();
		this.mdCache.set(key, lines);
		return lines;
	}

	private renderMarkdown(text: string, width: number): string[] {
		const key = `${width}:${text.length}:${text.slice(0, 64)}`;
		const cached = this.mdCache.get(key);
		if (cached) return cached;
		const lines = new Markdown(text, 0, 0, this.mdTheme).render(width);
		if (this.mdCache.size > 40) this.mdCache.clear();
		this.mdCache.set(key, lines);
		return lines;
	}

	private contentLines(width: number): string[] {
		const th = this.opts.theme;
		const lines: string[] = [];
		for (const turn of state.turns) {
			// 用户问题走纯文本渲染,防注入(Kimi 评审教训)
			lines.push(th.fg("accent", `› ${turn.question}`));
			let note = "";
			if (turn.aborted) note = " [已中止]";
			else if (turn.error) note = " [出错]";
			if (note) lines.push(th.fg("warning", note.trim()));
			lines.push(...this.renderMarkdown(turn.answer, width));
			lines.push("");
		}
		if (state.streaming) {
			if (state.partial) {
				lines.push(...this.renderPlain(state.partial, width));
			} else {
				// thinking 模型:思考阶段让面板"活"起来(耗时 + 思考量随 thinking_delta 实时刷新)
				const secs = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
				const thinkNote = state.thinking ? ` · 已思考 ${state.thinking.length} 字` : "";
				lines.push(th.fg("muted", `🤔 思考中… ${secs}s${thinkNote}`));
			}
		}
		if (state.turns.length === 0 && !state.streaming) {
			lines.push(th.fg("muted", "侧问不打扰主会话:直接在下方输入问题,Enter 发送。"));
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
		this.scrollUp = Math.min(this.scrollUp, maxScroll);
		const start = Math.max(0, all.length - rows - this.scrollUp);
		const visible = all.slice(start, start + rows);

		const header = ` btw · 侧问 · 第 ${state.turns.length}${state.streaming ? "+" : ""} 轮 · ${this.opts.modelId}`;
		const scrollHint = maxScroll > 0 ? ` (↑↓ 滚动 ${this.scrollUp > 0 ? `· 距底部 ${this.scrollUp} 行` : "· 已吸底"})` : "";
		const busy = state.busyNotice ? th.fg("warning", " 回答中,稍等…") : "";
		state.busyNotice = false;
		const hints = ` Enter 发送 · Esc 关闭 · /btw clear 清空${scrollHint}`;

		const lines: string[] = [];
		lines.push(border(`╭${"─".repeat(innerW)}╮`));
		lines.push(border("│") + pad(` ${th.fg("accent", th.bold(header.trim()))}`) + border("│"));
		for (const l of visible) lines.push(border("│") + pad(` ${l}`) + border("│"));
		for (let i = visible.length; i < rows; i++) lines.push(border("│") + pad("") + border("│"));
		const [inputLine = ""] = this.input.render(Math.max(1, innerW - 4));
		lines.push(border("│") + pad(` › ${inputLine}`) + border("│"));
		lines.push(border("│") + pad(th.fg("dim", hints) + busy) + border("│"));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}
}

// ---------- 侧问调用 ----------

/** 流式节流渲染(V2 恢复):100ms 间隔 */
function throttledRenderer(tui: TUI): () => void {
	let last = 0;
	return () => {
		const now = Date.now();
		if (now - last >= 100) {
			last = now;
			tui.requestRender();
		}
	};
}

/** pi-ai compat 子路径的 streamSimple 自由函数(扩展可用的唯一流式路径) */
type StreamSimpleFn = (model: any, context: any, options?: any) => AsyncIterable<any> & { result(): Promise<any> };
let streamSimpleProbe: "unknown" | "ok" | "fail" = "unknown";
let streamSimpleFn: StreamSimpleFn | undefined;

/** 探针:动态 import pi-ai/compat,失败则本会话永久回退 complete 整段模式 */
async function ensureStreamSimple(): Promise<StreamSimpleFn | undefined> {
	if (streamSimpleProbe === "ok") return streamSimpleFn;
	if (streamSimpleProbe === "fail") return undefined;
	try {
		const mod: any = await import("@earendil-works/pi-ai/compat");
		if (typeof mod?.streamSimple === "function") {
			streamSimpleFn = mod.streamSimple as StreamSimpleFn;
			streamSimpleProbe = "ok";
			return streamSimpleFn;
		}
	} catch {
		/* 解析失败,落入 fail */
	}
	streamSimpleProbe = "fail";
	return undefined;
}

/** token 估算:优先 pi 官方 estimateTokens(接收消息对象,这里做适配),异常回退字符估算 */
function makeTokenEstimator(): (text: string) => number {
	return (text: string) => {
		try {
			return estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: 0 } as any);
		} catch {
			return charTokenEstimate(text);
		}
	};
}

async function runSideQuestion(ctx: ExtensionCommandContext, question: string, tui: TUI): Promise<void> {
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("btw: 当前没有可用模型", "error");
		return;
	}
	state.streaming = true;
	state.partial = "";
	state.thinking = "";
	state.startedAt = Date.now();
	state.abort = new AbortController();
	const requestRender = throttledRenderer(tui);
	try {
		const packed = packContext(extractMessages(ctx.sessionManager.getBranch()), DEFAULT_CONTEXT_TOKEN_BUDGET, makeTokenEstimator());
		const messages = buildMessages(packed, state.turns, question).map((m) => ({ ...m, timestamp: Date.now() }));
		const context = { systemPrompt: SIDE_SYSTEM_PROMPT, messages: messages as any };
		let final: any;

		// V2:优先流式(pi-ai/compat streamSimple),失败回退 complete 整段模式
		const fn = await ensureStreamSimple();
		let streamed = false;
		if (fn) {
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (auth.ok) {
					const stream = fn(model, context, {
						signal: state.abort.signal,
						reasoning: ctx.thinkingLevel as any,
						apiKey: auth.apiKey,
						headers: (auth as any).headers,
					});
					for await (const ev of stream as any) {
						if (ev?.type === "text_delta" && typeof ev.delta === "string") {
							state.partial += ev.delta;
							requestRender();
						} else if (ev?.type === "thinking_delta" && typeof ev.delta === "string") {
							state.thinking += ev.delta;
							requestRender();
						}
					}
					final = await stream.result();
					streamed = true;
				}
			} catch (e) {
				if (state.abort?.signal.aborted) throw e; // 用户中止走外层,不回退
				// 流式路径失败:回退(保留已累积的 partial 作为兜底答案)
				streamSimpleProbe = "fail";
			}
		}
		if (!streamed) {
			if (fn && !state.fallbackNotified) {
				state.fallbackNotified = true;
				ctx.ui.notify("btw: 流式不可用,已回退整段模式", "info");
			}
			final = await ctx.modelRegistry.complete(model, context, {
				signal: state.abort.signal,
				reasoning: ctx.thinkingLevel as any,
			});
		}

		// 混合 text+tool 响应:只采纳文本块(Kimi 评审教训)
		const textParts = (final.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string);
		const hadToolCalls = (final.content as Array<{ type: string }>).some((c) => c.type === "toolCall");
		let answer = textParts.join("\n") || state.partial || "(无文本输出)";
		if (hadToolCalls) answer += "\n\n*(模型尝试调用工具,已忽略——侧问不执行任何操作)*";
		if (final.stopReason === "aborted") {
			state.turns.push({ question, answer: state.partial || "(无输出)", aborted: true });
		} else if (final.stopReason === "error") {
			state.turns.push({ question, answer: `出错:${(final as any).errorMessage ?? "未知错误"}`, error: true });
		} else {
			state.turns.push({ question, answer });
		}
	} catch (e) {
		if (state.abort?.signal.aborted) {
			state.turns.push({ question, answer: state.partial || "(无输出)", aborted: true });
		} else {
			state.turns.push({ question, answer: `出错:${e instanceof Error ? e.message : String(e)}`, error: true });
		}
	} finally {
		state.streaming = false;
		state.partial = "";
		state.thinking = "";
		state.startedAt = 0;
		state.abort = undefined;
		tui.requestRender();
	}
}

// ---------- 扩展入口 ----------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "侧问:不打扰主会话的快速问答(底部面板,markdown,支持追问;/btw clear 清空)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("btw 仅支持交互模式", "error");
				return;
			}
			const q = (args ?? "").trim();
			if (q === "clear") {
				state.abort?.abort();
				state.turns.length = 0;
				state.thinking = "";
				state.startedAt = 0;
				ctx.ui.notify("btw 侧线已清空", "info");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("btw: 当前没有可用模型", "error");
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
