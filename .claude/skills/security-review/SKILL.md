---
name: security-review
description: Security review: scan for vulnerabilities, OWASP Top 10, secrets, and dependency risks.
metadata:
  category: quality
  trigger: command
---

# Security Review

Conduct a focused security review before merging any code.

1. Identify all new inputs: HTTP parameters, file uploads, environment variables, CLI args, and database queries.
2. Check for OWASP Top 10 risks:
   - Injection (SQL, NoSQL, command, LDAP)
   - Broken authentication (session handling, token storage, password policies)
   - Sensitive data exposure (logging, TLS, encryption at rest)
   - XXE and deserialization flaws
   - Broken access control (IDOR, privilege escalation)
   - Security misconfiguration (default creds, debug mode, CORS)
   - XSS and SSRF
   - Unvalidated redirects
3. Scan diffs for secrets: API keys, tokens, passwords, private keys, cookies, database credentials.
4. Review dependency changes for known CVEs and license conflicts.
5. Verify error messages do not leak stack traces, internal paths, or business logic.
6. Produce a pass/fail summary with remediation steps for each finding.

Rules:
- Treat any hardcoded secret as an automatic fail.
- If a scanner is available, run it first and review the output; do not rely on the scanner alone.
