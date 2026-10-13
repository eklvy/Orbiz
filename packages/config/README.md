# @campuscart/config

Shared TypeScript configuration for the CampusCart workspace.

- `tsconfig.base.json` — strict compiler settings used everywhere.
- `tsconfig.library.json` — for internal TypeScript packages (type-checked, not emitted; consumers compile the source).
- `tsconfig.nextjs.json` — for the Next.js apps.

ESLint is configured per app (Next.js flat config) because the web apps and the Expo app need different rule sets.
