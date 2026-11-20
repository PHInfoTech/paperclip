import http from "node:http";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePiRuntimeConfig } from "./runtime-config.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupPaths].map(async (filepath) => {
      await fs.rm(filepath, { recursive: true, force: true });
      cleanupPaths.delete(filepath);
    }),
  );
});

async function readModelsJson(agentConfigDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentConfigDir, "models.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("preparePiRuntimeConfig", () => {
  it("attributes OpenRouter aliases and model overrides while preserving routing and other providers", async () => {
    const other = { baseUrl: "https://other.example/v1", headers: { "X-Title": "Other" } };
    const prepared = await preparePiRuntimeConfig({ env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({
      router: {
        baseUrl: "https://openrouter.ai/api/v1", apiKey: "fixture-key",
        headers: { "http-referer": "https://pi.example", "X-Route": "selected" },
        modelOverrides: { model: { headers: { "x-title": "Pi" } } },
      }, other, openrouter: other,
    }) } });
    cleanupPaths.add(prepared.env.PI_CODING_AGENT_DIR);
    const { providers } = await readModelsJson(prepared.env.PI_CODING_AGENT_DIR) as { providers: Record<string, any> };
    expect(providers.router).toMatchObject({ apiKey: "fixture-key", headers: { "HTTP-Referer": "https://paperclip.ing", "X-Route": "selected" } });
    expect(providers.router.headers).not.toHaveProperty("http-referer");
    expect(providers.router.modelOverrides.model.headers["X-Title"]).toBe("Paperclip");
    expect(providers.router.modelOverrides.model.headers).not.toHaveProperty("x-title");
    expect(providers.other).toEqual(other);
    expect(providers.openrouter).toEqual(other);
    await prepared.cleanup();
  });

  it("is a no-op when PAPERCLIP_PI_PROVIDERS is unset", async () => {
    const prepared = await preparePiRuntimeConfig({ env: { FOO: "bar" } });

    expect(prepared.env).toEqual({ FOO: "bar" });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });

  it("writes the providers JSON verbatim to a managed models.json and points PI_CODING_AGENT_DIR at it", async () => {
    const providers = {
      tensorix: {
        baseUrl: "http://gateway.example.svc.cluster.local:8080/anthropic",
        apiKey: "sk-literal",
        api: "anthropic-messages",
        models: [
          {
            id: "deepseek/deepseek-chat-v3.1",
            name: "DeepSeek v3.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    };

    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    expect(agentConfigDir).toBeTruthy();
    cleanupPaths.add(agentConfigDir);

    expect(await readModelsJson(agentConfigDir)).toEqual({ providers });
    expect(prepared.notes.some((n) => n.includes("tensorix"))).toBe(true);

    await prepared.cleanup();
    cleanupPaths.delete(agentConfigDir);
    await expect(fs.access(agentConfigDir)).rejects.toThrow();
  });

  it("reads PAPERCLIP_PI_PROVIDERS from process.env when absent from the run env", async () => {
    const providers = { tensorix: { baseUrl: "http://gw/anthropic", api: "anthropic-messages", models: [] } };
    process.env.PAPERCLIP_PI_PROVIDERS = JSON.stringify(providers);
    try {
      const prepared = await preparePiRuntimeConfig({ env: {} });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      expect(agentConfigDir).toBeTruthy();
      cleanupPaths.add(agentConfigDir);
      expect(await readModelsJson(agentConfigDir)).toEqual({ providers });
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_PI_PROVIDERS;
    }
  });

  it("expands {env:VAR} placeholders from the run env (bakes the literal key)", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:ANTHROPIC_API_KEY}", api: "anthropic-messages", models: [] },
    };
    const prepared = await preparePiRuntimeConfig({
      env: {
        PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers),
        ANTHROPIC_API_KEY: "sk-bf-REALVK",
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsJson.providers.tensorix.apiKey).toBe("sk-bf-REALVK");
    await prepared.cleanup();
  });

  it("expands {env:VAR} placeholders from process.env when absent from the run env", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:PAPERCLIP_PI_TEST_KEY}", api: "anthropic-messages", models: [] },
    };
    process.env.PAPERCLIP_PI_TEST_KEY = "sk-from-process-env";
    try {
      const prepared = await preparePiRuntimeConfig({
        env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
      });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      cleanupPaths.add(agentConfigDir);
      const modelsJson = (await readModelsJson(agentConfigDir)) as {
        providers: { tensorix: { apiKey: string } };
      };
      expect(modelsJson.providers.tensorix.apiKey).toBe("sk-from-process-env");
      await prepared.cleanup();
    } finally {
      delete process.env.PAPERCLIP_PI_TEST_KEY;
    }
  });

  it("leaves an unresolvable {env:VAR} placeholder intact", async () => {
    const providers = {
      tensorix: { baseUrl: "http://gw/anthropic", apiKey: "{env:DEFINITELY_UNSET_VAR_XYZ}", api: "anthropic-messages", models: [] },
    };
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: { tensorix: { apiKey: string } };
    };
    expect(modelsJson.providers.tensorix.apiKey).toBe("{env:DEFINITELY_UNSET_VAR_XYZ}");
    await prepared.cleanup();
  });

  it("ignores malformed PAPERCLIP_PI_PROVIDERS without writing a config", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("ignores provider entries that are not objects and names them in the note", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({ tensorix: "nope" }) },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.agentConfigDir).toBeNull();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces skipped non-object entries while keeping the usable ones", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: {
        PAPERCLIP_PI_PROVIDERS: JSON.stringify({
          bad: "http://gw/v1",
          tensorix: { baseUrl: "http://gw/anthropic", apiKey: "k", api: "anthropic-messages", models: [] },
        }),
      },
    });
    const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
    cleanupPaths.add(agentConfigDir);
    expect(prepared.agentConfigDir).toBe(agentConfigDir);
    const modelsJson = (await readModelsJson(agentConfigDir)) as {
      providers: Record<string, unknown>;
    };
    expect(modelsJson.providers.tensorix).toBeDefined();
    expect(modelsJson.providers.bad).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: bad.",
      "Injected 1 custom Pi provider(s) from PAPERCLIP_PI_PROVIDERS into a managed models.json: tensorix.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_PI_PROVIDERS contains invalid JSON", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "{not json" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces a note when PAPERCLIP_PI_PROVIDERS is not a JSON object", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "[1,2]" },
    });
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    ]);
    await prepared.cleanup();
  });

  it("surfaces the skipped entries when no provider objects remain", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: '{"a": 1}' },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([
      "PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: a.",
    ]);
    await prepared.cleanup();
  });

  it("stays silent when PAPERCLIP_PI_PROVIDERS is an empty object", async () => {
    const prepared = await preparePiRuntimeConfig({
      env: { PAPERCLIP_PI_PROVIDERS: "{}" },
    });
    expect(prepared.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(prepared.notes).toEqual([]);
    await prepared.cleanup();
  });
});

