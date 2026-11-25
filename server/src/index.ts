import { config } from './env';
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db/db';
import { seedIfEmpty } from './db/seed';

if (seedIfEmpty()) console.log('Seeded empty database.');

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM weddings').get() as { n: number };
  res.json({ ok: true, weddings: n });
});

// Production: serve the built Angular app from the same service.
const webDist = path.join(__dirname, '..', '..', 'web', 'dist', 'web', 'browser');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

if (require.main === module) {
  app.listen(config.port, () => console.log(`Varisai server on http://localhost:${config.port}`));
}
