# Development privacy rules

- Never display, inspect, copy, export, or upload a user's real API key, encrypted credential, or configuration contents.
- Do not invoke `loadConfig` against the user's real `data/` for debugging. Only user-initiated application startup/setup may read its credential. Tests must use isolated temporary data and a memory credential vault with dummy keys.
- Do not run a paid AI request to test changes without explicit user authorization for that test. Prefer mocked provider responses and locally validated fixtures.
- Keep personal materials, answers, histories, backups, and credentials out of Git. Do not copy the whole data directory into public outputs.
- Do not start or stop the user's app unless requested. A source build does not replace an already-running server.
- Keep existing question objects and IDs unchanged for additive updates; draft keys depend on the entire canonical question object. Preserve history and create verified private backups for data changes.
