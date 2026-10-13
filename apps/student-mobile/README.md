# @campuscart/student-mobile (not yet scaffolded)

React Native + Expo student app. **Scaffolded and implemented in Phase 3**, not Phase 0, because:

- The Expo SDK version must be chosen together with the React/React Native versions current at that time.
- Expo's toolchain (Metro, native modules) is heavy and has nothing to verify until real screens exist.

Phase 3 will add it to the pnpm workspace (`apps/*` already matches this folder), consume
`@campuscart/contracts`, store the Supabase session in `expo-secure-store`, and talk only to
the CampusCart API + Supabase Realtime. No business logic, prices, or availability may be hardcoded.
