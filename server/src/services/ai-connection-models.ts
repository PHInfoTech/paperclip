import { aiRoutingBaseUrl, type AiProviderRouting } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export interface AiRoutedModel {
  id: string;
  label: string;
}

const MODEL_LIST_TIMEOUT_MS = 10_000;
const MAX_MODEL_LIST_BYTES = 1_000_000;
const MAX_MODELS = 500;

/**
 * Reads `<baseUrl>/models` from a custom gateway or local endpoint. OpenAI-compatible
 * servers and the Anthropic Messages API both answer with `{ data: [{ id }] }`.
 * The URL was validated when the connection was saved; redirects are refused so
 * the credential is only ever sent to that URL.
 */
export async function listRoutedModels(routing: AiProviderRouting, credential: string): Promise<AiRoutedModel[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (routing.auth === "bearer" && credential) headers.Authorization = `Bearer ${credential}`;
  if (routing.auth === "api_key") {
    headers["x-api-key"] = credential;
    headers["anthropic-version"] = "2023-06-01";
  }
  const failure = () => unprocessable("Could not list models from this connection. Enter a model ID manually.");
  let body: unknown;
  try {
    const response = await fetch(`${aiRoutingBaseUrl(routing, "")}/models`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
    });
    if (!response.ok) throw failure();
    const text = await response.text();
    if (text.length > MAX_MODEL_LIST_BYTES) throw failure();
    body = JSON.parse(text);
  } catch {
    throw failure();
  }
  const data = body !== null && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw failure();
  const models = new Map<string, AiRoutedModel>();
  for (const entry of data) {
    if (entry === null || typeof entry !== "object") continue;
    const { id, display_name: displayName } = entry as { id?: unknown; display_name?: unknown };
    if (typeof id !== "string" || !id.trim() || id.length > 256 || models.has(id)) continue;
    const label = typeof displayName === "string" && displayName.trim() ? displayName.trim().slice(0, 160) : id;
    models.set(id, { id, label });
    if (models.size >= MAX_MODELS) break;
  }
  return [...models.values()];
}
