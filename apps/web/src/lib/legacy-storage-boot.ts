import { moveLegacyStorage } from "./legacy-storage.ts";

// A module with this one side effect, imported first by main.tsx: theme.ts and layout-store.ts read storage
// (and layout-store writes defaults) when they load, so the old entries must be copied before either runs.
moveLegacyStorage();
