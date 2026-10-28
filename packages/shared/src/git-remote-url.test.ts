import { describe, expect, it } from "vitest";
import {
  gitRemoteProvider,
  gitRemoteRepoName,
  isGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "./git-remote-url.js";
import { createProjectWorkspaceSchema, updateProjectWorkspaceSchema } from "./validators/project.js";

describe("normalizeGitRemoteUrl", () => {
  it("turns SCP-style remotes into ssh URLs", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:zesec/zesec.api.git")).toBe("ssh://git@gitlab.com/zesec/zesec.api.git");
    expect(normalizeGitRemoteUrl("  git@git.example.com:/srv/repos/app.git ")).toBe("ssh://git@git.example.com/srv/repos/app.git");
    expect(normalizeGitRemoteUrl("gitlab.example.com:group/sub/repo")).toBe("ssh://gitlab.example.com/group/sub/repo");
  });

  it("leaves real URLs, ports and empty values alone", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.com/zesec/zesec.api.git")).toBe("https://gitlab.com/zesec/zesec.api.git");
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.com:2222/zesec/zesec.api.git")).toBe("ssh://git@gitlab.com:2222/zesec/zesec.api.git");
    expect(normalizeGitRemoteUrl("git@host:22/path")).toBe("git@host:22/path");
    expect(normalizeGitRemoteUrl("   ")).toBe("");
  });
});

describe("isGitRemoteUrl", () => {
  it("accepts remote git URLs and rejects local paths and other schemes", () => {
    expect(isGitRemoteUrl("git@gitlab.com:zesec/zesec.api.git")).toBe(true);
    expect(isGitRemoteUrl("https://gitlab.com/zesec/zesec.api")).toBe(true);
    expect(isGitRemoteUrl("/home/user/repo")).toBe(false);
    expect(isGitRemoteUrl("file:///home/user/repo")).toBe(false);
    expect(isGitRemoteUrl("not a url")).toBe(false);
  });
});

describe("gitRemoteProvider", () => {
  it("recognizes common hosts", () => {
    expect(gitRemoteProvider("git@gitlab.com:zesec/zesec.api.git")).toBe("gitlab");
    expect(gitRemoteProvider("https://gitlab.example.com/a/b.git")).toBe("gitlab");
    expect(gitRemoteProvider("https://github.com/a/b")).toBe("github");
    expect(gitRemoteProvider("git@bitbucket.org:a/b.git")).toBe("bitbucket");
    expect(gitRemoteProvider("ssh://git@code.example.com/a/b.git")).toBe("git");
  });
});

describe("gitRemoteRepoName", () => {
  it("takes the last path segment without .git", () => {
    expect(gitRemoteRepoName("git@gitlab.com:zesec/zesec.api.git")).toBe("zesec.api");
    expect(gitRemoteRepoName("https://gitlab.com/zesec/sub/repo/")).toBe("repo");
    expect(gitRemoteRepoName("https://gitlab.com")).toBeNull();
  });
});

describe("project workspace repoUrl validation", () => {
  it("accepts and normalizes an SCP-style GitLab remote on create and update", () => {
    const created = createProjectWorkspaceSchema.parse({ repoUrl: "git@gitlab.com:zesec/zesec.api.git" });
    expect(created.repoUrl).toBe("ssh://git@gitlab.com/zesec/zesec.api.git");
    const updated = updateProjectWorkspaceSchema.parse({ repoUrl: "git@gitlab.com:zesec/zesec.api.git" });
    expect(updated.repoUrl).toBe("ssh://git@gitlab.com/zesec/zesec.api.git");
  });

  it("keeps https URLs, null clears, and an omitted field stays omitted", () => {
    expect(createProjectWorkspaceSchema.parse({ repoUrl: "https://gitlab.com/zesec/zesec.api" }).repoUrl)
      .toBe("https://gitlab.com/zesec/zesec.api");
    expect(updateProjectWorkspaceSchema.parse({ repoUrl: null }).repoUrl).toBeNull();
    expect("repoUrl" in updateProjectWorkspaceSchema.parse({ name: "x" })).toBe(false);
  });

  it("still rejects values that are not URLs", () => {
    expect(createProjectWorkspaceSchema.safeParse({ repoUrl: "not a url" }).success).toBe(false);
  });
});
