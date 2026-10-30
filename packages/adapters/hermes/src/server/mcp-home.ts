/**
 * Deliver Paperclip-assigned MCP servers to Hermes.
 *
 * Hermes only reads MCP servers from `mcp_servers:` in `$HERMES_HOME/config.yaml`.
 * To avoid writing run-scoped bearer tokens into the operator's persistent config,
 * each run gets a throwaway HERMES_HOME that symlinks every entry of the real home
 * (sessions, skills, .env, ...) except config.yaml, which is copied with the
 * managed servers merged in.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";

export interface PreparedHermesMcpHome {
  hermesHome: string;
  notes: string[];
  cleanup: () => Promise<void>;
}

function serverKey(name: string, taken: Set<string>): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "paperclip_mcp";
  let key = base;
  for (let suffix = 2; taken.has(key); suffix += 1) key = `${base}_${suffix}`;
  taken.add(key);
  return key;
}

function existingServerKeys(config: string): Set<string> {
  const keys = new Set<string>();
  let inSection = false;
  for (const line of config.split("\n")) {
    if (/^mcp_servers:/.test(line)) { inSection = true; continue; }
    if (inSection && /^\S/.test(line)) inSection = false;
    const match = inSection ? /^\s{1,8}["']?([^\s"':#]+)["']?\s*:/.exec(line) : null;
    if (match) keys.add(match[1].toLowerCase());
  }
  return keys;
}

/** JSON string literals are valid YAML scalars, so no YAML library is needed. */
export function mergeHermesMcpServers(
  config: string,
  servers: readonly AdapterRuntimeMcpServer[],
): { config: string; added: string[] } | null {
  const taken = existingServerKeys(config);
  const added: string[] = [];
  const block = servers.map((server) => {
    const key = serverKey(server.name, taken);
    added.push(key);
    return [
      `  ${key}:`,
      `    url: ${JSON.stringify(server.url)}`,
      `    headers:`,
      `      Authorization: ${JSON.stringify(`Bearer ${server.token}`)}`,
    ].join("\n");
  }).join("\n");

  const lines = config.split("\n");
  const index = lines.findIndex((line) => /^mcp_servers:/.test(line));
  if (index === -1) {
    const prefix = config.length === 0 || config.endsWith("\n") ? config : `${config}\n`;
    return { config: `${prefix}mcp_servers:\n${block}\n`, added };
  }
  const rest = lines[index].slice("mcp_servers:".length).replace(/#.*$/, "").trim();
  if (rest === "" || rest === "{}" || rest === "null" || rest === "~") {
    lines.splice(index, 1, "mcp_servers:", block);
    return { config: lines.join("\n"), added };
  }
  // Inline/flow form we cannot safely merge into.
  return null;
}

export async function prepareHermesMcpHome(input: {
  realHome: string;
  servers: readonly AdapterRuntimeMcpServer[];
}): Promise<PreparedHermesMcpHome | null> {
  if (input.servers.length === 0) return null;

  let existing = "";
  try {
    existing = await fs.readFile(path.join(input.realHome, "config.yaml"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
  }
  const merged = mergeHermesMcpServers(existing, input.servers);
  if (!merged) {
    return {
      hermesHome: input.realHome,
      notes: ["Hermes config.yaml uses an inline mcp_servers value; Paperclip-managed MCP servers were not injected."],
      cleanup: async () => {},
    };
  }

  const hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-home-"));
  try {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(input.realHome);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
    }
    for (const entry of entries) {
      if (entry === "config.yaml") continue;
      await fs.symlink(path.join(input.realHome, entry), path.join(hermesHome, entry));
    }
    await fs.writeFile(path.join(hermesHome, "config.yaml"), merged.config, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    await fs.rm(hermesHome, { recursive: true, force: true });
    throw err;
  }
  return {
    hermesHome,
    notes: [`Injected ${merged.added.length} Paperclip-managed MCP server(s) into Hermes: ${merged.added.join(", ")}.`],
    cleanup: async () => { await fs.rm(hermesHome, { recursive: true, force: true }); },
  };
}
