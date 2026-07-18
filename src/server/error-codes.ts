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

  // `root` array validation
  INVALID_ROOT_PATH: "invalid_root_path",
  ROOT_LIST_EMPTY: "root_list_empty",
  ROOT_LIST_NESTED_OR_PRESET_CONFLICT: "root_list_nested_or_preset_conflict",
  ROOT_LIST_PRESET_CONFLICT: "root_list_preset_conflict",
  ROOT_LIST_TOO_MANY: "root_list_too_many",

  // Presets
  PRESET_FILE_INVALID: "preset_file_invalid",
  PRESET_NOT_FOUND: "preset_not_found",

  // Input validation — tokens / refs / paths
  EMPTY_TAG_NAME: "empty_tag_name",
  INVALID_LINE_RANGE: "invalid_line_range",
  INVALID_PATHS: "invalid_paths",
  INVALID_REMOTE_OR_BRANCH: "invalid_remote_or_branch",
  INVALID_SINCE: "invalid_since",
  /** Canonical path-escape wire string (grep/diff/blame/show/stash). */
  PATH_ESCAPES_REPO: "path_escapes_repo",
  /**
   * Legacy path-escape alias used by `batch_commit`. Same failure class as
   * `PATH_ESCAPES_REPO`; clients should treat both as equivalent until a
   * future contract bump unifies them (Worker P owns batch_commit migration).
   */
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

  // Branch create/delete/rename
  BRANCH_CREATE_FAILED: "branch_create_failed",
  BRANCH_DELETE_FAILED: "branch_delete_failed",
  BRANCH_RENAME_FAILED: "branch_rename_failed",
  MISSING_NEW_NAME: "missing_new_name",

  // Commit / stage
  COMMIT_FAILED: "commit_failed",
  STAGE_FAILED: "stage_failed",

  // Diff
  GIT_DIFF_FAILED: "git_diff_failed",

  // Log
  GIT_LOG_FAILED: "git_log_failed",

  // Grep
  GIT_GREP_FAILED: "git_grep_failed",
  /** `git_grep` requires `pattern` and/or `pickaxe` — neither was supplied. */
  PATTERN_OR_PICKAXE_REQUIRED: "pattern_or_pickaxe_required",

  // Show
  GIT_SHOW_FAILED: "git_show_failed",

  // Remote
  REMOTE_LIST_FAILED: "remote_list_failed",

  // Describe
  DESCRIBE_FAILED: "describe_failed",
  NO_TAG_FOUND: "no_tag_found",
  UNSAFE_MATCH_PATTERN: "unsafe_match_pattern",

  // Blame
  GIT_BLAME_FAILED: "git_blame_failed",

  // Reflog
  REFLOG_FAILED: "reflog_failed",

  // Stash
  STASH_LIST_FAILED: "stash_list_failed",
  STASH_APPLY_FAILED: "stash_apply_failed",
  STASH_PUSH_FAILED: "stash_push_failed",

  // Fetch
  // (uses UNSAFE_REMOTE_TOKEN and UNSAFE_REF_TOKEN)

  // Push
  PUSH_DETACHED_HEAD: "push_detached_head",
  PUSH_FAILED: "push_failed",
  PUSH_NO_UPSTREAM: "push_no_upstream",

  // Merge
  CANNOT_FAST_FORWARD: "cannot_fast_forward",
  DESTINATION_NOT_FOUND: "destination_not_found",
  MERGE_ABORT_FAILED: "merge_abort_failed",
  MERGE_BASE_FAILED: "merge_base_failed",
  MERGE_CONFLICTS: "merge_conflicts",
  MERGE_FAILED: "merge_failed",
  REBASE_ABORT_FAILED: "rebase_abort_failed",
  REBASE_CONFLICTS: "rebase_conflicts",
  SOURCE_NOT_FOUND: "source_not_found",

  // Cherry-pick
  CHECKOUT_FAILED: "checkout_failed",
  CHERRY_PICK_ABORT_FAILED: "cherry_pick_abort_failed",
  CHERRY_PICK_TOO_MANY_COMMITS: "cherry_pick_too_many_commits",
  RANGE_RESOLUTION_FAILED: "range_resolution_failed",

  // Reset
  RESET_FAILED: "reset_failed",

  // Revert
  REVERT_ABORT_FAILED: "revert_abort_failed",

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
