/**
 * tangzy-btw 纯逻辑库 —— 不依赖任何 pi 模块,可用 node --test 直接单测。
 *
 * 职责:主会话上下文抽取/预算截断、侧问消息组装、显示截断。
 */

export interface ChatMessage {
	role: "user" | "assistant";
	text: string;
}

export interface SideTurn {
	question: string;
	answer: string;
	/** 流式中被 Esc 中止的不完整答案 */
	aborted?: boolean;
	/** 流式报错 */
	error?: boolean;
}

/** 主会话快照的默认 token 预算(V2:字符估算升级为注入式 token 估算) */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 6_000;

/** token 估算函数签名(注入式,便于单测 mock) */
export type TokenEstimator = (text: string) => number;

/** 兜底估算:约 4 字符 1 token,无 pi 环境下也能跑 */
export const charTokenEstimate: TokenEstimator = (text) => Math.ceil(text.length / 4);

/**
 * 从 sessionManager.getBranch() 的条目里抽取 user/assistant 纯文本消息。
 * 防御式设计:入口参数视为 unknown,逐项校验(Kimi 评审教训:不要相信上游形状)。
 */
export function extractMessages(branch: unknown[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const entry of branch) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as { type?: unknown; message?: unknown };
		if (e.type !== "message") continue;
		const msg = e.message as { role?: unknown; content?: unknown } | undefined;
		if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;
		if (!Array.isArray(msg.content)) continue;
		const text = (msg.content as Array<{ type?: unknown; text?: unknown }>)
			.filter((c) => c && c.type === "text" && typeof c.text === "string")
			.map((c) => (c as { text: string }).text)
			.join("\n")
			.trim();
		if (!text) continue;
		// /btw 命令本身若进入历史,不送回侧问(防自引用回声)
		if (msg.role === "user" && text.startsWith("/btw")) continue;
		out.push({ role: msg.role, text });
	}
	return out;
}

export interface PackedContext {
	messages: ChatMessage[];
	omittedMessages: number;
	/** 被省略消息的估算 token 总量 */
	omittedTokens: number;
}

/**
 * 预算截断:从最新往最旧收,超预算即停(按估算 token 计)。
 * 保证至少保留最新一条(哪怕它自己就超预算——此时单独截断该条文本)。
 */
export function packContext(
	messages: ChatMessage[],
	budgetTokens: number = DEFAULT_CONTEXT_TOKEN_BUDGET,
	estimate: TokenEstimator = charTokenEstimate,
): PackedContext {
	const kept: ChatMessage[] = [];
	let used = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const cost = estimate(m.text);
		if (used + cost > budgetTokens) {
			if (kept.length === 0) {
				// 单条超预算:按字符比例截断到预算内
				const keepChars = Math.max(1, Math.floor(m.text.length * (budgetTokens / Math.max(1, cost))));
				kept.push({ role: m.role, text: `${m.text.slice(0, keepChars)}\n[单条消息过长,已截断]` });
				return { messages: kept, omittedMessages: messages.length - 1, omittedTokens: cost - budgetTokens };
			}
			break;
		}
		kept.push(m);
		used += cost;
	}
	kept.reverse();
	const omittedMessages = messages.length - kept.length;
	const omittedTokens = messages.slice(0, omittedMessages).reduce((s, m) => s + estimate(m.text), 0);
	return { messages: kept, omittedMessages, omittedTokens };
}

/** 侧问系统提示(V2:吸收 kimi-cli SIDE_QUESTION_SYSTEM_REMINDER 要点,保留多轮追问) */
export const SIDE_SYSTEM_PROMPT = `你是编程助手 pi 里的侧边问答实例(btw 侧问)。
- 直接回答当前这一轮的问题;主 agent 正在独立继续工作,不要提及"被打断"。
- 你没有任何工具;即使你看到工具相关描述,那也只是技术原因,禁止调用,只输出文本。
- 只基于下方会话快照里已有的信息回答;**不知道就直说不知道**,不要编造。
- 你的回答不会进入主会话;快照是只读历史。
- 支持多轮追问:之前的侧问历史会附在快照后面。
- 语言跟随用户的问题(中文问题用中文答);回答用 markdown,代码用围栏代码块;保持简洁。`;

/**
 * 组装侧问请求消息:单条 user 消息,三段式(快照 / 侧线历史 / 本问)。
 * 单消息设计对各家 provider 的角色交替约束最稳健。
 */
export function buildMessages(packed: PackedContext, turns: SideTurn[], question: string): Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }> {
	const sections: string[] = [];

	if (packed.messages.length > 0) {
		const lines = packed.messages.map((m) => `【${m.role === "user" ? "用户" : "主 agent"}】\n${m.text}`);
		const omitted = packed.omittedMessages > 0 ? `(更早的 ${packed.omittedMessages} 条消息已省略)\n` : "";
		sections.push(`## 主会话只读快照\n${omitted}${lines.join("\n\n")}`);
	}

	if (turns.length > 0) {
		const lines = turns.map((t) => {
			const note = t.aborted ? "(回答被中止)" : t.error ? "(回答出错)" : "";
			return `问:${t.question}\n答${note}:${t.answer}`;
		});
		sections.push(`## 本次侧问历史\n${lines.join("\n\n")}`);
	}

	sections.push(`## 本轮问题\n${question}`);

	return [{ role: "user", content: [{ type: "text", text: sections.join("\n\n---\n\n") }] }];
}

/** 面板头部显示用的单行截断(按字符数,不考虑宽字符,仅用于标题预览) */
export function truncatePreview(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}
