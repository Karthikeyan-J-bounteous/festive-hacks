// Ops API for NudgeBee (SPEC-LITE §14.3). Machine-to-machine: Bearer OPS_TOKEN, not the session
// cookie. 401 when OPS_TOKEN is unset, so the routes are off unless configured.
import { timingSafeEqual } from 'node:crypto';
import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { tx } from '../db/db';
import { getBooth, run } from '../db/queries';
import { HttpError, parse } from '../http';
import { emitBoothChanged } from '../socket';
import { MAX_OPS_ARTISTS, opsOverview } from '../sponsors/nudgebee';

const Id = z.coerce.number().int().positive();
const ArtistsBody = z.object({ artists: z.number().int().min(1).max(MAX_OPS_ARTISTS) });

const requireOpsToken: RequestHandler = (req, _res, next) => {
  const token = process.env.OPS_TOKEN ?? '';
  const given = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1] ?? '';
  const ok = token.length > 0 && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  if (!ok) throw new HttpError(401, 'unauthorized', token ? 'Bad or missing ops token' : 'Ops API is not configured');
  next();
};

export const opsRouter = Router();
opsRouter.use(requireOpsToken);

opsRouter.get('/overview', (_req, res) => {
  res.json(opsOverview(Date.now()));
});

opsRouter.post('/booths/:id/artists', (req, res) => {
  const id = parse(Id, req.params.id);
  const { artists } = parse(ArtistsBody, req.body);
  const now = Date.now();
  tx(() => {
    const booth = getBooth(id);
    if (!booth) throw new HttpError(404, 'not_found', 'Booth not found');
    if (booth.mode !== 'live') throw new HttpError(409, 'not_live_booth', 'Feast booths seat by rounds, not artists');
    run(`UPDATE booths SET artists = ? WHERE id = ?`, artists, id);
  });
  emitBoothChanged(id, now); // every waiting guest gets a fresh ETA
  res.json({ booth: opsOverview(now).booths.find((b) => b.id === id) ?? null });
});
