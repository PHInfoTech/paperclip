import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { gitRemoteProvider, gitRemoteRepoName, isGitRemoteUrl, normalizeGitRemoteUrl, type GitRemoteProvider, type Project } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const PROVIDER_LABELS: Record<GitRemoteProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  git: "Git",
};

/**
 * Connect a repository from any Git host (GitLab, Bitbucket, self-hosted, ...) by URL. The GitHub
 * picker above only lists repositories from a connected GitHub account; this saves the address on the
 * project's primary workspace so tasks check it out and agents can find it.
 */
export function ProjectGitRepository({ project }: { project: Project }) {
  const client = useQueryClient();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const remote = normalizeGitRemoteUrl(value);
  const valid = isGitRemoteUrl(remote);
  const save = useMutation({
    mutationFn: () => {
      const primary = project.primaryWorkspace;
      // Keep an existing local folder: attach the repository to the primary workspace when there is one.
      if (primary) return projectsApi.updateWorkspace(project.id, primary.id, { repoUrl: remote, sourceType: "git_repo" });
      return projectsApi.createWorkspace(project.id, {
        name: gitRemoteRepoName(remote) ?? "repository",
        sourceType: "git_repo",
        repoUrl: remote,
        isPrimary: true,
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.projects.all(project.companyId) });
      for (const ref of new Set([project.id, project.urlKey])) {
        void client.invalidateQueries({ queryKey: queryKeys.projects.detail(ref) });
      }
      setValue("");
      setTouched(false);
    },
  });

  return <form className="flex min-w-0 flex-col gap-2" onSubmit={(event) => {
    event.preventDefault();
    setTouched(true);
    if (valid && !save.isPending) save.mutate();
  }}>
    <label htmlFor={`git-repository-url-${project.id}`} className="text-xs text-muted-foreground">Git repository by URL</label>
    <div className="flex min-w-0 items-center gap-2">
      <Input
        id={`git-repository-url-${project.id}`}
        aria-label="Git repository URL"
        value={value}
        disabled={save.isPending}
        placeholder="git@gitlab.com:group/repo.git"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => { setValue(event.target.value); save.reset(); }}
      />
      <Button type="submit" disabled={!value.trim() || save.isPending}>{save.isPending ? "Adding…" : "Add repository"}</Button>
    </div>
    {touched && !valid && <p role="alert" className="text-sm text-destructive">Enter an SSH or HTTPS address, for example git@gitlab.com:group/repo.git.</p>}
    {valid && <p className="text-xs text-muted-foreground">{PROVIDER_LABELS[gitRemoteProvider(remote)]} repository {gitRemoteRepoName(remote)}</p>}
    {save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}
  </form>;
}
