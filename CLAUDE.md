# JDauto Contributor Guide

Before changing code, read:

1. `CONTEXT.md` for domain language.
2. `DESIGN.md` for architecture and decisions.
3. The relevant document under `docs/`.

## Project invariants

- Keep the **Order Run** and product collection workflows independent.
- A **Product Record** may only be persisted after its detail payload is verified against the expected SKU.
- Commands sharing one **OpenCLI Profile** must run serially.
- Payment passwords are runtime-only and must never be written to configuration or logs.
- Do not bypass JD authentication, verification, or rate limits.
- Preserve the public CLI commands and JSON output shape unless a change is explicitly requested.

## Validation

```powershell
npm test
```

`npm test` builds the TypeScript sources before running the JavaScript tests, so it is safe on a clean checkout.

For Electron changes, also verify that the renderer uses `window.jdauto` through the preload IPC interface and does not enable Node.js integration.
