import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  materializeHermesRuntimeMcp,
  renderHermesMcpServersBlock,
  stripTopLevelMcpServers,
} from "./runtime-mcp.js";

const servers = [
  {
    name: "Paperclip projects",
    url: "http://localhost:3100/api/mcp/project-tools",
    token: "project-token",
    connectionId: "paperclip-project-tools",
  },
  {
    name: "paperclip-assigned",
    url: "http://localhost:3100/mcp/gateways/gw_abc",
    token: "gateway-token",
    connectionId: "assignment:0123456789abcdef",
  },
];

const tempDirs: string[] = [];

async function managedHome(initialConfig?: string) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-runtime-mcp-"));
  tempDirs.push(home);
  const providerHome = path.join(home, "provider");
  await fs.mkdir(providerHome);
  if (initialConfig !== undefined) {
    await fs.writeFile(path.join(providerHome, "config.yaml"), initialConfig, { mode: 0o600 });
  }
  return providerHome;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("renderHermesMcpServersBlock", () => {
  it("renders identifier-safe, unique server names with bearer headers", () => {
    const { block, serverNames } = renderHermesMcpServersBlock([...servers, { ...servers[1], connectionId: "assignment:fedcba" }]);
    expect(serverNames).toEqual(["paperclip_projects", "paperclip_assigned", "paperclip_assigned_assignme"]);
    expect(block).toContain('  "paperclip_assigned":\n    url: "http://localhost:3100/mcp/gateways/gw_abc"\n');
    expect(block).toContain('      Authorization: "Bearer gateway-token"\n');
  });
});

describe("stripTopLevelMcpServers", () => {
  it("removes only the top-level mcp_servers mapping", () => {
    const yaml = 'model:\n  default: "m"\nmcp_servers:\n  old:\n    url: "x"\n# inside\nterminal:\n  cwd: "."\n';
    expect(stripTopLevelMcpServers(yaml)).toBe('model:\n  default: "m"\nterminal:\n  cwd: "."\n');
  });
});

describe("materializeHermesRuntimeMcp", () => {
  it("appends the servers to the managed provider config and keeps the model block", async () => {
    const providerHome = await managedHome('model:\n  provider: "custom"\n  default: "m"\n');
    const result = await materializeHermesRuntimeMcp({
      config: { managedAiConnection: { method: "api_key" }, env: { HERMES_HOME: providerHome } },
      servers,
    });

    const configPath = path.join(providerHome, "config.yaml");
    expect(result).toEqual({ status: "written", configPath, serverNames: ["paperclip_projects", "paperclip_assigned"] });
    const written = await fs.readFile(configPath, "utf-8");
    expect(written.startsWith('model:\n  provider: "custom"\n  default: "m"\nmcp_servers:\n')).toBe(true);
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("is idempotent when the run writes the config again", async () => {
    const providerHome = await managedHome('model:\n  default: "m"\n');
    const input = { config: { managedAiConnection: {}, env: { HERMES_HOME: providerHome } }, servers };
    await materializeHermesRuntimeMcp(input);
    const first = await fs.readFile(path.join(providerHome, "config.yaml"), "utf-8");
    await materializeHermesRuntimeMcp(input);
    expect(await fs.readFile(path.join(providerHome, "config.yaml"), "utf-8")).toBe(first);
  });

  it("creates the config when the managed home has none", async () => {
    const providerHome = await managedHome();
    await materializeHermesRuntimeMcp({ config: { managedAiConnection: {}, env: { HERMES_HOME: providerHome } }, servers });
    expect(await fs.readFile(path.join(providerHome, "config.yaml"), "utf-8")).toMatch(/^mcp_servers:\n/);
  });

  it("never writes run tokens into an operator-owned Hermes home", async () => {
    const providerHome = await managedHome('model:\n  default: "m"\n');
    const result = await materializeHermesRuntimeMcp({ config: { env: { HERMES_HOME: providerHome } }, servers });
    expect(result).toEqual({ status: "skipped", reason: "unmanaged_hermes_home" });
    expect(await fs.readFile(path.join(providerHome, "config.yaml"), "utf-8")).toBe('model:\n  default: "m"\n');
  });

  it("does nothing when the run has no MCP servers", async () => {
    expect(await materializeHermesRuntimeMcp({ config: {}, servers: [] })).toEqual({ status: "none" });
  });
});
