import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeHermesMcpServers, prepareHermesMcpHome } from "./mcp-home.js";

const server = { name: "PHInfoTech RAG", url: "https://mcp.example/rag", token: "tok-1", connectionId: "c1" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

describe("mergeHermesMcpServers", () => {
  it("appends a section when none exists", () => {
    const out = mergeHermesMcpServers("model:\n  default: x\n", [server]);
    expect(out?.added).toEqual(["phinfotech_rag"]);
    expect(out?.config).toBe(
      'model:\n  default: x\nmcp_servers:\n  phinfotech_rag:\n    url: "https://mcp.example/rag"\n    headers:\n      Authorization: "Bearer tok-1"\n',
    );
  });

  it("inserts into an existing block and avoids key collisions", () => {
    const out = mergeHermesMcpServers("mcp_servers:\n  phinfotech_rag:\n    url: u\nother: 1\n", [server]);
    expect(out?.added).toEqual(["phinfotech_rag_2"]);
    expect(out?.config).toContain("  phinfotech_rag:\n    url: u");
    expect(out?.config.indexOf("phinfotech_rag_2")).toBeLessThan(out!.config.indexOf("other: 1"));
  });

  it("replaces an empty mapping and refuses unknown inline forms", () => {
    expect(mergeHermesMcpServers("mcp_servers: {}\n", [server])?.config).toContain("mcp_servers:\n  phinfotech_rag:");
    expect(mergeHermesMcpServers("mcp_servers: {a: {url: b}}\n", [server])).toBeNull();
  });
});

describe("prepareHermesMcpHome", () => {
  it("builds a throwaway home that links the real home and overrides config.yaml", async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-real-"));
    cleanups.push(() => fs.rm(real, { recursive: true, force: true }));
    await fs.writeFile(path.join(real, "config.yaml"), "model:\n  default: x\n");
    await fs.writeFile(path.join(real, ".env"), "KEY=1\n");
    const prepared = await prepareHermesMcpHome({ realHome: real, servers: [server] });
    expect(prepared).not.toBeNull();
    expect(await fs.readFile(path.join(prepared!.hermesHome, ".env"), "utf8")).toBe("KEY=1\n");
    expect(await fs.readFile(path.join(prepared!.hermesHome, "config.yaml"), "utf8")).toContain("Bearer tok-1");
    expect(await fs.readFile(path.join(real, "config.yaml"), "utf8")).not.toContain("tok-1");
    await prepared!.cleanup();
    await expect(fs.stat(prepared!.hermesHome)).rejects.toThrow();
  });

  it("is a no-op without servers", async () => {
    expect(await prepareHermesMcpHome({ realHome: "/nonexistent", servers: [] })).toBeNull();
  });
});
