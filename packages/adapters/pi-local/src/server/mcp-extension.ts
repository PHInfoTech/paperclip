import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Pi has no built-in MCP client, so Paperclip-assigned MCP servers are exposed
 * through a generated extension that speaks MCP streamable HTTP and registers
 * each remote tool with `pi.registerTool()`.
 */
export function piMcpExtensionSource(servers: readonly AdapterRuntimeMcpServer[]): string {
  const configured = servers.map(({ name, url, token }) => ({ name, url, token }));
  return `const servers = ${JSON.stringify(configured)};
const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 60000;
const used = new Set();

function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
}

function toolName(server, tool) {
  const base = (slug(server) + "__" + String(tool).replace(/[^A-Za-z0-9_-]+/g, "_")).slice(0, 64);
  let name = base;
  for (let i = 2; used.has(name); i += 1) name = base.slice(0, 60) + "_" + i;
  used.add(name);
  return name;
}

async function readRpc(response, id) {
  const type = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!type.includes("text/event-stream")) return text ? JSON.parse(text) : null;
  let last = null;
  for (const block of text.split(/\\r?\\n\\r?\\n/)) {
    const data = block.split(/\\r?\\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      if (message.id === id) return message;
      last = message;
    } catch {}
  }
  return last;
}

class McpClient {
  constructor(server) { this.server = server; this.session = null; this.nextId = 1; }
  async post(body, signal) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + this.server.token,
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.session) headers["mcp-session-id"] = this.session;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(this.server.url, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error("MCP " + this.server.name + " responded HTTP " + response.status);
    const session = response.headers.get("mcp-session-id");
    if (session) this.session = session;
    return response;
  }
  async request(method, params, signal) {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, signal);
    const message = await readRpc(response, id);
    if (!message) throw new Error("MCP " + this.server.name + " returned no response to " + method);
    if (message.error) throw new Error(message.error.message || JSON.stringify(message.error));
    return message.result;
  }
  async connect() {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "paperclip-pi", version: "1.0.0" },
    });
    const response = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await response.text().catch(() => "");
  }
  async listTools() {
    const tools = [];
    let cursor;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(result.tools || []));
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }
}

function renderContent(result) {
  const parts = (result.content || []).map(item => item.type === "text" ? item.text
    : item.type === "resource" && item.resource && "text" in item.resource ? item.resource.text
    : "[" + item.type + " content omitted]");
  if (parts.length === 0 && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\\n") || "(empty result)";
}

// Pi's --tools allowlist applies to extension tools too, so the adapter imports this
// module to learn the exact names before it launches Pi.
export async function discoverToolNames() {
  used.clear();
  const names = [];
  for (const server of servers) {
    try {
      const client = new McpClient(server);
      await client.connect();
      for (const tool of await client.listTools()) names.push(toolName(server.name, tool.name));
    } catch {}
  }
  used.clear();
  return names;
}

export default function paperclipMcp(pi) {
  pi.on("session_start", async (_event, ctx) => {
    used.clear();
    const registered = [];
    for (const server of servers) {
      try {
        const client = new McpClient(server);
        await client.connect();
        for (const tool of await client.listTools()) {
          const name = toolName(server.name, tool.name);
          registered.push(name);
          pi.registerTool({
            name,
            label: server.name + ": " + tool.name,
            description: tool.description || ("MCP tool " + tool.name + " from " + server.name),
            parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
            async execute(_toolCallId, params, signal) {
              const result = await client.request("tools/call", { name: tool.name, arguments: params || {} }, signal);
              const text = renderContent(result);
              if (result.isError) throw new Error(text);
              return { content: [{ type: "text", text }], details: { server: server.name, tool: tool.name } };
            },
          });
        }
      } catch (error) {
        ctx?.ui?.notify?.("Paperclip MCP server " + server.name + " unavailable: " + (error instanceof Error ? error.message : String(error)), "warning");
        console.error("[paperclip-mcp] " + server.name + " unavailable: " + (error instanceof Error ? error.message : String(error)));
      }
    }
    if (registered.length > 0) {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...registered])]);
      console.error("[paperclip-mcp] registered " + registered.length + " tool(s)");
    }
  });
}
`;
}

/** Tool names the extension will register, in the form Pi's `--tools` allowlist needs. */
export async function discoverPiMcpToolNames(extensionPath: string): Promise<string[]> {
  try {
    const mod = (await import(pathToFileURL(extensionPath).href)) as { discoverToolNames?: () => Promise<string[]> };
    return (await mod.discoverToolNames?.()) ?? [];
  } catch {
    return [];
  }
}

export async function preparePiMcpExtension(servers: readonly AdapterRuntimeMcpServer[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-mcp-"));
  const extensionPath = path.join(directory, "paperclip-mcp.mjs");
  try {
    // The file embeds run-scoped bearer tokens.
    await fs.writeFile(extensionPath, piMcpExtensionSource(servers), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, extensionPath, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
