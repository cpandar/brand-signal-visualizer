# ADR-001: Python + FastAPI for the backend

## Status
Accepted

## Context
The display node needs a backend process that (a) reads from Redis streams and (b) serves
a WebSocket endpoint and static HTTP files. Two natural candidates are Python and Node.js.

## Options considered

**Python + FastAPI**
- Consistent with the rest of the BRAND ecosystem (all nodes are Python)
- `redis-py` is already a declared dependency
- FastAPI has first-class async WebSocket support
- Contributors familiar with BRAND already know Python
- Slightly more verbose async patterns than Node.js

**Node.js + Express/ws**
- Natural fit for serving a React/TypeScript frontend
- JavaScript throughout (frontend and backend share types trivially)
- Adds a second runtime to the BRAND environment (Node.js not currently required)
- Disconnected from BRAND conventions and existing dependencies

## Decision
Python + FastAPI. The ecosystem consistency and zero additional runtime dependency
outweigh the minor convenience of a shared JS runtime.

## Consequences
- The frontend (React/TypeScript) and backend remain in different languages; shared type
  definitions (e.g. WebSocket message schemas) must be manually kept in sync or generated.
- Any contributor modifying the frontend still needs Node.js/npm as a dev-time tool,
  regardless of this decision.
