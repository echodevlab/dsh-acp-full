// src/server/cli.ts
var PROTOCOL_VALUES = ["v1", "v2", "auto"];
var CLIENT_VALUES = ["devin"];
function parseCliOverrides(ctx) {
  const service = ctx.get("cmdlineArgs");
  const args = service?.get?.() ?? [];
  const overrides = {};
  for (let i = 0;i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--"))
      continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    const value = inline !== undefined ? inline : args[i + 1];
    switch (key) {
      case "protocol":
        if (value && PROTOCOL_VALUES.includes(value))
          overrides.protocol = value;
        break;
      case "client":
        if (value && CLIENT_VALUES.includes(value))
          overrides.client = value;
        break;
      case "provider":
        if (value)
          overrides.provider = value;
        break;
      case "model":
        if (value)
          overrides.model = value;
        break;
      case "max-tokens":
        if (value !== undefined) {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0)
            overrides.maxTokens = n;
        }
        break;
    }
    if (inline === undefined && value !== undefined && value !== arg)
      i++;
  }
  return overrides;
}
function mergeConfig(config, overrides) {
  return {
    ...config,
    ...overrides.protocol !== undefined ? { protocol: overrides.protocol } : {},
    ...overrides.client !== undefined ? { client: overrides.client } : {},
    ...overrides.provider !== undefined ? { provider: overrides.provider } : {},
    ...overrides.model !== undefined ? { model: overrides.model } : {},
    ...overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}
  };
}

// src/server/bridge.ts
import { randomUUID } from "node:crypto";
import { SessionId, foldRequestHeader } from "@deepseek-ai/dsh-session";
import { SANDBOX_MODES, setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";

class DshBridge {
  ctx;
  config;
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }
  agentOptions(model) {
    return {
      ...model !== undefined ? { provider: model.provider, model: model.model } : {
        ...this.config.provider !== undefined ? { provider: this.config.provider } : {},
        ...this.config.model !== undefined ? { model: this.config.model } : {}
      },
      ...this.config.maxTokens !== undefined ? { maxTokens: this.config.maxTokens } : {}
    };
  }
  async createSession(spec) {
    const sessionId = SessionId(`acp-${randomUUID()}`);
    const options = {
      sessionId,
      meta: {
        cwd: spec.cwd,
        ...spec.parentSession !== undefined ? { parentSession: spec.parentSession } : {}
      },
      ...spec.seed !== undefined && spec.seed.length > 0 ? { seed: spec.seed } : {},
      agentOptions: this.agentOptions(spec.model)
    };
    return await this.ctx.agents.create(options);
  }
  async resumeSession(sessionId, model) {
    const options = {
      resumeSessionId: SessionId(sessionId),
      agentOptions: this.agentOptions(model)
    };
    return await this.ctx.agents.resume(options);
  }
  async readSessionEvents(sessionId) {
    const live = this.ctx.sessions.get(SessionId(sessionId));
    if (live)
      return live.events;
    const query = this.ctx.get("session-query");
    if (query) {
      const log = await query.readSession(SessionId(sessionId));
      return log.events;
    }
    throw new Error(`session ${sessionId} not found`);
  }
  async listSessions() {
    const query = this.ctx.get("session-query");
    if (query) {
      const records = await query.listSessions();
      return records.map((record) => ({ header: record.header, live: record.live, persisted: record.persisted }));
    }
    return this.ctx.sessions.list().map((session) => ({ header: session.header, live: true, persisted: false }));
  }
  titleFrom(events) {
    for (let i = events.length - 1;i >= 0; i--) {
      const event = events[i];
      if (event?.type === "session/title") {
        const data = event.data;
        if (typeof data.title === "string")
          return data.title;
      }
    }
    return;
  }
  resolvePersistedModel(events) {
    const header = foldRequestHeader(events);
    if (header === undefined)
      return;
    const { provider, model, reasoningEffort } = header.config;
    if (typeof provider !== "string" || typeof model !== "string")
      return;
    return {
      model: { provider, model },
      ...reasoningEffort !== undefined ? { effort: reasoningEffort } : {}
    };
  }
  forkSeed(events) {
    let boundary = -1;
    for (let i = 0;i < events.length; i++) {
      if (events[i]?.type === "turn/end")
        boundary = i;
    }
    return events.slice(0, boundary + 1);
  }
  listProviders() {
    const llm = this.ctx.get("llm");
    if (!llm?.listProviders)
      return [];
    return llm.listProviders().map((provider) => ({
      providerId: provider.id,
      name: provider.name,
      supported: [],
      required: true
    }));
  }
  async listAllModels() {
    const llm = this.ctx.get("llm");
    if (!llm?.listProviders || !llm.listModels)
      return [];
    const providers = llm.listProviders();
    const result = [];
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.id);
        result.push({ providerId: provider.id, providerName: provider.name, models });
      } catch {}
    }
    return result;
  }
  async resolveModelReasoning(provider, model) {
    const llm = this.ctx.get("llm");
    if (!llm?.resolveModelInfo)
      return [];
    try {
      const info = await llm.resolveModelInfo(provider, model);
      return info.reasoning?.efforts ?? [];
    } catch {
      return [];
    }
  }
  async listPresets() {
    const presets = this.ctx.get("agentPresets");
    if (!presets?.list)
      return [];
    try {
      return await presets.list();
    } catch {
      return [];
    }
  }
  async recomposePreset(agentCtx, presetId) {
    const presets = this.ctx.get("agentPresets");
    if (!presets?.recompose)
      throw new Error("agent presets service is not available; cannot switch mode");
    await presets.recompose(agentCtx, presetId);
  }
  sandboxModes() {
    return SANDBOX_MODES;
  }
  resolveSandboxMode(session) {
    const policy = this.ctx.get("sandboxPolicy");
    if (!policy)
      return;
    return policy.resolve({ session }).mode;
  }
  defaultSandboxMode() {
    const policy = this.ctx.get("sandboxPolicy");
    return policy?.defaultMode;
  }
  setSandboxMode(session, mode) {
    const policy = this.ctx.get("sandboxPolicy");
    if (!policy)
      throw new Error("sandbox policy service is not available; cannot switch sandbox mode");
    setSandboxMode(session, mode);
  }
}

