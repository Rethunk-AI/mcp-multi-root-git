# Security Policy

## Reporting Security Vulnerabilities

**DO NOT** open a public GitHub issue for security vulnerabilities. Instead, please report them responsibly to:

**Email:** security@rethunk.tech  
**Response SLA:** We aim to respond to security reports within 24 hours.

When reporting a vulnerability, please include:
- Description of the vulnerability
- Affected component(s) and version(s)
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (optional)

## Scope & Risk Profile

`mcp-multi-root-git` is an MCP server that exposes git operations (status, log, diff, commit, push, merge) to LLMs. It has security implications due to git workflow access and repository state modification.

### Git Repository Access
- **Critical:** Server operates on local git repositories with user permissions
- Tools perform read (status, log, diff) and write operations (commit, push, merge)
- Multi-root setup allows access to multiple repos; ensure intended scope
- Token/credential handling for remote operations (push, pull)

### Write Operations Risk
- **High:** `batch_commit`, `git_push`, `git_merge`, `git_cherry_pick` modify repository state
- These operations can rewrite history, overwrite branches, lose commits if misused
- Implement safeguards against destructive operations (force-push, rebase on shared branches)
- Validate branch names and merge targets before operations

### Repository Credentials
- **Medium:** Push operations require git credentials (SSH keys, PAT tokens, or git credentials storage)
- SSH agent socket access required for SSH authentication
- Credentials should never be logged or exposed
- Validate that credentials are not embedded in code or environment

### File System Access
- **Medium:** Server accesses local filesystem to read/write git repositories
- Symlink traversal could allow access outside intended directory
- Validate paths to prevent directory escape attacks
- Restrict filesystem access to intended git repository roots

### Diff Output
- **Low-Medium:** Large diffs could expose sensitive data (API keys, passwords in code)
- Diff viewer truncates output; still be mindful of sensitive content
- Do not expose raw repository contents without review

## Security Practices

### Path Validation
- Validate all repository paths resolve within intended roots
- Prevent symlink traversal to parent directories
- Use absolute path resolution; validate against whitelist

### Operation Safety
- Implement safeguards on destructive operations (merge, cherry-pick, reset)
- Validate branch names match expected patterns
- Prevent force-push to protected branches (main, master, develop, stable, prod)
- Log all write operations for audit trails

### Credential Management
- Use SSH agent or git credentials storage; never embed credentials
- SSH key passphrase protection recommended
- Monitor git credentials for unusual access patterns
- Document credential setup requirements

### Dependency Management
- Keep git CLI up-to-date for security patches
- Monitor `simple-git` or git wrapper library for security updates
- Run `bun audit` regularly; address high/critical vulnerabilities

### Multi-Root Workspace Setup
- Document all workspace root directories
- Validate roots are intentional and secure
- Prevent unintended access to sibling or parent repositories
- Use absolute paths; validate against whitelist

## Supported Versions

Latest release only.

| Version | Supported |
|---------|-----------|
| Latest  | ✅ Yes    |

## Known Vulnerabilities

None currently known. Reports are welcome via security@rethunk.tech.

## Testing & Validation

- Test on non-critical repositories before production use
- Validate path traversal prevention with symlinks
- Test write operations on a test repository; verify nothing unintended is modified
- Test with invalid branch names and merge targets; validate error handling

## Incident Response

If a security vulnerability is discovered:

1. **Report immediately** to security@rethunk.tech (do not disclose publicly)
2. **Include reproduction steps** and affected version(s)
3. **Allow 24-48 hours** for initial response and triage
4. **Coordinate disclosure** timeline if patch is required
5. **Credit will be given** to the reporter (if desired)

## Contact

- **Security Issues:** security@rethunk.tech
- **General Support:** support@rethunk.tech
- **Website:** https://rethunk.tech

---

**Last updated:** 2026-04-27
