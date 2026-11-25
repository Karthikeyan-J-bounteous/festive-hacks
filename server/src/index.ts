import { config } from './env';
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import http from 'node:http';
import { initSocket } from './socket';
import { startTicker } from './ticker';
import path from 'node:path';
import { db } from './db/db';
import { seedIfEmpty } from './db/seed';
import { errorHandler } from './http';
import { authRouter } from './routes/auth';
import { guestRouter } from './routes/guest';
import { boothRouter } from './routes/booth';
import { adminRouter } from './routes/admin';

if (seedIfEmpty()) console.log('Seeded empty database.');

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/api/health', (_req, res) => {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM weddings').get() as { n: number };
  res.json({ ok: true, weddings: n });
});

app.use('/api', authRouter);
app.use('/api/guest', guestRouter);
app.use('/api/booth', boothRouter);
app.use('/api/admin', adminRouter);
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'No such API route' });
});
app.use(errorHandler);

// Production: serve the built Angular app from the same service.
const webDist = path.join(__dirname, '..', '..', 'web', 'dist', 'web', 'browser');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

if (require.main === module) {
  const server = http.createServer(app);
  initSocket(server);
  startTicker();
  server.listen(config.port, () => console.log(`Varisai server on http://localhost:${config.port}`));
}
