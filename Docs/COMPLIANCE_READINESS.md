# Compliance Readiness (SOC 2, ISO 27001, PCI DSS)

This document describes readiness direction, not certification.

## SOC 2 Readiness

Target trust service criteria:
- Security
- Availability
- Confidentiality

Required implementation tracks:
1. Access control and least privilege
2. Change management with approval trails
3. Logging + monitoring + incident response
4. Vendor and dependency risk process
5. Backup, disaster recovery, and tested restore

## ISO 27001 Readiness

Core ISMS elements to establish:
1. Risk assessment methodology
2. Statement of Applicability (SoA)
3. Security policy set and control ownership
4. Internal audit cadence
5. Management review process

## PCI DSS Readiness

If cardholder data is in scope:
1. Segment systems to minimize PCI scope
2. Strong auth and MFA for admin access
3. Continuous vulnerability management
4. File integrity monitoring and log retention
5. Encryption in transit and at rest for sensitive data

## Technical Control Mapping (Current vs Needed)

Current:
- API auth secret exists
- Sandbox execution support exists
- Local-first architecture reduces data exposure
- Security response headers are enabled in server responses
- Startup checks now surface unsafe runtime posture (missing sandbox image, direct fallback)
- Audit events are persisted in the configured DB backend and can be queried via authenticated `/audit/events`.
- Audit runtime currently operates in DB-only mode (no NDJSON mirror writes).

Needed:
- Identity and RBAC (user/service principals)
- Key management and rotation
- Tamper-evident / immutable audit log storage (WORM or external immutable sink)
- Formalized secrets handling for production
- Centralized policy-as-code checks in CI

## Production Enforcement Gates (Recommended)

Set these as required CI/CD and runtime controls before enterprise deployment:

1. Runtime guardrails
- `COMPANION_SECRET` must not use development default in production.
- `sandbox.allow_direct_fallback` must be `false` in production environments.
- `sandbox.runtime` must be pinned (`docker` or `podman`) in production.

2. Build and release controls
- Signed release artifacts and image digests.
- SBOM generation for every release build.
- Dependency vulnerability scan with fail-on-high/critical.

3. Operational controls
- Centralized structured logs with retention policy.
- Access review and rotation evidence for secrets.
- Documented incident response runbook and on-call ownership.

## Evidence You Will Need

1. CI logs and approvals
2. Access review records
3. Incident runbooks and postmortems
4. Vulnerability scan reports and remediation timelines
5. Backup/restore verification reports
