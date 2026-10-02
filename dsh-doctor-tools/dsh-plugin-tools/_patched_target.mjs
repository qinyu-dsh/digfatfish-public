import { closedTurns, editPlan, editableMessages, precedingContentIndex, recallBoundary, rerollPlan, retryPlan, retryableTurns } from "./plan.mjs";
import { Service } from "@deepseek-ai/cordis";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { SESSION_BRANCH_VERSION_SCHEMA as SESSION_BRANCH_VERSION_SCHEMA$1, SessionBranchError, balanceRewindPrefix } from "@morlay/session-branch";
//#region src/shared.ts
const SESSION_EDITOR_PATH = "/session-editor";
function toTimelinePayload(sessionId, timeline, messages, retryableTurns) {
	const currentPath = /* @__PURE__ */ new Set();
	for (const node of timeline.nodes) currentPath.add(String(node.sessionId));
	const versions = timeline.nodes.map((node) => ({
		sessionId: String(node.sessionId),
		...node.parentSessionId === void 0 ? {} : { parentSessionId: String(node.parentSessionId) },
		...node.effect === void 0 ? {} : {
			effectId: node.effect.id,
			inverseSessionId: String(node.inverseSessionId),
			operation: node.effect.operation,
			cascade: node.effect.cascade,
			targetTurn: node.effect.targetTurn,
			...node.effect.blockKind === void 0 ? {} : { blockKind: node.effect.blockKind },
			...node.effect.before === void 0 ? {} : { before: node.effect.before },
			...node.effect.after === void 0 ? {} : { after: node.effect.after }
		},
		createdAt: node.createdAt,
		depth: depthOf(timeline, node.sessionId),
		current: String(node.sessionId) === String(sessionId),
		onCurrentEffectPath: currentPath.has(String(node.sessionId))
	}));
	const versionsById = new Map(versions.map((version) => [version.sessionId, version]));
	const undoStack = [];
	let cursor = versionsById.get(String(sessionId));
	while (cursor?.inverseSessionId !== void 0) {
		if (undoStack.includes(cursor.inverseSessionId)) break;
		undoStack.push(cursor.inverseSessionId);
		cursor = versionsById.get(cursor.inverseSessionId);
	}
	const redoSessionIds = versions.filter((version) => version.inverseSessionId === String(sessionId)).map((version) => version.sessionId);
	return {
		sessionId: String(sessionId),
		messages,
		retryableTurns,
		versions,
		undoStack,
		redoSessionIds
	};
}
function depthOf(timeline, sessionId) {
	const byId = new Map(timeline.nodes.map((node) => [String(node.sessionId), node]));
	let depth = 0;
	let cursor = byId.get(String(sessionId));
	const seen = /* @__PURE__ */ new Set();
	while (cursor?.parentSessionId !== void 0 && !seen.has(String(cursor.sessionId))) {
		seen.add(String(cursor.sessionId));
		depth += 1;
		cursor = byId.get(String(cursor.parentSessionId));
	}
	return depth;
}
//#endregion
//#region src/index.ts
function appendLogSeedEvent(events, type, data, ignorable = false) {
	events.push({
		type,
		seq: events.length,
		time: Date.now(),
		data,
		...ignorable ? { ignorable: true } : {}
	});
}
function appendSurfaceSeedEvent(events, type, data, intent) {
	events.push({
		type,
		seq: SessionSeq(events.length),
		time: Date.now(),
		data,
		surfaceOp: intent.surfaceOp,
		...intent.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: intent.sourceEventSeqs }
	});
}
function appendManualTurn(events, manual) {
	const { turn, user, assistant } = manual;
	appendLogSeedEvent(events, "turn/start", { turn });
	appendSurfaceSeedEvent(events, "user/message", user, { surfaceOp: "append" });
	appendLogSeedEvent(events, "step/start", {
		turn,
		step: 1
	});
	appendSurfaceSeedEvent(events, "assistant/message", {
		turn,
		step: 1,
		message: assistant,
		stream: []
	}, { surfaceOp: "append" });
	appendLogSeedEvent(events, "step/end", {
		turn,
		step: 1
	});
	appendLogSeedEvent(events, "turn/end", {
		turn,
		reason: { kind: "completed" }
	});
}
async function appendSeedSuffixLive(session, seedSuffix, appendDirect) {
	for (const event of seedSuffix) {
		if (event.ignorable === true) {
			const s = session;
			const seq = s.log.length;
			await appendDirect([{
				...event,
				seq
			}]);
			s.log.push({
				...event,
				seq
			});
			s.eventsSnapshot = void 0;
			continue;
		}
		const s = session;
		const raw = event;
		if (raw.surfaceOp !== void 0) s.append(event.type, event.data, {
			surfaceOp: raw.surfaceOp,
			...raw.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: raw.sourceEventSeqs }
		});
		else s.append(event.type, event.data);
	}
}
var SessionEditor = class extends Service {
	static inject = [
		"sessionBranch",
		"sessionPersistence",
		"sessions"
	];
	constructor(ctx) {
		super(ctx, "sessionEditor");
		registerHttpRoutes(ctx);
	}
	readBranchPrefix(id, atSeq, mode, signal) {
		return this.ctx.sessionBranch.readBranchPrefix(id, atSeq, mode, signal);
	}
	fork(sourceId, atSeq, childSessionId, meta, signal) {
		return this.ctx.sessionBranch.forkFrom(sourceId, {
			...atSeq === void 0 ? {} : { atSeq },
			...childSessionId === void 0 ? {} : { childSessionId },
			...meta === void 0 ? {} : { meta }
		}, signal);
	}
	async rewind(id, toBoundary, signal) {
		await this.stopLoop(id, signal);
		return this.ctx.sessionBranch.rewind(id, toBoundary, signal);
	}
	timeline(sessionId, signal) {
		return this.ctx.sessionBranch.timeline(sessionId, signal);
	}
	edit(operation, signal) {
		return this.branchOperation(operation, signal);
	}
	reroll(operation, signal) {
		return this.branchOperation(operation, signal);
	}
	retry(operation, signal) {
		return this.branchOperation(operation, signal);
	}
	recall(operation, signal) {
		return this.recallOperation(operation, signal);
	}
	async editableMessages(sessionId, signal) {
		const events = await this.readEvents(sessionId, signal);
		return editableMessages(closedTurns(events));
	}
	async retryableTurns(sessionId, signal) {
		const events = await this.readEvents(sessionId, signal);
		return retryableTurns(closedTurns(events));
	}
	async branchOperation(operation, signal) {
		signal?.throwIfAborted();
		const events = await this.readEvents(operation.sessionId, signal);
		const turns = closedTurns(events);
		const plan = operation.action === "edit" ? editPlan(operation, turns) : operation.action === "retry" ? retryPlan(operation, turns) : rerollPlan(operation, turns);
		const headerConfig = events.findLast((event) => event.type === "request/header")?.data.header.config;
		const turnIndex = turns.findIndex((turn) => turn.startSeq === plan.anchorSeq);
		const preceding = precedingContentIndex(turns, turnIndex);
		const boundary = plan.rewindBoundary !== void 0 ? plan.rewindBoundary : preceding < 0 ? -1 : turns[preceding].endSeq;
		const replayTurn = preceding < 0 ? 1 : turns[preceding].turn + 1;
		const seedSuffix = [];
		appendLogSeedEvent(seedSuffix, "session-branch/version", plan.version, true);
		if (plan.manualTurn !== void 0) appendManualTurn(seedSuffix, {
			...plan.manualTurn,
			turn: replayTurn
		});
		const replay = await this.prepareReplay(operation.sessionId, plan.queuedUsers, signal, headerConfig);
		await this.stopLoop(operation.sessionId, signal);
		const live = this.ctx.sessions.get(operation.sessionId);
		await this.ctx.sessionBranch.rewind(operation.sessionId, boundary, signal);
		if (seedSuffix.length > 0) {
			if (live !== void 0) {
				const handle = this.ctx.sessionPersistence.tracker.writerOf(operation.sessionId);
				if (handle === void 0) throw new Error(`session "${operation.sessionId}" has no live write handle for the version effect`);
				await this.ctx.sessions.flush(live);
				await appendSeedSuffixLive(live, seedSuffix, (events) => handle.append(events));
				await this.ctx.sessions.flush(live);
			} else {
				const rawKeepLength = boundary + (plan.rewindBoundary === void 0 ? 1 : 0);
				const keepLength = balanceRewindPrefix(events.slice(0, rawKeepLength)).length;
				const renumbered = seedSuffix.map((event, index) => ({
					...event,
					seq: keepLength + index
				}));
				const handle = await this.ctx.sessionPersistence.open(operation.sessionId, "write");
				try {
					await handle.append(renumbered);
				} finally {
					await handle.close();
				}
			}
		}
		let queuedTurns = 0;
		if (replay.agent !== void 0 && plan.queuedUsers.length > 0) {
			const lastSeedTurn = seedSuffix.findLast((event) => event.type === "turn/start")?.data.turn;
			if (lastSeedTurn !== void 0) {
				const phase = replay.agent.phase;
				if (phase !== void 0) phase.lastTurn = lastSeedTurn;
			}
			for (const message of plan.queuedUsers) replay.agent.followup(message);
			await this.ctx.sessions.flush(replay.agent.session);
			queuedTurns = plan.queuedUsers.length;
		}
		return {
			sessionId: operation.sessionId,
			queuedTurns,
			live: this.ctx.sessions.get(operation.sessionId) !== void 0
		};
	}
	/**
	* 撤回（recall）：只 rewind 截断，不重写、不重放——被撤回的 user 消息文本
	* 由客户端回填到输入框，交给用户修改后重新发送。
	*
	* 边界见 {@link recallBoundary}：轮首消息整轮截断到前一轮 `turn/end`
	* （无前轮则 -1），轮内 followup 与轮外 user 消息只截断到该消息本身
	* （exclusive drop），避免留下悬空 `turn/start` 让下一次发送开到错误轮号。
	*/
	async recallOperation(operation, signal) {
		signal?.throwIfAborted();
		const events = await this.readEvents(operation.sessionId, signal);
		const boundary = recallBoundary(events, closedTurns(events), operation.eventSeq);
		await this.stopLoop(operation.sessionId, signal);
		await this.ctx.sessionBranch.rewind(operation.sessionId, boundary, signal);
		return {
			sessionId: operation.sessionId,
			queuedTurns: 0,
			live: this.ctx.sessions.get(operation.sessionId) !== void 0
		};
	}
	async stopLoop(sessionId, signal) {
		signal?.throwIfAborted();
		const existing = this.ctx.get("agents")?.get(sessionId);
		if (existing === void 0) return;
		existing.cancel?.({ kind: "user" }, { keepInbox: true });
		await existing.whenIdle();
		signal?.throwIfAborted();
	}
	async readEvents(sessionId, signal) {
		const live = this.ctx.sessions.get(sessionId);
		if (live !== void 0) return live.snapshotEvents();
		return (await this.ctx.sessionBranch.readRawEvents(sessionId, signal)).events;
	}
	async prepareReplay(sessionId, queuedUsers, signal, headerConfig) {
		if (queuedUsers.length === 0) return { agent: void 0 };
		signal?.throwIfAborted();
		const agents = this.ctx.get("agents");
		if (agents === void 0) return { agent: void 0 };
		const existing = agents.get(sessionId);
		if (existing !== void 0) return { agent: existing };
		const provider = headerConfig?.provider ?? "";
		const model = headerConfig?.model ?? "";
		if (provider.length === 0 || model.length === 0) {
			const config = (await this.readEvents(sessionId, signal)).findLast((event) => event.type === "request/header")?.data.header.config;
			const fallbackProvider = config?.provider ?? "";
			const fallbackModel = config?.model ?? "";
			if (fallbackProvider.length === 0 || fallbackModel.length === 0) throw new SessionBranchError("无法重放：会话没有可解析的模型配置。", "INVALID_BOUNDARY");
			const handle = await agents.resume({
				resumeSessionId: sessionId,
				agentOptions: {
					provider: fallbackProvider,
					model: fallbackModel
				}
			});
			signal?.throwIfAborted();
			return { agent: handle.agent };
		}
		const handle = await agents.resume({
			resumeSessionId: sessionId,
			agentOptions: {
				provider,
				model
			}
		});
		signal?.throwIfAborted();
		return { agent: handle.agent };
	}
};
function objectValue(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("请求体必须是 JSON 对象。");
	return value;
}
function sessionIdOf(value) {
	if (typeof value !== "string" || value.length === 0) throw new TypeError("sessionId 必须是非空字符串。");
	return value;
}
function integerOf(value, name) {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} 必须是非负安全整数。`);
	return value;
}
function cascadeOf(value) {
	if (value !== "truncate" && value !== "preserve") throw new TypeError("cascade 必须是 truncate 或 preserve。");
	return value;
}
function decodeOperation(value) {
	const record = objectValue(value);
	const sessionId = sessionIdOf(record["sessionId"]);
	switch (record["action"]) {
		case "edit":
			if (typeof record["text"] !== "string") throw new TypeError("text 必须是字符串。");
			return {
				action: "edit",
				sessionId,
				eventSeq: integerOf(record["eventSeq"], "eventSeq"),
				blockIndex: integerOf(record["blockIndex"], "blockIndex"),
				text: record["text"],
				cascade: cascadeOf(record["cascade"])
			};
		case "reroll": return {
			action: "reroll",
			sessionId
		};
		case "retry": return {
			action: "retry",
			sessionId,
			turn: integerOf(record["turn"], "turn"),
			cascade: cascadeOf(record["cascade"])
		};
		case "rewind": return {
			action: "rewind",
			sessionId,
			toBoundary: integerOf(record["toBoundary"], "toBoundary")
		};
		case "recall": return {
			action: "recall",
			sessionId,
			eventSeq: integerOf(record["eventSeq"], "eventSeq")
		};
		case "fork": return {
			action: "fork",
			sessionId,
			...record["atSeq"] === void 0 ? {} : { atSeq: integerOf(record["atSeq"], "atSeq") },
			...record["childSessionId"] === void 0 ? {} : { childSessionId: sessionIdOf(record["childSessionId"]) }
		};
		default: throw new TypeError("action 必须是 edit、reroll、retry、rewind、recall 或 fork。");
	}
}
function requestJson(request) {
	return new Promise((resolve, reject) => {
		const decoder = new TextDecoder();
		let text = "";
		request.on("data", (chunk) => {
			text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		});
		request.on("end", () => {
			try {
				text += decoder.decode();
				resolve(JSON.parse(text));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}
function respondJson(response, status, value) {
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(JSON.stringify(value));
}
async function readTimeline(editor, sessionId) {
	return toTimelinePayload(sessionId, await editor.timeline(sessionId), await editor.editableMessages(sessionId), await editor.retryableTurns(sessionId));
}
async function runOperation(editor, operation) {
	switch (operation.action) {
		case "edit": {
			const result = await editor.edit(operation);
			return {
				sessionId: result.sessionId,
				queuedTurns: result.queuedTurns,
				...result.live === void 0 ? {} : { live: result.live }
			};
		}
		case "reroll": {
			const result = await editor.reroll(operation);
			return {
				sessionId: result.sessionId,
				queuedTurns: result.queuedTurns,
				...result.live === void 0 ? {} : { live: result.live }
			};
		}
		case "retry": {
			const result = await editor.retry(operation);
			return {
				sessionId: result.sessionId,
				queuedTurns: result.queuedTurns,
				...result.live === void 0 ? {} : { live: result.live }
			};
		}
		case "rewind":
			await editor.rewind(operation.sessionId, operation.toBoundary);
			return {
				sessionId: operation.sessionId,
				queuedTurns: 0
			};
		case "recall": {
			const result = await editor.recall(operation);
			return {
				sessionId: result.sessionId,
				queuedTurns: result.queuedTurns,
				...result.live === void 0 ? {} : { live: result.live }
			};
		}
		case "fork": return {
			sessionId: await editor.fork(operation.sessionId, operation.atSeq, operation.childSessionId),
			queuedTurns: 0
		};
	}
}
async function handleRoute(editor, request, response) {
	try {
		if (request.method === "GET") {
			respondJson(response, 200, await readTimeline(editor, sessionIdOf(new URL(request.url ?? "/session-editor", "http://session-editor.local").searchParams.get("sessionId"))));
			return;
		}
		if (request.method === "POST") {
			respondJson(response, 200, await runOperation(editor, decodeOperation(await requestJson(request))));
			return;
		}
		response.writeHead(405);
		response.end();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		respondJson(response, error instanceof TypeError ? 400 : 409, { error: message });
	}
}
function registerHttpRoutes(ctx) {
	ctx.effect(() => {
		const webServer = ctx.get("webServer");
		if (webServer === void 0) return () => {};
		const editor = ctx.sessionEditor;
		return webServer.register({
			kind: "exact",
			path: SESSION_EDITOR_PATH,
			handler: (request, response) => handleRoute(editor, request, response)
		});
	}, "session-editor: HTTP route");
	let connectionRouteDispose;
	let connectionRouteRegistered = false;
	const registerConnectionRoute = () => {
		const connection = ctx.get("connection", false);
		if (typeof connectionRouteDispose === "function") { try { connectionRouteDispose(); } catch (error) { void error; } }
		else if (connectionRouteRegistered) return;
		if (connection === void 0) return;
		connectionRouteRegistered = true;
		const editor = ctx.sessionEditor;
		connectionRouteDispose = ctx.effect(() => connection.fetch.register({
			path: `/api${SESSION_EDITOR_PATH}`,
			methods: ["GET", "POST"],
			requestBody: "buffered",
			fetch: (request) => handleFetchRoute(editor, request)
		}), "session-editor: connection fetch route");
	};
	ctx.on("internal/service", (name) => {
		if (name === "connection") registerConnectionRoute();
	});
	registerConnectionRoute();
}
/** connection.fetch 路由的 Fetch 形态处理（与 webServer 的 node:http 形态同语义）。 */
async function handleFetchRoute(editor, request) {
	try {
		if (request.method === "GET") return jsonResponse(200, await readTimeline(editor, sessionIdOf(new URL(request.url).searchParams.get("sessionId"))));
		if (request.method === "POST") return jsonResponse(200, await runOperation(editor, decodeOperation(await request.json())));
		return new Response(null, { status: 405 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return jsonResponse(error instanceof TypeError ? 400 : 409, { error: message });
	}
}
function jsonResponse(status, value) {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		}
	});
}
//#endregion
export { SessionEditor as n, SESSION_EDITOR_PATH as r, SESSION_BRANCH_VERSION_SCHEMA$1 as t };
