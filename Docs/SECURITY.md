# Security Baseline

## Runtime Controls

1. API endpoints require secret authentication.
2. Server responses now include baseline security headers.
3. Tool execution supports container sandboxing.

## Recommended Hardening

1. Replace static shared secret with OIDC/JWT authn.
2. Add role-based authorization for sessions/tools/admin APIs.
3. Enforce TLS termination with mTLS in internal deployments.
4. Add per-tool policy controls:
- filesystem scope
- network egress policy
- process runtime limits

## Secrets

1. Do not store production secrets in `.env` files committed to git.
2. Use vault/KMS and rotate periodically.
3. Use separate credentials per environment.

## Supply Chain

1. Generate SBOM for each release.
2. Sign container and binary artifacts.
3. Block known vulnerable dependencies in CI.

## Incident Response Minimum

1. Severity matrix and paging policy
2. Forensic log retention period
3. Recovery runbooks with ownership
4. Post-incident review and corrective actions
