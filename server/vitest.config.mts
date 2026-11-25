import { defineConfig } from 'vitest/config';

// Each test file gets its own in-memory DB (files run in separate workers), seeded on import of the app.
export default defineConfig({ test: { env: { DB_PATH: ':memory:' } } });
