/**
 * Materialize Paperclip's run-scoped MCP servers (ctx.runtimeMcp) for Hermes.
 *
 * Hermes reads MCP servers only from `mcp_servers` in `$HERMES_HOME/config.yaml`.
 * Claude and ACP runs receive the same servers through a strict MCP config or
 * the ACP session; without this step a Hermes run never sees its assigned
 * gateway tools.
 *
 * The block is written only into the disposable, server-created provider home
 * of a managed AI connection. An operator's own Hermes home is shared across
 * runs, so run-scoped tokens are never written there.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

export type HermesRuntimeMcpResult =
  | { status: "none" }
  | { status: "written"; configPath: string; serverNames: string[] }
  | { status: "skipped"; reason: "unmanaged_hermes_home" };

function nonEmptyString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    return typeof inner === "string" && inner.trim().length > 0 ? inner.trim() : null;
  }
  return null;
}

/** Hermes prefixes tool names with the server name; keep it identifier-safe. */
function hermesServerName(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "paperclip";
}

export function renderHermesMcpServersBlock(
  servers: AdapterRuntimeMcpServer[],
): { block: string; serverNames: string[] } {
  const usedNames = new Set<string>();
  const lines = ["mcp_servers:"];
  for (const server of servers) {
    const base = hermesServerName(server.name);
    let name = base;
    if (usedNames.has(name)) name = `${base}_${hermesServerName(server.connectionId).slice(0, 8)}`;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${base}_${hermesServerName(server.connectionId).slice(0, 8)}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    // JSON strings are valid YAML double-quoted scalars.
    lines.push(
      `  ${JSON.stringify(name)}:`,
      `    url: ${JSON.stringify(server.url)}`,
      "    headers:",
      `      Authorization: ${JSON.stringify(`Bearer ${server.token}`)}`,
    );
  }
  return { block: `${lines.join("\n")}\n`, serverNames: [...usedNames] };
}

/** Drop a top-level `mcp_servers:` mapping so repeated writes stay idempotent. */
export function stripTopLevelMcpServers(yaml: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of yaml.split("\n")) {
    if (/^mcp_servers\s*:/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^[^\s#]/.test(line)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

export async function materializeHermesRuntimeMcp(input: {
  config: Record<string, unknown>;
  servers: AdapterRuntimeMcpServer[];
}): Promise<HermesRuntimeMcpResult> {
  if (input.servers.length === 0) return { status: "none" };
  const env =
    input.config.env && typeof input.config.env === "object" && !Array.isArray(input.config.env)
      ? (input.config.env as Record<string, unknown>)
      : {};
  const hermesHome = nonEmptyString(env.HERMES_HOME);
  if (!input.config.managedAiConnection || !hermesHome) {
    return { status: "skipped", reason: "unmanaged_hermes_home" };
  }

  const configPath = path.join(path.resolve(hermesHome), "config.yaml");
  let existing = "";
  try {
    existing = await fs.readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const base = stripTopLevelMcpServers(existing).replace(/\n*$/, "");
  const { block, serverNames } = renderHermesMcpServersBlock(input.servers);
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, base ? `${base}\n${block}` : block, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  return { status: "written", configPath, serverNames };
}
