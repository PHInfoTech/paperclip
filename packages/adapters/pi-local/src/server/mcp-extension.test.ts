import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import http from "node:http";
import { discoverPiMcpToolNames, piMcpExtensionSource, preparePiMcpExtension } from "./mcp-extension.js";

const server = { name: "PHInfoTech RAG", url: "https://mcp.example/rag", token: "tok-1", connectionId: "c1" };

describe("pi MCP extension", () => {
  it("embeds the servers and exposes a default extension factory", () => {
    const source = piMcpExtensionSource([server]);
    expect(source).toContain("https://mcp.example/rag");
    expect(source).toContain("export default function paperclipMcp");
    expect(source).not.toContain("connectionId");
  });

  it("writes an owner-only extension file and cleans it up", async () => {
    const prepared = await preparePiMcpExtension([server]);
    expect((await fs.stat(prepared.extensionPath)).mode & 0o777).toBe(0o600);
    await prepared.cleanup();
    await expect(fs.stat(prepared.directory)).rejects.toThrow();
  });

  it("discovers the tool names Pi's --tools allowlist needs", async () => {
    const mcp = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const m = body ? JSON.parse(body) : {};
        if (m.id === undefined) { res.writeHead(202); return res.end(); }
        const result = m.method === "tools/list"
          ? { tools: [{ name: "search-project-context", inputSchema: { type: "object" } }] }
          : { protocolVersion: "2025-06-18", capabilities: {} };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
    });
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    const { port } = mcp.address() as { port: number };
    const prepared = await preparePiMcpExtension([{ ...server, url: `http://127.0.0.1:${port}/` }]);
    try {
      expect(await discoverPiMcpToolNames(prepared.extensionPath)).toEqual(["phinfotech_rag__search-project-context"]);
    } finally {
      await prepared.cleanup();
      mcp.close();
    }
  });
});
