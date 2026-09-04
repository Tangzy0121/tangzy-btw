import assert from "node:assert/strict";
import test from "node:test";
import {
	buildMessages,
	extractMessages,
	packContext,
	SIDE_SYSTEM_PROMPT,
	truncatePreview,
} from "./lib.ts";

// ---------- extractMessages ----------

test("extractMessages: 只抽 user/assistant 的 text 内容", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "你好" }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "在的" }] } },
		// 工具调用块不抽
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } },
		// 非 message 条目跳过
		{ type: "custom", data: {} },
		// 其他 role 跳过
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x" }] } },
		// 空文本跳过
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "  " }] } },
		// 畸形条目不炸
		null,
		42,
		{ type: "message" },
	];
	const out = extractMessages(branch);
	assert.deepEqual(out, [
		{ role: "user", text: "你好" },
		{ role: "assistant", text: "在的" },
	]);
});

test("extractMessages: /btw 命令消息被过滤,防止自引用回声", () => {
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "/btw 这个函数干啥的" }] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "正常问题" }] } },
	];
	const out = extractMessages(branch);
	assert.equal(out.length, 1);
	assert.equal(out[0].text, "正常问题");
});

test("extractMessages: 空会话返回空数组", () => {
	assert.deepEqual(extractMessages([]), []);
});

// ---------- packContext(token 预算,注入估算函数) ----------

const estimate = (t: string) => Math.ceil(t.length / 4); // mock:4 字符 ≈ 1 token

test("packContext: 预算内全保留", () => {
	const msgs = [
		{ role: "user" as const, text: "a" },
		{ role: "assistant" as const, text: "b" },
	];
	const p = packContext(msgs, 100, estimate);
	assert.equal(p.messages.length, 2);
	assert.equal(p.omittedMessages, 0);
});

test("packContext: 超 token 预算保最新、掐最旧", () => {
	const msgs = [
		{ role: "user" as const, text: "x".repeat(80) },   // 20 tok
		{ role: "assistant" as const, text: "y".repeat(60) }, // 15 tok
		{ role: "user" as const, text: "z".repeat(40) },   // 10 tok
	];
	const p = packContext(msgs, 20, estimate);
	// 最新 10 + 次新 15 = 25 > 20,只能留最新一条
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].text, "z".repeat(40));
	assert.equal(p.omittedMessages, 2);
	assert.equal(p.omittedTokens, 35);
});

test("packContext: 单条消息超预算时单独截断而非丢弃", () => {
	const msgs = [{ role: "user" as const, text: "x".repeat(400) }]; // 100 tok
	const p = packContext(msgs, 50, estimate);
	assert.equal(p.messages.length, 1);
	assert.ok(p.messages[0].text.length < 400);
	assert.ok(p.messages[0].text.includes("已截断"));
});

test("packContext: 默认兜底估算函数(charTokenEstimate)可用", () => {
	const msgs = [{ role: "user" as const, text: "x".repeat(400) }];
	const p = packContext(msgs, 50); // 不传估算函数,走 charTokenEstimate
	assert.equal(p.messages.length, 1);
	assert.ok(p.messages[0].text.includes("已截断"));
});

// ---------- buildMessages ----------

test("buildMessages: 空会话只有本轮问题", () => {
	const msgs = buildMessages({ messages: [], omittedMessages: 0, omittedTokens: 0 }, [], "hello");
	assert.equal(msgs.length, 1);
	const text = msgs[0].content[0].text;
	assert.ok(!text.includes("主会话只读快照"));
	assert.ok(!text.includes("侧问历史"));
	assert.ok(text.includes("hello"));
});

test("buildMessages: 三段齐全且顺序正确", () => {
	const packed = { messages: [{ role: "user" as const, text: "主会话内容" }], omittedMessages: 2, omittedTokens: 100 };
	const turns = [{ question: "第一问", answer: "第一答" }];
	const msgs = buildMessages(packed, turns, "第二问");
	const text = msgs[0].content[0].text;
	const iSnap = text.indexOf("主会话只读快照");
	const iHist = text.indexOf("本次侧问历史");
	const iQ = text.indexOf("本轮问题");
	assert.ok(iSnap >= 0 && iHist > iSnap && iQ > iHist);
	assert.ok(text.includes("省略"));
	assert.ok(text.includes("第一问"));
	assert.ok(text.includes("第二问"));
});

test("buildMessages: 中止/出错的轮次带标注", () => {
	const turns = [
		{ question: "q1", answer: "a1", aborted: true },
		{ question: "q2", answer: "a2", error: true },
	];
	const text = buildMessages({ messages: [], omittedMessages: 0, omittedTokens: 0 }, turns, "q3")[0].content[0].text;
	assert.ok(text.includes("(回答被中止)"));
	assert.ok(text.includes("(回答出错)"));
});

// ---------- 杂项 ----------

test("truncatePreview: 超限加省略号,压缩空白", () => {
	assert.equal(truncatePreview("短", 10), "短");
	const long = truncatePreview("a  b\n".repeat(20), 10);
	assert.ok(long.endsWith("…"));
	assert.ok(!long.includes("\n"));
});

test("SIDE_SYSTEM_PROMPT: Kimi 式要点齐全", () => {
	assert.ok(SIDE_SYSTEM_PROMPT.includes("没有任何工具"));
	assert.ok(SIDE_SYSTEM_PROMPT.includes("不知道就直说"));
	assert.ok(SIDE_SYSTEM_PROMPT.includes("只读"));
	assert.ok(SIDE_SYSTEM_PROMPT.includes("Recap"));
	assert.ok(SIDE_SYSTEM_PROMPT.includes("多轮追问"));
});
