/**
 * Centralised error-code registry.
 *
 * Every value here is the exact string that appears on the wire in JSON
 * responses (the `error` field). Keys are SCREAMING_SNAKE equivalents so
 * callers get autocomplete and typos become compile errors.
 *
 * Adding a new code: append one entry here, then use ERROR_CODES.YOUR_CODE at
 * the call-site — do not introduce a new inline string literal.
 */
export const ERROR_CODES = {
  // Git availability
  GIT_NOT_FOUND: "git_not_found",

  // Repository resolution
  NOT_A_GIT_REPOSITORY: "not_a_git_repository",
  NO_WORKSPACE_ROOT: "no_workspace_root",

  // absoluteGitRoots validation
  ABSOLUTE_GIT_ROOTS_EMPTY: "absolute_git_roots_empty",
  ABSOLUTE_GIT_ROOTS_EXCLUSIVE: "absolute_git_roots_exclusive",
  ABSOLUTE_GIT_ROOTS_NESTED_OR_PRESET_CONFLICT: "absolute_git_roots_nested_or_preset_conflict",
  ABSOLUTE_GIT_ROOTS_PRESET_CONFLICT: "absolute_git_roots_preset_conflict",
  ABSOLUTE_GIT_ROOTS_SINGLE_REPO_ONLY: "absolute_git_roots_single_repo_only",
  ABSOLUTE_GIT_ROOTS_TOO_MANY: "absolute_git_roots_too_many",
  INVALID_ABSOLUTE_GIT_ROOT: "invalid_absolute_git_root",

  // Presets
  PRESET_FILE_INVALID: "preset_file_invalid",
  PRESET_NOT_FOUND: "preset_not_found",

  // Input validation — tokens / refs / paths
  EMPTY_TAG_NAME: "empty_tag_name",
  INVALID_LINE_RANGE: "invalid_line_range",
  INVALID_PATHS: "invalid_paths",
  INVALID_REMOTE_OR_BRANCH: "invalid_remote_or_branch",
  INVALID_SINCE: "invalid_since",
  PATH_ESCAPES_REPO: "path_escapes_repo",
  PATH_ESCAPES_REPOSITORY: "path_escapes_repository",
  UNSAFE_RANGE_TOKEN: "unsafe_range_token",
  UNSAFE_REF_TOKEN: "unsafe_ref_token",
  UNSAFE_REMOTE_TOKEN: "unsafe_remote_token",
  UNSAFE_TAG_TOKEN: "unsafe_tag_token",

  // Branch / ref state
  INTO_DETACHED_HEAD: "into_detached_head",
  ONTO_DETACHED_HEAD: "onto_detached_head",
  PROTECTED_BRANCH: "protected_branch",
  WORKING_TREE_DIRTY: "working_tree_dirty",

  // Branch list
  BRANCH_LIST_FAILED: "branch_list_failed",

  // Commit / stage
  COMMIT_FAILED: "commit_failed",
  STAGE_FAILED: "stage_failed",

  // Diff
  GIT_DIFF_FAILED: "git_diff_failed",

  // Log
  GIT_LOG_FAILED: "git_log_failed",

  // Show
  GIT_SHOW_FAILED: "git_show_failed",

  // Blame
  GIT_BLAME_FAILED: "git_blame_failed",

  // Reflog
  REFLOG_FAILED: "reflog_failed",

  // Stash
  STASH_LIST_FAILED: "stash_list_failed",

  // Fetch
  // (uses UNSAFE_REMOTE_TOKEN and UNSAFE_REF_TOKEN)

  // Push
  PUSH_DETACHED_HEAD: "push_detached_head",
  PUSH_FAILED: "push_failed",
  PUSH_NO_UPSTREAM: "push_no_upstream",

  // Merge
  CANNOT_FAST_FORWARD: "cannot_fast_forward",
  DESTINATION_NOT_FOUND: "destination_not_found",
  MERGE_BASE_FAILED: "merge_base_failed",
  MERGE_CONFLICTS: "merge_conflicts",
  MERGE_FAILED: "merge_failed",
  REBASE_CONFLICTS: "rebase_conflicts",
  SOURCE_NOT_FOUND: "source_not_found",

  // Cherry-pick
  CHECKOUT_FAILED: "checkout_failed",
  RANGE_RESOLUTION_FAILED: "range_resolution_failed",

  // Reset
  RESET_FAILED: "reset_failed",

  // Tag
  REF_NOT_FOUND: "ref_not_found",
  TAG_CREATE_FAILED: "tag_create_failed",
  TAG_DELETE_FAILED: "tag_delete_failed",
  TAG_VERIFICATION_FAILED: "tag_verification_failed",

  // Worktree
  CANNOT_REMOVE_MAIN_WORKTREE: "cannot_remove_main_worktree",
  WORKTREE_ADD_FAILED: "worktree_add_failed",
  WORKTREE_NOT_FOUND: "worktree_not_found",
  WORKTREE_REMOVE_FAILED: "worktree_remove_failed",

  // Inventory / parity
  NO_PAIRS: "no_pairs",
  REMOTE_BRANCH_MISMATCH: "remote_branch_mismatch",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