// src/server/mapping.ts
function assistantMessageId(turn, step) {
  return `assistant-${turn}-${step}`;
}
function toolKindFor(name) {
  if (/(shell|bash|terminal|exec|run|process)/i.test(name))
    return "execute";
  if (/(todo|plan|think)/i.test(name))
    return "think";
  if (/(read|cat|list|ls|glob)/i.test(name))
    return "read";
  if (/(grep|search|find|rg)/i.test(name))
    return "search";
  if (/(write|edit|patch|replace|create|remove|delete)/i.test(name))
    return "edit";
  if (/(fetch|http|web|url)/i.test(name))
    return "fetch";
  return "other";
}
function stopReasonFor(reason) {
  switch (reason.kind) {
    case "completed":
      return "end_turn";
    case "interrupted":
    case "aborted":
      return "cancelled";
    default: {
      const kind = reason.kind;
      if (kind === "max-tokens")
        return "max_tokens";
      return "end_turn";
    }
  }
}
function contentToNeutral(blocks) {
  const result = [];
  for (const block of blocks) {
    if (block.type === "text")
      result.push({ type: "text", text: block.text });
    else if (block.type === "image")
      result.push({ type: "image", ref: block.attachment });
  }
  return result;
}
function neutralToText(content) {
  const parts = [];
  for (const item of content)
    if (item.type === "text")
      parts.push(item.text);
  return parts.join(`
`);
}
var MAX_TOOL_OUTPUT_CHARS = 64 * 1024;
function clipText(text) {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS)
    return text;
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + `
[output truncated]`;
}
function parseArguments(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
function diffsFromResultMeta(meta) {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta))
    return [];
  const diffs = meta.diffs;
  if (!Array.isArray(diffs) || diffs.length === 0)
    return [];
  const result = [];
  for (const item of diffs) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return [];
    const { path, oldText, newText } = item;
    if (typeof path !== "string")
      return [];
    if (oldText !== null && typeof oldText !== "string")
      return [];
    if (typeof newText !== "string")
      return [];
    result.push({ path, oldText, newText });
  }
  return result;
}
function mapSessionEvent(event) {
  const { type, data } = event;
  const rawType = type;
  if (rawType === "plan/mode") {
    const active = data.active;
    return [{ kind: "current_mode_update", modeId: active === true ? "plan" : "default" }];
  }
  if (rawType === "session/title") {
    const title = data.title;
    return typeof title === "string" ? [{ kind: "session_info_update", title }] : [];
  }
  switch (type) {
    case "user/message": {
      const message = data;
      const content = contentToNeutral(message.content);
      if (content.length === 0)
        return [];
      return content.map((item) => ({ kind: "user_message_chunk", messageId: message.id, content: item }));
    }
    case "assistant/chunk": {
      const { turn, step, chunk } = data;
      const messageId = assistantMessageId(turn, step);
      if (chunk.type === "text-delta") {
        return [{ kind: "agent_message_chunk", messageId, content: { type: "text", text: chunk.text } }];
      }
      if (chunk.type === "reasoning-delta") {
        return [{ kind: "agent_thought_chunk", messageId, content: { type: "text", text: chunk.text } }];
      }
      if (chunk.type === "block-end" && chunk.block.type === "image") {
        return [{ kind: "agent_message_chunk", messageId, content: { type: "image", ref: chunk.block.attachment } }];
      }
      return [];
    }
    case "tool/call": {
      const { callId, name, arguments: raw } = data;
      return [{
        kind: "tool_call",
        toolCallId: callId,
        title: name,
        toolKind: toolKindFor(name),
        status: "in_progress",
        name,
        rawInput: parseArguments(raw)
      }];
    }
    case "tool/result": {
      const { message, error } = data;
      const block = message.content[0];
      const failed = error !== undefined || block?.isError === true;
      const textContent = block ? contentToNeutral(block.content) : undefined;
      const diffs = diffsFromResultMeta(data.meta);
      return [{
        kind: "tool_call_update",
        toolCallId: block?.toolCallId ?? "",
        status: failed ? "failed" : "completed",
        ...failed ? { toolKind: "other" } : {},
        content: textContent !== undefined || diffs.length > 0 ? [...textContent ?? [], ...diffs.map((d) => ({ type: "diff", ...d }))] : undefined
      }];
    }
    case "todo/write": {
      const { todos } = data;
      if (todos.length === 0)
        return [{ kind: "plan_removed" }];
      return [{
        kind: "plan",
        entries: todos.map((todo) => ({ content: todo.content, priority: "medium", status: todo.status }))
      }];
    }
    case "request/header": {
      const { header } = data;
      const tools = header.tools;
      if (!tools || tools.length === 0)
        return [];
      return [{
        kind: "available_commands_update",
        commands: tools.map((tool) => ({ name: tool.name, description: tool.description }))
      }];
    }
    default:
      return [];
  }
}

