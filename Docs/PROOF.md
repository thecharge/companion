# Verification Proof Guide

This document defines reproducible checks for sandboxing posture, compliance-readiness posture, and provider connectivity.

## 1) Runtime and Sandboxing Proof

Run:

```bash
bun run proof:runtime
```

Output is a JSON report with checks:
- `server_secret`
- `sandbox_runtime`
- `sandbox_direct_fallback`
- `sandbox_probe`

Strict mode for release pipelines:

```bash
bun run proof:runtime -- --strict
```

Strict mode exits non-zero if any warning/failure exists.

## 2) Provider Readiness Proof

Run:

```bash
bun run proof:providers
```

Output is a JSON report per configured model alias with one of:
- `pass`: endpoint/model validation succeeded
- `skip`: credentials not provided
- `fail`: endpoint/model validation failed

Strict mode for release pipelines:

```bash
bun run proof:providers -- --strict
```

Strict mode exits non-zero on `fail` and `skip`.

## 3) Full Readiness Gate

Run:

```bash
bun run lint && bun run typecheck && bun run test && bun run readiness
```

## 4) Workflow-Based Evidence

- CI: `.github/workflows/ci.yml`
- Dependency review: `.github/workflows/dependency-review.yml`
- Readiness proof: `.github/workflows/proof.yml`

Use workflow logs and artifacts as objective evidence during release reviews.

## 5) Compliance Scope Boundary

Code-level proof can demonstrate:
- static and runtime controls present in this repository,
- repeatable gate execution,
- provider connectivity and config correctness,
- sandbox runtime posture.

Code alone cannot prove organization-wide compliance completion (for example, IAM governance, immutable external audit retention, key ceremonies, separation-of-duties, and third-party attestations). Those controls must be validated in infrastructure and process audits.
