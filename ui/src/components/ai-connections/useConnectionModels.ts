import { useQuery } from "@tanstack/react-query";
import { aiRoutingModel, type AiConnectionBinding, type AiProviderRouting } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";

export function useConnectionModels(
  companyId: string | null | undefined,
  binding: AiConnectionBinding | undefined,
  harness: string,
) {
  const accounts = useQuery({
    queryKey: ["ai-connections", companyId],
    queryFn: () => aiConnectionsApi.list(companyId!),
    enabled: Boolean(companyId && binding),
  });
  const connection = accounts.data?.connections.find((c) =>
    binding?.mode === "responsible_user"
      ? c.provider === binding.provider && c.isDefault && c.ownerUserId === accounts.data?.currentUserId && c.ownership === "personal"
      : c.id === binding?.connectionId && c.grantId === binding?.grantId,
  );
  const routing = connection?.routing;
  const openRouter = routing?.kind === "openrouter" || (!routing && binding?.provider === "openrouter");
  const discover = openRouter && !routing?.models.length;
  // Reuse the existing public catalog and its query cache. It returns OpenCode IDs;
  // strip only that transport prefix for other harnesses (openrouter/auto is
  // itself a valid upstream model ID).
  const catalog = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId ?? "none", "opencode_local", null, "openrouter"),
    queryFn: () => agentsApi.adapterModels(companyId!, "opencode_local", { provider: "openrouter" }),
    enabled: Boolean(companyId && discover),
    staleTime: 60_000,
    retry: false,
  });
  // Custom gateways and local endpoints list their own models; saved IDs come first.
  const endpoint = routing?.kind === "gateway" || routing?.kind === "local";
  const listed = useQuery({
    queryKey: ["ai-connections", companyId, "models", connection?.id, connection?.grantId],
    queryFn: () => aiConnectionsApi.models(companyId!, connection!.id, connection!.grantId),
    enabled: Boolean(companyId && connection && endpoint),
    staleTime: 60_000,
    retry: false,
  });
  const effectiveRouting: AiProviderRouting | undefined = routing ?? (openRouter
    ? { kind: "openrouter", protocol: "chat", auth: "bearer", models: [] }
    : undefined);
  const modelOptions = discover
    ? (catalog.data ?? []).map((m) => ({ ...m, id: harness === "opencode_local" ? m.id : m.id.replace(/^openrouter\//, "") }))
    : endpoint
      ? [...new Map([...routing.models, ...(listed.data ?? [])].map((m) => [m.id, m])).values()]
      : routing?.models ?? [];
  const query = discover ? catalog : endpoint ? listed : undefined;
  return effectiveRouting
    ? {
        models: modelOptions.map((m) => ({
          id: aiRoutingModel(effectiveRouting, harness, m.id),
          label: m.label ?? m.id,
        })),
        isLoading: Boolean(query?.isLoading),
        // Saved IDs still work when the endpoint cannot list its models.
        error: query && (discover || !routing?.models.length) ? query.error : null,
        refreshing: Boolean(query?.isFetching),
        refreshModels: query ? async () => { await query.refetch(); } : undefined,
        resolveModel: (model: string) =>
          aiRoutingModel(effectiveRouting, harness, model),
      }
    : undefined;
}