// src/server/core.ts
class ConnectionCore {
  ctx;
  logger;
  sessions = new Map;
  activeClient = null;
  emitFn = null;
  disposers = [];
  closed = false;
  constructor(ctx, logger) {
    this.ctx = ctx;
    this.logger = logger;
  }
  activate(client, emit) {
    if (this.activeClient)
      return;
    this.activeClient = client;
    this.emitFn = emit;
    this.disposers.push(this.ctx.on("session/event", (session, event) => void this.onSessionEvent(session, event)));
    this.disposers.push(this.ctx.on("agent/status", ({ agent, status }) => void this.onAgentStatus(agent, status)));
    this.disposers.push(this.ctx.on("agent/error", (payload) => this.onAgentError(payload.agent, payload.error)));
  }
  register(handle, selection) {
    const record = {
      sessionId: handle.agent.session.id,
      agent: handle.agent,
      handle,
      inflight: null,
      selection,
      disposeRequestHook: null,
      usage: { input: 0, output: 0 },
      suppressUserMessageId: null
    };
    const dispose = handle.agent.ctx.on("agent/request", async (_payload, next) => {
      const resolved = await next();
      const sel = record.selection;
      const { reasoningEffort: _inherited, ...rest } = resolved;
      return {
        ...rest,
        provider: sel.model.provider,
        model: sel.model.model,
        ...sel.effort !== undefined ? { reasoningEffort: sel.effort } : {}
      };
    });
    record.disposeRequestHook = dispose;
    this.sessions.set(record.sessionId, record);
    return record;
  }
  get(id) {
    return this.sessions.get(id);
  }
  syncAgentModel(record) {
    record.agent.options.provider = record.selection.model.provider;
    record.agent.options.model = record.selection.model.model;
  }
  async replay(record, events) {
    for (const event of events) {
      if (event.type === "assistant/message") {
        const usage = event.data.usage;
        if (usage) {
          record.usage.input += usage.inputTokens;
          record.usage.output += usage.outputTokens;
        }
      }
      const updates = mapSessionEvent(event);
      if (updates.length === 0)
        continue;
      await this.emit(record.sessionId, updates);
    }
  }
  async drive(record, message) {
    if (record.inflight)
      throw new Error("session already has a prompt in flight");
    const beforeInput = record.usage.input;
    const beforeOutput = record.usage.output;
    record.suppressUserMessageId = message.id;
    const stopReason = await new Promise((resolve, reject) => {
      record.inflight = { resolve, reject };
      record.agent.followup(message);
    });
    record.suppressUserMessageId = null;
    return {
      stopReason,
      inputTokens: record.usage.input - beforeInput,
      outputTokens: record.usage.output - beforeOutput
    };
  }
  cancel(record) {
    record.agent.cancel({ kind: "user" });
  }
  async closeSession(id) {
    const record = this.sessions.get(id);
    if (!record)
      return;
    this.sessions.delete(id);
    if (record.inflight) {
      const inflight = record.inflight;
      record.inflight = null;
      inflight.reject(new Error("session closed"));
    }
    record.disposeRequestHook?.();
    await record.handle.dispose();
  }
  async quiesce() {
    if (this.closed)
      return;
    this.closed = true;
    for (const dispose of this.disposers.splice(0))
      dispose();
    this.activeClient = null;
    this.emitFn = null;
    for (const id of this.sessions.keys()) {
      await this.closeSession(id);
    }
  }
  async onApproval(req, next) {
    if (this.closed || !this.activeClient)
      return next();
    const record = this.recordFor(req.agent);
    if (!record)
      return next();
    const client = this.activeClient;
    try {
      const response = await client.request("session/request_permission", {
        sessionId: record.sessionId,
        toolCall: {
          toolCallId: req.callId ?? `approval-${Date.now()}`,
          title: req.toolName,
          name: req.toolName,
          kind: "other",
          status: "pending"
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject once", kind: "reject_once" }
        ]
      });
      const outcome = response.outcome?.outcome;
      if (outcome === "cancelled")
        return "cancelled";
      if (outcome === "selected") {
        if (response.outcome?.optionId === "allow-once")
          return "allowed-once";
        if (response.outcome?.optionId === "reject-once")
          return "rejected";
      }
      return "unavailable";
    } catch (error) {
      this.logger(`permission bridge failed: ${String(error)}`);
      return next();
    }
  }
  recordFor(agent) {
    for (const record of this.sessions.values()) {
      if (record.agent === agent)
        return record;
    }
    return;
  }
  async onSessionEvent(session, event) {
    const record = this.sessions.get(session.id);
    if (!record || record.agent.session !== session)
      return;
    if (event.type === "assistant/message") {
      const usage = event.data.usage;
      if (usage) {
        record.usage.input += usage.inputTokens;
        record.usage.output += usage.outputTokens;
      }
    }
    const updates = mapSessionEvent(event);
    if (record.suppressUserMessageId !== null) {
      for (let i = updates.length - 1;i >= 0; i--) {
        const u = updates[i];
        if (u?.kind === "user_message_chunk" && u.messageId === record.suppressUserMessageId) {
          updates.splice(i, 1);
        }
      }
    }
    if (event.type === "turn/end") {
      const inflight = record.inflight;
      if (inflight) {
        record.inflight = null;
        inflight.resolve(stopReasonFor(event.data.reason));
      }
      updates.push({ kind: "state_update", state: "idle", stopReason: stopReasonFor(event.data.reason) });
    }
    if (updates.length === 0)
      return;
    await this.emit(record.sessionId, updates);
  }
  async onAgentStatus(agent, status) {
    const record = this.recordFor(agent);
    if (!record)
      return;
    await this.emit(record.sessionId, [{ kind: "state_update", state: status }]);
  }
  onAgentError(agent, error) {
    const record = this.recordFor(agent);
    if (!record)
      return;
    const inflight = record.inflight;
    if (inflight) {
      record.inflight = null;
      inflight.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  async emit(sessionId, updates) {
    if (!this.emitFn)
      return;
    try {
      await this.emitFn(sessionId, updates);
    } catch (error) {
      this.logger(`session update emission failed: ${String(error)}`);
    }
  }
}

// src/server/stdio.ts
import { agentProtocolRouter, ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
function createRouter() {
  return agentProtocolRouter();
}
function stdioWireStream() {
  const input = new ReadableStream({
    start(controller) {
      process.stderr.write(`[dsh-acp-full] stdin stream started
`);
      process.stdin.on("data", (chunk) => {
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      });
      process.stdin.on("end", () => {
        process.stderr.write(`[dsh-acp-full] stdin end -> closing stream
`);
        controller.close();
      });
      process.stdin.on("error", (error) => {
        process.stderr.write(`[dsh-acp-full] stdin error: ${String(error)}
`);
        controller.error(error);
      });
    },
    cancel() {
      process.stderr.write(`[dsh-acp-full] stdin stream cancelled
`);
      process.stdin.pause();
    }
  });
  const output = new WritableStream({
    write(chunk) {
      return new Promise((resolve, reject) => {
        process.stdout.write(chunk, (error) => error ? reject(error) : resolve());
      });
    }
  });
  return ndJsonStream(output, input);
}

// src/server/v1.ts
import { isAbsolute } from "node:path";
import { PROTOCOL_VERSION, agent } from "@agentclientprotocol/sdk";
import { SessionId as SessionId2 } from "@deepseek-ai/dsh-session";

// src/server/content.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";

class UnsupportedContentError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedContentError";
  }
}
var SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function decodeBase64(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0;i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function encodeBase64(data) {
  let binary = "";
  for (const byte of data)
    binary += String.fromCharCode(byte);
  return btoa(binary);
}
function renderResourceLink(block) {
  const label = block.title ?? block.name;
  const detail = block.description ? ` ${block.description}` : "";
  return label ? `[${label}] ${block.uri ?? ""}${detail}` : `${block.uri ?? ""}${detail}`;
}
async function acpBlockToDsh(block, attachments) {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text ?? "" };
    case "image": {
      if (!attachments)
        throw new UnsupportedContentError("image content requires the dsh attachment service");
      const mediaType = block.mimeType ?? "";
      if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
        throw new UnsupportedContentError(`unsupported image media type ${mediaType}`);
      }
      const ref = await attachments.saveImage({
        data: decodeBase64(block.data ?? ""),
        mediaType,
        ...block.uri ? { name: block.uri } : {}
      });
      return { type: "image", attachment: ref };
    }
    case "resource_link":
      return { type: "text", text: renderResourceLink(block) };
    case "resource": {
      const resource = block.resource;
      if (!resource)
        throw new UnsupportedContentError("embedded resource block carries no resource payload");
      if (resource.text) {
        return { type: "text", text: `[${resource.uri}] ${resource.text}` };
      }
      if (resource.blob) {
        const mediaType = resource.mimeType;
        if (mediaType && SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
          if (!attachments)
            throw new UnsupportedContentError("image content requires the dsh attachment service");
          const ref = await attachments.saveImage({
            data: decodeBase64(resource.blob),
            mediaType,
            name: resource.uri
          });
          return { type: "image", attachment: ref };
        }
        throw new UnsupportedContentError(`embedded binary resource ${resource.uri} (${mediaType ?? "unknown type"}) is not supported`);
      }
      throw new UnsupportedContentError(`embedded resource ${resource.uri} carries neither text nor blob`);
    }
    case "audio":
      throw new UnsupportedContentError("audio content is not supported by dsh");
    default:
      throw new UnsupportedContentError(`unsupported content block type ${block.type}`);
  }
}
async function acpPromptToUserMessage(blocks, attachments) {
  const content = [];
  for (const block of blocks)
    content.push(await acpBlockToDsh(block, attachments));
  return createUserMessage({ content, source: { kind: "user" } });
}
async function dshImageRefToAcp(ref, attachments) {
  const stored = await attachments.readImage(ref);
  return { type: "image", data: encodeBase64(stored.data), mimeType: stored.ref.mediaType };
}
async function resolveNeutralContent(content, attachments) {
  if (content.type === "text")
    return { type: "text", text: content.text };
  if (content.type === "diff") {
    return {
      type: "diff",
      path: content.path,
      oldText: content.oldText,
      newText: content.newText
    };
  }
  if (!attachments)
    throw new Error("dsh attachment service is required to resolve image content");
  return dshImageRefToAcp(content.ref, attachments);
}