describe("preparePiRuntimeConfig served-model discovery", () => {
  it("fills an empty model list from the provider's /models endpoint", async () => {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "switchyard/a" }, { id: "switchyard/b" }] } : {}));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const prepared = await preparePiRuntimeConfig({ env: {
      PAPERCLIP_PI_PROVIDERS: JSON.stringify({ paperclip: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "k" } }),
    } });
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const written = JSON.parse(await fs.readFile(path.join(prepared.agentConfigDir!, "models.json"), "utf8"));
      expect(written.providers.paperclip.models).toEqual([{ id: "switchyard/a" }, { id: "switchyard/b" }]);
    } finally {
      await prepared.cleanup();
      server.close();
    }
  });

  describe("context limits from the endpoint", () => {
    async function withEndpoint(body: unknown, run: (baseUrl: string) => Promise<void>) {
      const server = http.createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    async function modelsFor(provider: Record<string, unknown>) {
      const prepared = await preparePiRuntimeConfig({
        env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({ paperclip: { api: "openai-completions", ...provider } }) },
      });
      const agentConfigDir = prepared.env.PI_CODING_AGENT_DIR;
      cleanupPaths.add(agentConfigDir);
      const written = await readModelsJson(agentConfigDir) as { providers: { paperclip: { models: unknown[] } } };
      await prepared.cleanup();
      cleanupPaths.delete(agentConfigDir);
      return written.providers.paperclip.models;
    }

    const served = {
      data: [
        { id: "small", context_length: 65536 },
        { id: "large", context_length: 1048576 },
        { id: "unknown" },
      ],
    };

    it("applies each listed model's reported window with a matching output budget", async () => {
      await withEndpoint(served, async (baseUrl) => {
        await expect(modelsFor({ baseUrl, models: [{ id: "small" }] }))
          .resolves.toEqual([{ id: "small", contextWindow: 65536, maxTokens: 8192 }]);
        await expect(modelsFor({ baseUrl, models: [{ id: "large" }] }))
          .resolves.toEqual([{ id: "large", contextWindow: 1048576, maxTokens: 16384 }]);
      });
    });

    it("applies reported windows to discovered models and leaves unreported ones to Pi", async () => {
      await withEndpoint(served, async (baseUrl) => {
        await expect(modelsFor({ baseUrl })).resolves.toEqual([
          { id: "small", contextWindow: 65536, maxTokens: 8192 },
          { id: "large", contextWindow: 1048576, maxTokens: 16384 },
          { id: "unknown" },
        ]);
      });
    });

    it("keeps explicit limits and listed models the endpoint does not report", async () => {
      await withEndpoint(served, async (baseUrl) => {
        await expect(modelsFor({
          baseUrl,
          models: [{ id: "small", maxTokens: 4096 }, { id: "large", contextWindow: 32000 }, { id: "absent" }],
        })).resolves.toEqual([
          { id: "small", contextWindow: 65536, maxTokens: 4096 },
          { id: "large", contextWindow: 32000 },
          { id: "absent" },
        ]);
      });
    });
  });
});
