# Database Architecture

This document defines production persistence boundaries, audit lineage, and migration flow.

## Goals

- Keep all persistence I/O inside `packages/db`.
- Maintain driver parity for sqlite and postgres.
- Ensure audit records contain who/what/when/where context.
- Use explicit, versioned migrations for schema evolution.

## Runtime Boundary

```mermaid
flowchart LR
  A[apps/server routes] --> B[AuditLogService]
  A --> C[SessionMessageService]
  C --> D[companion/db createDB]
  C --> E[companion/db createVectorStore]
  B --> F[companion/db AuditLogRepository]
  D --> G[(sessions/messages store)]
  E --> H[(vectors store)]
  F --> I[(audit_events store)]
  F --> J[data/audit-events.ndjson rotated mirror]
```

## Audit Record Lineage

```mermaid
sequenceDiagram
  participant Client
  participant Router as HTTP Router
  participant AuditSvc as AuditLogService
  participant AuditRepo as AuditLogRepository
  participant DB as sqlite/postgres

  Client->>Router: GET /sessions (headers: x-user-id, x-request-id, x-forwarded-for)
  Router->>AuditSvc: recordHttpEvent(action,status,request)
  AuditSvc->>AuditSvc: extract actor_id, source_ip, method, path, request_id
  AuditSvc->>AuditRepo: record(event_id,timestamp,category,action,status,who/where)
  AuditRepo->>DB: insert audit_events row
  AuditRepo->>AuditRepo: optional mirror file append+rotation
```

## Migration Flow

```mermaid
flowchart TD
  A[Service startup] --> B{db.driver}
  B -->|sqlite| C[runSqliteMigration]
  B -->|postgres| D[runPostgresMigration]
  C --> E[(db_migrations)]
  D --> E
  E --> F[core-sqlite-v1 / core-postgres-v1]
  E --> G[audit-sqlite-v1 / audit-postgres-v1]
  E --> H[vectors-sqlite-v1 / vectors-postgres-v1]
```

## Auditable Fields

Each `audit_events` row stores:

- `event_id`: stable event identifier
- `timestamp`: event time (UTC)
- `category`: domain category
- `action`: operation name
- `status`: result status
- `session_id`: related session
- `actor_id`: who initiated action
- `actor_type`: service/user/integration/system
- `source_ip`: origin address
- `request_id`: request correlation id
- `http_method`: request verb
- `http_path`: request route
- `user_agent`: caller fingerprint
- `metadata`: additional structured payload

## Operational Commands

```bash
bun run proof:db
bun run proof:db -- --strict
```

This proof validates DB CRUD, vector persistence, and audit who/where persistence using the configured driver.