// src/server/config-options.ts
import { SANDBOX_MODES as SANDBOX_MODES2 } from "@deepseek-ai/dsh-sandbox-policy";
var MODEL_CONFIG_ID = "model";
var EFFORT_CONFIG_ID = "effort";
var MODE_CONFIG_ID = "mode";
var SANDBOX_CONFIG_ID = "sandbox";
var SANDBOX_MODES_SET = new Set(SANDBOX_MODES2);
function formatModelValue(selection) {
  return `${selection.provider}/${selection.model}`;
}
function parseModelValue(value) {
  const sep = value.indexOf("/");
  if (sep <= 0)
    return null;
  return { provider: value.slice(0, sep), model: value.slice(sep + 1) };
}
function modelOptionValues(providers) {
  return providers.flatMap((provider) => provider.models.map((model) => ({
    value: `${provider.providerId}/${model.id}`,
    name: `${provider.providerName}/${model.name}`,
    ...model.description !== undefined ? { description: model.description } : {}
  })));
}
function modelConfigDescriptor(providers, current) {
  return {
    id: MODEL_CONFIG_ID,
    name: "Model",
    category: "model",
    type: "select",
    currentValue: formatModelValue(current),
    options: modelOptionValues(providers)
  };
}
function modeConfigDescriptor(presets, currentMode) {
  return {
    id: MODE_CONFIG_ID,
    name: "Mode",
    description: "Agent preset (Standard / PTC / Minimal / …)",
    category: "mode",
    type: "select",
    currentValue: currentMode,
    options: presets.map((p) => ({ value: p.id, name: p.name, ...p.description !== undefined ? { description: p.description } : {} }))
  };
}
function effortConfigDescriptor(efforts, currentEffort) {
  if (efforts.length === 0)
    return null;
  const current = currentEffort !== undefined && efforts.some((e) => e.value === currentEffort) ? currentEffort : efforts[0].value;
  return {
    id: EFFORT_CONFIG_ID,
    name: "Effort",
    description: "Available effort levels for this model",
    category: "thought_level",
    type: "select",
    currentValue: current,
    options: efforts.map((e) => ({ value: e.value, name: e.name, ...e.description !== undefined ? { description: e.description } : {} }))
  };
}
var SANDBOX_MODE_NAMES = {
  "read-only": "Read only",
  "workspace-write": "Workspace write",
  "danger-full-access": "Full access"
};
function sandboxConfigDescriptor(modes, currentSandbox) {
  if (modes.length === 0)
    return null;
  const current = currentSandbox ?? modes[0];
  return {
    id: SANDBOX_CONFIG_ID,
    name: "Sandbox",
    description: "File-effect sandbox mode for shell and filesystem operations",
    category: "sandbox",
    type: "select",
    currentValue: current,
    options: modes.map((m) => ({ value: m, name: SANDBOX_MODE_NAMES[m] ?? m }))
  };
}
function sessionConfigDescriptors(selection, presets, providers, efforts, sandboxModes = []) {
  const effort = effortConfigDescriptor(efforts, selection.effort);
  const sandbox = sandboxConfigDescriptor(sandboxModes, selection.sandbox);
  return [
    modeConfigDescriptor(presets, selection.mode),
    modelConfigDescriptor(providers, selection.model),
    ...effort ? [effort] : [],
    ...sandbox ? [sandbox] : []
  ];
}
function applyConfigOption(current, configId, value) {
  if (typeof value !== "string")
    return null;
  switch (configId) {
    case MODE_CONFIG_ID:
      return { ...current, mode: value };
    case MODEL_CONFIG_ID: {
      const parsed = parseModelValue(value);
      if (parsed === null)
        return null;
      return { ...current, model: parsed, effort: undefined };
    }
    case EFFORT_CONFIG_ID:
      return { ...current, effort: value };
    case SANDBOX_CONFIG_ID: {
      if (!SANDBOX_MODES_SET.has(value))
        return null;
      return { ...current, sandbox: value };
    }
    default:
      return null;
  }
}
function descriptorsToV1(descriptors) {
  return descriptors.map((d) => ({
    id: d.id,
    name: d.name,
    ...d.description !== undefined ? { description: d.description } : {},
    category: d.category,
    type: "select",
    currentValue: d.currentValue,
    options: d.options.map((o) => ({ value: o.value, name: o.name, ...o.description !== undefined ? { description: o.description } : {} }))
  }));
}
function descriptorsToV2(descriptors) {
  return descriptors.map((d) => ({
    configId: d.id,
    name: d.name,
    ...d.description !== undefined ? { description: d.description } : {},
    category: d.category,
    type: "select",
    currentValue: d.currentValue,
    options: d.options.map((o) => ({ value: o.value, name: o.name, ...o.description !== undefined ? { description: o.description } : {} }))
  }));
}

