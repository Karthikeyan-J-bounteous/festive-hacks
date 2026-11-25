import { defineConfig } from 'vitest/config';

// Each test file gets its own in-memory DB (files run in separate workers), seeded on import of the app.
// Sponsor keys are blanked so tests never call real APIs (an existing env var wins over .env).
export default defineConfig({ test: { env: { DB_PATH: ':memory:', SARVAM_API_KEY: '' } } });
