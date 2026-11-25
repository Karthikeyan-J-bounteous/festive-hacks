import path from 'node:path';

// Load the repo-root .env if present. Import this module first, before anything reads process.env.
try {
  process.loadEnvFile(path.join(__dirname, '..', '..', '.env'));
} catch {
  /* no .env: defaults apply */
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  jwtSecret: process.env.JWT_SECRET ?? 'change-me',
  seedLat: Number(process.env.SEED_LAT ?? 13.0827),
  seedLng: Number(process.env.SEED_LNG ?? 80.2707),
};