// src/server/v1.ts
function modesFromPresets(presets, currentMode) {
  return {
    currentModeId: currentMode,
    availableModes: presets.map((p) => ({ id: p.id, name: p.name }))
  };
}
var TODO_PLAN_ID = "dsh-todo";
async function resolveInitialSelection(bridge, config, persisted) {
  const [presets, providers] = await Promise.all([bridge.listPresets(), bridge.listAllModels()]);
  const provider = persisted?.model.provider ?? config.provider ?? providers[0]?.providerId ?? "";
  const model = persisted?.model.model ?? config.model ?? providers[0]?.models[0]?.id ?? "";
  const mode = presets[0]?.id ?? "standard";
  const sandboxModes = bridge.sandboxModes();
  const sandbox = config.sandbox ?? bridge.defaultSandboxMode();
  const selection = {
    mode,
    model: { provider, model },
    ...persisted?.effort !== undefined ? { effort: persisted.effort } : {},
    ...sandbox !== undefined ? { sandbox } : {}
  };
  const rawEfforts = await bridge.resolveModelReasoning(provider, model);
  const efforts = rawEfforts.map((e) => ({ value: e.id, name: e.name, ...e.description !== undefined ? { description: e.description } : {} }));
  return { selection, presets, providers, efforts, sandboxModes };
}
function sessionSetupExtras(selection, presets, providers, efforts, sandboxModes, config) {
  if (config.client === "devin") {
    return { configOptions: descriptorsToV1(sessionConfigDescriptors(selection, presets, providers, efforts, sandboxModes)) };
  }
  return { modes: modesFromPresets(presets, selection.mode) };
}
var AGENT_CAPABILITIES = {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: true },
  sessionCapabilities: {
    list: {},
    fork: {},
    resume: {},
    close: {},
    additionalDirectories: {}
  }
};
async function toV1Update(update, attachments) {
  switch (update.kind) {
    case "user_message_chunk":
      return {
        sessionUpdate: "user_message_chunk",
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments)
      };
    case "agent_message_chunk":
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments)
      };
    case "agent_thought_chunk":
      return {
        sessionUpdate: "agent_thought_chunk",
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments)
      };
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.toolKind,
        status: update.status,
        name: update.name,
        rawInput: update.rawInput
      };
    case "tool_call_update": {
      const rawOutput = update.content ? clipText(neutralToText(update.content)) : undefined;
      const diffContent = update.content?.filter((c) => c.type === "diff") ?? [];
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: update.toolCallId,
        status: update.status,
        ...update.toolKind !== undefined ? { kind: update.toolKind } : {},
        ...rawOutput !== undefined ? { rawOutput } : {},
        ...diffContent.length > 0 ? {
          content: await Promise.all(diffContent.map((c) => resolveNeutralContent(c, attachments)))
        } : {}
      };
    }
    case "plan":
      return { sessionUpdate: "plan", entries: update.entries.map((entry) => ({ ...entry })) };
    case "plan_removed":
      return { sessionUpdate: "plan_removed", planId: TODO_PLAN_ID };
    case "current_mode_update":
      return { sessionUpdate: "current_mode_update", currentModeId: update.modeId };
    case "session_info_update":
      return { sessionUpdate: "session_info_update", title: update.title };
    case "available_commands_update":
      return {
        sessionUpdate: "available_commands_update",
        availableCommands: update.commands.map((command) => ({ name: command.name, description: command.description }))
      };
    case "state_update":
      return null;
  }
}
async function emitV1(client, sessionId, updates, attachments) {
  for (const update of updates) {
    const wire = await toV1Update(update, attachments);
    if (!wire)
      continue;
    await client.notify("session/update", { sessionId, update: wire });
  }
}
function createV1App(core, bridge, config, attachments, logger) {
  const app = agent();
  app.onRequest("initialize", ({ client }) => {
    core.activate(client, (sessionId, updates) => emitV1(client, sessionId, updates, attachments));
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: AGENT_CAPABILITIES };
  });
  app.onRequest("session/new", async ({ params }) => {
    if (!isAbsolute(params.cwd))
      throw new Error(`cwd must be an absolute path: ${params.cwd}`);
    if (params.mcpServers && params.mcpServers.length > 0) {
      logger(`session/new ignored ${params.mcpServers.length} mcpServers (dsh configures MCP servers through its own plugins)`);
    }
    const { selection, presets, providers, efforts, sandboxModes } = await resolveInitialSelection(bridge, config);
    const handle = await bridge.createSession({ cwd: params.cwd, model: selection.model });
    if (config.sandbox !== undefined) {
      try {
        bridge.setSandboxMode(handle.agent.session, config.sandbox);
      } catch (error) {
        logger(`sandbox override failed: ${String(error)}`);
      }
    }
    const record = core.register(handle, selection);
    return { sessionId: record.sessionId, ...sessionSetupExtras(record.selection, presets, providers, efforts, sandboxModes, config) };
  });
  app.onRequest("session/load", async ({ params }) => {
    if (!isAbsolute(params.cwd))
      throw new Error(`cwd must be an absolute path: ${params.cwd}`);
    if (params.mcpServers && params.mcpServers.length > 0) {
      logger(`session/load ignored ${params.mcpServers.length} mcpServers (dsh configures MCP servers through its own plugins)`);
    }
    const events = await bridge.readSessionEvents(params.sessionId);
    const persisted = bridge.resolvePersistedModel(events);
    const { selection, presets, providers, efforts, sandboxModes } = await resolveInitialSelection(bridge, config, persisted);
    const handle = await bridge.resumeSession(params.sessionId, selection.model);
    const resumedSandbox = bridge.resolveSandboxMode(handle.agent.session);
    const record = core.register(handle, { ...selection, ...resumedSandbox !== undefined ? { sandbox: resumedSandbox } : {} });
    await core.replay(record, handle.agent.session.events);
    return sessionSetupExtras(record.selection, presets, providers, efforts, sandboxModes, config);
  });
  app.onRequest("session/fork", async ({ params }) => {
    if (!isAbsolute(params.cwd))
      throw new Error(`cwd must be an absolute path: ${params.cwd}`);
    const parent = core.get(SessionId2(params.sessionId));
    if (!parent)
      throw new Error(`session ${params.sessionId} is not live on this connection; fork requires a live parent`);
    const events = await bridge.readSessionEvents(params.sessionId);
    const handle = await bridge.createSession({
      cwd: params.cwd,
      model: parent.selection.model,
      seed: bridge.forkSeed(events),
      parentSession: SessionId2(params.sessionId)
    });
    const sandboxModes = bridge.sandboxModes();
    const inheritedSandbox = bridge.resolveSandboxMode(handle.agent.session);
    const record = core.register(handle, { ...parent.selection, ...inheritedSandbox !== undefined ? { sandbox: inheritedSandbox } : {} });
    const [presets, rawEfforts] = await Promise.all([
      bridge.listPresets(),
      bridge.resolveModelReasoning(record.selection.model.provider, record.selection.model.model)
    ]);
    const efforts = rawEfforts.map((e) => ({ value: e.id, name: e.name, ...e.description !== undefined ? { description: e.description } : {} }));
    const providers = await bridge.listAllModels();
    return { sessionId: record.sessionId, ...sessionSetupExtras(record.selection, presets, providers, efforts, sandboxModes, config) };
  });
  app.onRequest("session/list", async () => {
    const listed = await bridge.listSessions();
    const sessions = [];
    for (const item of listed) {
      if (item.header.cwd === undefined)
        continue;
      sessions.push({
        sessionId: item.header.id,
        cwd: item.header.cwd,
        updatedAt: new Date(item.header.createdAt).toISOString()
      });
    }
    return { sessions };
  });
  app.onRequest("session/delete", () => {
    throw new Error("session deletion is not supported: dsh persisted logs are append-only");
  });
  app.onRequest("session/resume", async ({ params }) => {
    const events = await bridge.readSessionEvents(params.sessionId);
    const persisted = bridge.resolvePersistedModel(events);
    const { selection, presets, providers, efforts, sandboxModes } = await resolveInitialSelection(bridge, config, persisted);
    const handle = await bridge.resumeSession(params.sessionId, selection.model);
    const resumedSandbox = bridge.resolveSandboxMode(handle.agent.session);
    const record = core.register(handle, { ...selection, ...resumedSandbox !== undefined ? { sandbox: resumedSandbox } : {} });
    return sessionSetupExtras(record.selection, presets, providers, efforts, sandboxModes, config);
  });
  app.onRequest("session/close", async ({ params }) => {
    await core.closeSession(SessionId2(params.sessionId));
  });
  app.onRequest("session/prompt", async ({ params }) => {
    const record = core.get(SessionId2(params.sessionId));
    if (!record)
      throw new Error(`unknown session ${params.sessionId}`);
    const message = await acpPromptToUserMessage(params.prompt, attachments);
    const outcome = await core.drive(record, message);
    const total = outcome.inputTokens + outcome.outputTokens;
    return {
      stopReason: outcome.stopReason,
      ...total > 0 ? {
        usage: { totalTokens: total, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens }
      } : {}
    };
  });
  app.onRequest("session/set_mode", async ({ params, client }) => {
    const record = core.get(SessionId2(params.sessionId));
    if (!record)
      throw new Error(`unknown session ${params.sessionId}`);
    if (params.modeId !== record.selection.mode) {
      await bridge.recomposePreset(record.agent.ctx, params.modeId);
    }
    record.selection = { ...record.selection, mode: params.modeId };
    await client.notify("session/update", {
      sessionId: record.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId }
    });
    return {};
  });
  app.onRequest("session/set_config_option", async ({ params }) => {
    if (config.client !== "devin") {
      throw new Error("session config options are not supported by dsh");
    }
    const record = core.get(SessionId2(params.sessionId));
    if (!record)
      throw new Error(`unknown session ${params.sessionId}`);
    const next = applyConfigOption(record.selection, params.configId, params.value);
    if (next === null)
      throw new Error(`unsupported config option ${params.configId} or value ${String(params.value)}`);
    if (params.configId === "mode" && next.mode !== record.selection.mode) {
      await bridge.recomposePreset(record.agent.ctx, next.mode);
    }
    if (params.configId === "sandbox" && next.sandbox !== record.selection.sandbox) {
      try {
        bridge.setSandboxMode(record.agent.session, next.sandbox);
      } catch (error) {
        logger(`sandbox switch failed: ${String(error)}`);
      }
    }
    record.selection = next;
    if (params.configId === "model") {
      core.syncAgentModel(record);
    }
    const [presets, providers, rawEfforts] = await Promise.all([
      bridge.listPresets(),
      bridge.listAllModels(),
      bridge.resolveModelReasoning(next.model.provider, next.model.model)
    ]);
    const efforts = rawEfforts.map((e) => ({ value: e.id, name: e.name, ...e.description !== undefined ? { description: e.description } : {} }));
    return { configOptions: descriptorsToV1(sessionConfigDescriptors(next, presets, providers, efforts, bridge.sandboxModes())) };
  });
  app.onRequest("authenticate", () => {
    throw new Error("authentication is not supported by dsh-acp-full");
  });
  app.onRequest("providers/list", () => ({ providers: bridge.listProviders() }));
  app.onRequest("providers/set", () => {
    throw new Error("provider selection is owned by the dsh deployment configuration");
  });
  app.onRequest("providers/disable", () => {
    throw new Error("provider selection is owned by the dsh deployment configuration");
  });
  app.onRequest("logout", () => {
    throw new Error("authentication is not supported by dsh-acp-full");
  });
  app.onRequest("nes/start", () => {
    throw new Error("NES is not supported by dsh");
  });
  app.onRequest("nes/suggest", () => {
    throw new Error("NES is not supported by dsh");
  });
  app.onRequest("nes/close", () => {
    throw new Error("NES is not supported by dsh");
  });
  app.onNotification("session/cancel", ({ params }) => {
    const record = core.get(SessionId2(params.sessionId));
    if (record)
      core.cancel(record);
  });
  app.onNotification("document/didOpen", ({ params }) => {
    logger(`ignored document/didOpen for ${params.uri ?? ""}`);
  });
  app.onNotification("document/didChange", ({ params }) => {
    logger(`ignored document/didChange for ${params.uri ?? ""}`);
  });
  app.onNotification("document/didClose", ({ params }) => {
    logger(`ignored document/didClose for ${params.uri ?? ""}`);
  });
  app.onNotification("document/didSave", ({ params }) => {
    logger(`ignored document/didSave for ${params.uri ?? ""}`);
  });
  app.onNotification("document/didFocus", ({ params }) => {
    logger(`ignored document/didFocus for ${params.uri ?? ""}`);
  });
  app.onNotification("nes/accept", () => {
    logger("ignored nes/accept");
  });
  app.onNotification("nes/reject", () => {
    logger("ignored nes/reject");
  });
  return app;
}

