/**
 * Helpers for the Git remote URL stored on a project workspace (`repoUrl`).
 *
 * The field accepts any Git host. SCP-style remotes (`git@gitlab.com:group/repo.git`) are what
 * hosting UIs show for SSH, but they are not URLs, so they are normalized to `ssh://` before
 * validation and storage.
 */

export type GitRemoteProvider = "github" | "gitlab" | "bitbucket" | "git";

const SCP_LIKE_REMOTE = /^(?:(?<user>[^@\s/:]+)@)?(?<host>[A-Za-z0-9][A-Za-z0-9.-]*):(?<path>[^\s]+)$/;

/** Turns `[user@]host:path` into `ssh://[user@]host/path`; every other value is returned trimmed. */
export function normalizeGitRemoteUrl(input: string): string {
  const value = input.trim();
  if (!value || value.includes("://")) return value;
  const match = SCP_LIKE_REMOTE.exec(value);
  if (!match?.groups) return value;
  const { user, host, path } = match.groups;
  // `host:22/path` is a port, not an SCP path.
  if (/^\d+(?:\/|$)/.test(path)) return value;
  return `ssh://${user ? `${user}@` : ""}${host}/${path.replace(/^\/+/, "")}`;
}

/** Remote schemes a project repository may use; local paths belong in the local folder field. */
const REMOTE_PROTOCOLS = new Set(["https:", "http:", "ssh:", "git:"]);

export function isGitRemoteUrl(input: string): boolean {
  try {
    return REMOTE_PROTOCOLS.has(new URL(normalizeGitRemoteUrl(input)).protocol);
  } catch {
    return false;
  }
}

export function gitRemoteProvider(input: string): GitRemoteProvider {
  let host: string;
  try {
    host = new URL(normalizeGitRemoteUrl(input)).hostname.toLowerCase();
  } catch {
    return "git";
  }
  if (host === "github.com" || host === "www.github.com") return "github";
  if (host === "gitlab.com" || host.startsWith("gitlab.")) return "gitlab";
  if (host === "bitbucket.org") return "bitbucket";
  return "git";
}

/** `zesec/zesec.api.git` -> `zesec.api`, or null when the URL has no path. */
export function gitRemoteRepoName(input: string): string | null {
  try {
    const name = new URL(normalizeGitRemoteUrl(input)).pathname
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/i, "");
    return name || null;
  } catch {
    return null;
  }
}
