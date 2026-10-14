# @campuscart/student-mobile

The CampusCart student app for iOS and Android (Expo SDK 57, Expo Router, React Native 0.86).
It talks only to the CampusCart API and Supabase (Auth + Realtime). Shared logic (API client,
validation, formatting, order rules, Realtime helpers) lives in `@campuscart/client`.

## Run

```bash
pnpm db:start                                              # from the repo root
bash scripts/web-env.sh student-mobile http://<LAN-IP>:8000  # writes apps/student-mobile/.env
pnpm --filter @campuscart/student-mobile start             # Expo dev server; scan the QR with Expo Go
```

On a physical phone, use your computer's LAN IP (not `localhost`) for the API, and make sure the
API and Supabase are reachable on the network. The iOS Simulator needs Xcode **with an iOS
runtime installed**; the Android emulator needs Android Studio.

## Verify

```bash
pnpm --filter @campuscart/student-mobile typecheck
pnpm --filter @campuscart/student-mobile lint
pnpm --filter @campuscart/student-mobile export:native   # iOS + Android Hermes bundles
pnpm --filter @campuscart/student-mobile e2e             # web build + Playwright against the real backend
```

## Notes

- **Sessions** are stored with Supabase's recommended *LargeSecureStore* pattern: a random AES key
  in the iOS Keychain / Android Keystore (`expo-secure-store`), the encrypted session in AsyncStorage.
  The web build uses `localStorage`, like the website.
- **Password reset** emails open the student website's reset page (`EXPO_PUBLIC_PASSWORD_RESET_URL`);
  in-app deep-link handling is future work.
- `EXPO_PUBLIC_*` values are bundled into the app and are public. Never put secrets in `.env`.
- `AGENTS.md` here is Expo's guidance for this app (routes in `src/app/`, use `npx expo install`).