// src/server/v2.ts
import { isAbsolute as isAbsolute2 } from "node:path";
import { PROTOCOL_VERSION as PROTOCOL_VERSION2, agent as agent2 } from "@agentclientprotocol/sdk/experimental/v2";
import { SessionId as SessionId3 } from "@deepseek-ai/dsh-session";
var TODO_PLAN_ID2 = "dsh-todo";
async function resolveInitialSelection2(bridge, config, persisted) {
  const [presets, providers] = await Promise.all([bridge.listPresets(), bridge.listAllModels()]);
  const provider = persisted?.model.provider ?? config.provider ?? providers[0]?.providerId ?? "";
  const model = persisted?.model.model ?? config.model ?? providers[0]?.models[0]?.id ?? "";
  const mode = presets[0]?.id ?? "standard";
  const sandboxModes = bridge.sandboxModes();
  const sandbox = config.sandbox ?? bridge.defaultSandboxMode();
  const selection = {
    mode,
    model: { provider, model },
    ...persisted?.effort !== undefined ? { effort: persisted.effort } : {},
    ...sandbox !== undefined ? { sandbox } : {}
  };
  const rawEfforts = await bridge.resolveModelReasoning(provider, model);
  const efforts = rawEfforts.map((e) => ({ value: e.id, name: e.name, ...e.description !== undefined ? { description: e.description } : {} }));
  return { selection, presets, providers, efforts, sandboxModes };
}
var CAPABILITIES = {
  session: {
    prompt: { image: {}, embeddedContext: {} },
    fork: {},
    additionalDirectories: {}
  }
};
async function toV2Update(update, attachments) {
  switch (update.kind) {
    case "user_message_chunk":
      return {
        sessionUpdate: "user_message_chunk",
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments)
      };
    case "agent_message_chunk":
      return {
        sessionUpdate: "agent_message_chunk",
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments)
      };
    case "agent_thought_chunk":
      return {
        sessionUpdate: "agent_thought_chunk",
        messageId: update.messageId,
        content: await resolveNeutralContent(update.content, attachments)
      };
    case "tool_call":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: update.toolCallId,
        name: update.name,
        title: update.title,
        kind: update.toolKind,
        status: update.status,
        rawInput: update.rawInput
      };
    case "tool_call_update":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: update.toolCallId,
        status: update.status,
        ...update.toolKind !== undefined ? { kind: update.toolKind } : {}
      };
    case "plan":
      return {
        sessionUpdate: "plan_update",
        plan: { type: "items", planId: TODO_PLAN_ID2, entries: update.entries.map((entry) => ({ ...entry })) }
      };
    case "plan_removed":
      return { sessionUpdate: "plan_removed", planId: TODO_PLAN_ID2 };
    case "current_mode_update":
      return null;
    case "session_info_update":
      return { sessionUpdate: "session_info_update", title: update.title };
    case "available_commands_update":
      return {
        sessionUpdate: "available_commands_update",
        availableCommands: update.commands.map((command) => ({ name: command.name, description: command.description }))
      };
    case "state_update":
      return {
        sessionUpdate: "state_update",
        state: update.state,
        ...update.stopReason !== undefined ? { stopReason: update.stopReason } : {}
      };
  }
}
async function resolveToolCallContent(content, attachments) {
  if (content.type === "diff") {
    const operation = content.oldText === null ? "add" : "modify";
    return {
      type: "diff",
      changes: [{ operation, path: content.path, fileType: "text" }],
      patch: { format: "git_patch", text: toGitPatch(content.path, content.oldText, content.newText) }
    };
  }
  return { type: "content", content: await resolveNeutralContent(content, attachments) };
}
function toGitPatch(path, oldText, newText) {
  const header = oldText === null ? `diff --git a/${path} b/${path}
new file mode 100644
--- /dev/null
+++ b/${path}
` : `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
`;
  const oldLines = (oldText ?? "").split(`
`);
  const newLines = newText.split(`
`);
  const hunkHeader = `@@ -1,${oldLines.length} +1,${newLines.length} @@
`;
  const body = oldLines.map((l) => `-${l}`).join(`
`) + (oldLines.length > 0 ? `
` : "") + newLines.map((l) => `+${l}`).join(`
`);
  return header + hunkHeader + body + `
`;
}
async function emitV2(client, sessionId, updates, attachments) {
  for (const update of updates) {
    if (update.kind === "tool_call_update" && update.content && update.content.length > 0) {
      for (const content of update.content) {
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: update.toolCallId,
            content: await resolveToolCallContent(content, attachments)
          }
        });
      }
    }
    const wire = await toV2Update(update, attachments);
    if (wire)
      await client.notify("session/update", { sessionId, update: wire });
  }
}
function createV2App(core, bridge, config, attachments, logger) {
  const app = agent2();
  app.onRequest("initialize", ({ client }) => {
    core.activate(client, (sessionId, updates) => emitV2(client, sessionId, updates, attachments));
    return {
      protocolVersion: PROTOCOL_VERSION2,
      info: { name: "dsh-acp-full", title: "DeepSeek Harness ACP Server", version: "0.1.0" },
      capabilities: CAPABILITIES
    };
  });
  app.onRequest("session/new", async ({ params }) => {
    if (!isAbsolute2(params.cwd))
      throw new Error(`cwd must be an absolute path: ${params.cwd}`);
    if (params.mcpServers && params.mcpServers.length > 0) {
      logger(`session/new ignored ${params.mcpServers.length} mcpServers (dsh configures MCP servers through its own plugins)`);
    }
    const { selection, presets, providers, efforts, sandboxModes } = await resolveInitialSelection2(bridge, config);
    const handle = await bridge.createSession({ cwd: params.cwd, model: selection.model });
    if (config.sandbox !== undefined) {
      try {
        bridge.setSandboxMode(handle.agent.session, config.sandbox);
      } catch (error) {
        logger(`sandbox override failed: ${String(error)}`);
      }
    }
    const record = core.register(handle, selection);
    return { sessionId: record.sessionId, configOptions: descriptorsToV2(sessionConfigDescriptors(record.selection, presets, providers, efforts, sandboxModes)) };
  });
  app.onRequest("session/prompt", async ({ params }) => {
    const record = core.get(SessionId3(params.sessionId));
    if (!record)
      throw new Error(`unknown session ${params.sessionId}`);
    const prompt = params.prompt;
    const message = await acpPromptToUserMessage(prompt, attachments);
    await core.drive(record, message);
    return {};
  });
  app.onRequest("session/list", async () => {
    const listed = await bridge.listSessions();
    const sessions = [];
    for (const item of listed) {
      if (item.header.cwd === undefined)
        continue;
      sessions.push({
        sessionId: item.header.id,
        cwd: item.header.cwd,
        updatedAt: new Date(item.header.createdAt).toISOString()
      });
    }
    return { sessions };
  });
  app.onRequest("session/delete", () => {
    throw new Error("session deletion is not supported: dsh persisted logs are append-only");
  });
  app.onRequest("session/fork", async ({ params }) => {
    if (!isAbsolute2(params.cwd))
      throw new Error(`cwd must be an absolute path: ${params.cwd}`);
    const parent = core.get(SessionId3(params.sessionId));
    if (!parent)
      throw new Error(`session ${params.sessionId} is not live on this connection; fork requires a live parent`);
    const events = await bridge.readSessionEvents(params.sessionId);
    const handle = await bridge.createSession({
      cwd: params.cwd,
      model: parent.selection.model,
      seed: bridge.forkSeed(events),
      parentSession: SessionId3(params.sessionId)
    });
    const sandboxModes = bridge.sandboxModes();
    const inheritedSandbox = bridge.resolveSandboxMode(handle.agent.session);
    const record = core.register(handle, { ...parent.selection, ...inheritedSandbox !== undefined ? { sandbox: inheritedSandbox } : {} });
    const [presets, providers, rawEfforts] = await Promise.all([
      bridge.listPresets(),
      bridge.listAllModels(),
      bridge.resolveModelReasoning(record.selection.model.provider, record.selection.model.model)
    ]);
    const efforts = rawEfforts.map((e) => ({ value: e.id, name: e.name, ...e.description !== undefined ? { description: e.description } : {} }));
    return { sessionId: record.sessionId, configOptions: descriptorsToV2(sessionConfigDescriptors(record.selection, presets, providers, efforts, sandboxModes)) };
  });
  app.onRequest("session/resume", async ({ params }) => {
    const events = await bridge.readSessionEvents(params.sessionId);
    const persisted = bridge.resolvePersistedModel(events);
    const { selection, presets, providers, efforts, sandboxModes } = await resolveInitialSelection2(bridge, config, persisted);
    const handle = await bridge.resumeSession(params.sessionId, selection.model);
    const resumedSandbox = bridge.resolveSandboxMode(handle.agent.session);
    const record = core.register(handle, { ...selection, ...resumedSandbox !== undefined ? { sandbox: resumedSandbox } : {} });
    return { configOptions: descriptorsToV2(sessionConfigDescriptors(record.selection, presets, providers, efforts, sandboxModes)) };
  });
  app.onRequest("session/close", async ({ params }) => {
    await core.closeSession(SessionId3(params.sessionId));
  });
  app.onRequest("session/set_config_option", async ({ params }) => {
    const record = core.get(SessionId3(params.sessionId));
    if (!record)
      throw new Error(`unknown session ${params.sessionId}`);
    const next = applyConfigOption(record.selection, params.configId, params.value);
    if (next === null)
      throw new Error(`unsupported config option ${params.configId} or value ${String(params.value)}`);
    if (params.configId === "mode" && next.mode !== record.selection.mode) {
      await bridge.recomposePreset(record.agent.ctx, next.mode);
    }
    if (params.configId === "sandbox" && next.sandbox !== record.selection.sandbox) {
      try {
        bridge.setSandboxMode(record.agent.session, next.sandbox);
      } catch (error) {
        logger(`sandbox switch failed: ${String(error)}`);
      }
    }
    record.selection = next;
    if (params.configId === "model") {
      core.syncAgentModel(record);
    }
    const [presets, providers, rawEfforts] = await Promise.all([
      bridge.listPresets(),
      bridge.listAllModels(),
      bridge.resolveModelReasoning(next.model.provider, next.model.model)
    ]);
    const efforts = rawEfforts.map((e) => ({ value: e.id, name: e.name, ...e.description !== undefined ? { description: e.description } : {} }));
    return { configOptions: descriptorsToV2(sessionConfigDescriptors(next, presets, providers, efforts, bridge.sandboxModes())) };
  });
  app.onRequest("auth/login", () => {
    throw new Error("authentication is not supported by dsh-acp-full");
  });
  app.onRequest("auth/logout", () => {
    throw new Error("authentication is not supported by dsh-acp-full");
  });
  app.onRequest("providers/list", () => ({ providers: bridge.listProviders() }));
  app.onRequest("providers/set", () => {
    throw new Error("provider selection is owned by the dsh deployment configuration");
  });
  app.onRequest("providers/disable", () => {
    throw new Error("provider selection is owned by the dsh deployment configuration");
  });
  app.onRequest("mcp/message", () => {
    throw new Error("client-side MCP connections are not supported; dsh configures MCP servers through its own plugins");
  });
  app.onRequest("nes/start", () => {
    throw new Error("NES is not supported by dsh");
  });
  app.onRequest("nes/suggest", () => {
    throw new Error("NES is not supported by dsh");
  });
  app.onRequest("nes/close", () => {
    throw new Error("NES is not supported by dsh");
  });
  app.onNotification("session/cancel", ({ params }) => {
    const record = core.get(SessionId3(params.sessionId));
    if (record)
      core.cancel(record);
  });
  app.onNotification("mcp/message", () => {
    logger("ignored mcp/message");
  });
  app.onNotification("document/didOpen", ({ params }) => {
    logger(`ignored document/didOpen for ${params.uri ?? ""}`);
  });
  app.onNotification("document/didChange", ({ params }) => {
    logger(`ignored document/didChange for ${params.uri ?? ""}`);
  });
  app.onNotification("document/didClose", ({ params }) => {
    logger(`ignored document/didClose for ${params.uri ?? ""}`);
  });
  app.onNotification("document/didSave", ({ params }) => {
    logger(`ignored document/didSave for ${params.uri ?? ""}`);
  });
  app.onNotification("document/didFocus", ({ params }) => {
    logger(`ignored document/didFocus for ${params.uri ?? ""}`);
  });
  app.onNotification("nes/accept", () => {
    logger("ignored nes/accept");
  });
  app.onNotification("nes/reject", () => {
    logger("ignored nes/reject");
  });
  return app;
}

