// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paperclipai/shared";
import { ProjectGitRepository } from "./ProjectGitRepository";

const api = vi.hoisted(() => ({ createWorkspace: vi.fn(), updateWorkspace: vi.fn() }));
vi.mock("@/api/projects", () => ({ projectsApi: api }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

const project = (overrides: Partial<Project> = {}) => ({
  id: "project-1", urlKey: "zesec-api", companyId: "company-1", workspaces: [], primaryWorkspace: null, ...overrides,
} as unknown as Project);

async function render(value: Project) {
  await act(async () => { root.render(<QueryClientProvider client={client}><ProjectGitRepository project={value} /></QueryClientProvider>); });
}

async function type(text: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Git repository URL"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

async function submit() {
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.createWorkspace.mockReset().mockResolvedValue({});
  api.updateWorkspace.mockReset().mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });

describe("ProjectGitRepository", () => {
  it("saves a GitLab SSH address as the primary workspace of a project without one", async () => {
    await render(project());
    await type("git@gitlab.com:zesec/zesec.api.git");
    expect(container.textContent).toContain("GitLab repository zesec.api");
    await submit();
    expect(api.createWorkspace).toHaveBeenCalledWith("project-1", {
      name: "zesec.api",
      sourceType: "git_repo",
      repoUrl: "ssh://git@gitlab.com/zesec/zesec.api.git",
      isPrimary: true,
    });
    expect(api.updateWorkspace).not.toHaveBeenCalled();
  });

  it("attaches the repository to an existing primary workspace and keeps its local folder", async () => {
    await render(project({ primaryWorkspace: { id: "workspace-1", cwd: "/work/zesec" } } as unknown as Partial<Project>));
    await type("https://gitlab.com/zesec/zesec.api.git");
    await submit();
    expect(api.updateWorkspace).toHaveBeenCalledWith("project-1", "workspace-1", {
      repoUrl: "https://gitlab.com/zesec/zesec.api.git",
      sourceType: "git_repo",
    });
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });

  it("rejects local paths and text that is not a Git address", async () => {
    await render(project());
    await type("/home/user/repo");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("SSH or HTTPS address");
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });

  it("shows the server's error when saving fails", async () => {
    api.createWorkspace.mockRejectedValue(new Error("Workspace could not be created"));
    await render(project());
    await type("git@gitlab.com:zesec/zesec.api.git");
    await submit();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Workspace could not be created");
  });
});
