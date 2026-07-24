import type { FastMCP } from "fastmcp";
import { z } from "zod";

import { ERROR_CODES } from "./error-codes.js";
import { gitFailureDetail, isSafeGitUpstreamToken, spawnGitAsync } from "./git.js";
import { getCurrentBranch, inferRemoteFromUpstream, isSafeGitRefToken } from "./git-refs.js";
import { jsonRespond, spreadDefined } from "./json.js";
import { condensePushOutput, redactUrlCredentials } from "./push-output.js";
import { requireSingleRepo } from "./roots.js";
import { WorkspacePickSchema } from "./schemas.js";

/** Build the `git_push` success JSON payload. */
function buildGitPushJson(opts: {
  branch: string;
  remote: string;
  upstream: string;
  setUpstream?: boolean;
  gitOutput: string;
}): Record<string, unknown> {
  return {
    ok: true,
    branch: opts.branch,
    remote: opts.remote,
    upstream: opts.upstream,
    ...spreadDefined("setUpstream", opts.setUpstream || undefined),
    ...spreadDefined("output", opts.gitOutput || undefined),
  };
}

export function registerGitPushTool(server: FastMCP): void {
  server.addTool({
    name: "git_push",
    description:
      "Push the current branch to its configured upstream. " +
      "Use `setUpstream: true` to set tracking (`-u`) when no upstream is configured yet. " +
      "Refuses on detached HEAD. Does not force-push.",
    annotations: {
      title: "Git Push",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    parameters: WorkspacePickSchema.extend({
      remote: z
        .string()
        .optional()
        .describe(
          "Remote to push to. Defaults to the remote inferred from the current upstream tracking " +
            "ref, or `origin` when `setUpstream` is true.",
        ),
      branch: z
        .string()
        .optional()
        .describe(
          "Branch to push. Defaults to the currently checked-out branch. " +
            "Rejected when HEAD is detached.",
        ),
      setUpstream: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Set the upstream tracking reference (`git push -u`). " +
            "Use when the branch has not been pushed yet. Remote defaults to `origin`.",
        ),
    }),
    execute: async (args) => {
      const pre = requireSingleRepo(server, args);
      if (!pre.ok) return jsonRespond(pre.error);
      const { gitTop } = pre;

      // --- Resolve branch ---
      const currentBranch = await getCurrentBranch(gitTop);
      const branch = args.branch?.trim() || currentBranch;
      if (!branch) {
        return jsonRespond({ error: ERROR_CODES.PUSH_DETACHED_HEAD });
      }
      // Reject leading `+` (git force-update refspec) even if the shared ref
      // token helper still permits `+` mid-name — never force-push via argv.
      if (!isSafeGitRefToken(branch) || branch.startsWith("+")) {
        return jsonRespond({ error: ERROR_CODES.UNSAFE_REF_TOKEN, ref: branch });
      }

      // --- Resolve remote ---
      let remote: string;
      if (args.remote?.trim()) {
        if (!isSafeGitUpstreamToken(args.remote.trim())) {
          return jsonRespond({
            error: ERROR_CODES.UNSAFE_REMOTE_TOKEN,
            remote: args.remote.trim(),
          });
        }
        remote = args.remote.trim();
      } else if (args.setUpstream) {
        // No explicit remote and we're setting upstream — default to origin.
        remote = "origin";
      } else {
        // Infer remote from existing upstream tracking ref.
        const t = await inferRemoteFromUpstream(gitTop);
        if (!t.ok) {
          return jsonRespond({
            error: ERROR_CODES.PUSH_NO_UPSTREAM,
            branch,
            detail: t.detail,
          });
        }
        remote = t.remote;
      }

      // --- Push ---
      const pushArgs: string[] = ["push"];
      if (args.setUpstream) pushArgs.push("-u");
      pushArgs.push(remote, branch);

      const pushResult = await spawnGitAsync(gitTop, pushArgs);
      if (!pushResult.ok) {
        return jsonRespond({
          ok: false,
          branch,
          remote,
          error: ERROR_CODES.PUSH_FAILED,
          detail: redactUrlCredentials(gitFailureDetail(pushResult)),
        });
      }

      // Probe the upstream tracking ref now (may have been set by -u).
      const upstreamProbe = await spawnGitAsync(gitTop, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{u}",
      ]);
      const upstream = upstreamProbe.ok ? upstreamProbe.stdout.trim() : `${remote}/${branch}`;

      // Append condensed git output (ref updates + remote messages; hook noise dropped)
      const gitOutput = condensePushOutput(pushResult.stdout, pushResult.stderr);

      return jsonRespond(
        buildGitPushJson({ branch, remote, upstream, setUpstream: args.setUpstream, gitOutput }),
      );
    },
  });
}