// src/plugin.ts
var name = "dsh-acp-full";
var inject = ["agents", "sessions"];
function apply(ctx, config) {
  const effective = mergeConfig(config, parseCliOverrides(ctx));
  const logger = (message) => ctx.logger("dsh-acp-full").info(message);
  const bridge = new DshBridge(ctx, effective);
  const core = new ConnectionCore(ctx, logger);
  const attachments = ctx.get("attachments");
  const v1 = createV1App(core, bridge, effective, attachments, logger);
  const v2 = createV2App(core, bridge, effective, attachments, logger);
  const router = createRouter();
  if (effective.protocol !== "v2")
    router.withV1(v1);
  if (effective.protocol !== "v1")
    router.withV2(v2);
  const stream = stdioWireStream();
  const lifecycle = router.connect(stream);
  if (lifecycle && typeof lifecycle === "object" && lifecycle.closed) {
    lifecycle.closed.then(async () => {
      logger("ACP connection closed; shutting down sessions");
      await core.quiesce();
      process.exit(0);
    });
  }
  const disposeApproval = ctx.on("approval/request", (req, next) => core.onApproval(req, next));
  return () => {
    disposeApproval();
    core.quiesce();
  };
}
export {
  toolKindFor,
  stopReasonFor,
  sessionConfigDescriptors,
  parseModelValue,
  parseCliOverrides,
  name,
  modelConfigDescriptor,
  modeConfigDescriptor,
  mergeConfig,
  mapSessionEvent,
  inject,
  formatModelValue,
  effortConfigDescriptor,
  descriptorsToV2,
  descriptorsToV1,
  assistantMessageId,
  applyConfigOption,
  apply,
  UnsupportedContentError,
  MODE_CONFIG_ID,
  MODEL_CONFIG_ID,
  EFFORT_CONFIG_ID,
  DshBridge,
  ConnectionCore
};

//# debugId=D8771833658DF4EA64756E2164756E21
