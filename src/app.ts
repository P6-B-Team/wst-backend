import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser'; // <-- NEW: needed to read the httpOnly refresh-token cookie
import crypto from 'node:crypto';
import swaggerUi from 'swagger-ui-express';
import { query } from './db/index.js';
import { errorHandler, fail, asyncRoute } from './http.js';
import { logInfo, logSecurity } from './logger.js';
import { openapi } from './openapi.js';
import { authRoutes } from './routes/auth.routes.js';
import { customerRoutes } from './routes/customers.routes.js';
import { jobRoutes } from './routes/jobs.routes.js';
import { inventoryRoutes } from './routes/inventory.routes.js';
import { purchasingRoutes } from './routes/purchasing.routes.js';
import { trainingRoutes, publicTrainingRoutes } from './routes/training.routes.js';
import { analyticsRoutes } from './routes/analytics.routes.js';

export const app = express();

app.use(helmet());

/**
 * CORS must never fall back to "*". An unset environment variable previously turned the API into
 * an origin-open service in exactly the deployment where the variable was most likely to be
 * forgotten. The default is now the documented local frontend, and production demands an explicit
 * list.
 */
const corsOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (!corsOrigins.length) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('CORS_ORIGINS must list the allowed frontend origins in production');
  corsOrigins.push('http://localhost:5173');
}
app.use(cors({ origin: corsOrigins, credentials: true }));
export const allowedCorsOrigins = corsOrigins;

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser()); // <-- NEW: parses req.cookies for the auth routes
app.use((req: any, res, next) => {
  req.requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logInfo('http_request', {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      userId: req.user?.id,
      organizationId: req.user?.organizationId,
    });
  });
  next();
});

/**
 * Simple in-memory rate limit (common-pack NFR). Authentication is limited harder than the rest of
 * the API because it is the credential-stuffing surface.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();
const limiter = (max: number, windowMs: number) => (req: any, res: any, next: any) => {
  const key = `${req.ip}:${req.path.startsWith('/api/v1/auth') ? 'auth' : 'api'}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) buckets.set(key, { count: 1, resetAt: now + windowMs });
  else if (++bucket.count > max) {
    res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
    logSecurity('rate_limited', { ip: req.ip, path: req.path });
    return fail(res, 429, 'RATE_LIMITED', 'Too many requests');
  }
  next();
};
const RATE_LIMIT_DISABLED = process.env.NODE_ENV === 'test' || process.env.RATE_LIMIT_DISABLED === 'true';
if (!RATE_LIMIT_DISABLED) {
  app.use('/api/v1/auth', limiter(Number(process.env.RATE_LIMIT_AUTH || 30), 60_000));
  app.use('/api/v1', limiter(Number(process.env.RATE_LIMIT_API || 600), 60_000));
}

app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', asyncRoute(async (_req: any, res: any) => {
  await query('select 1');
  res.json({ status: 'ready' });
}));

app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));
app.get('/openapi.json', (_req, res) => res.json(openapi));

/**
 * Blueprint-compatible endpoint aliases. The implementation remains centralized in the existing
 * domain routers so the public contract can use the streamlined workshop paths without creating
 * duplicate business logic or bypassing the existing authorization, validation, transactions and
 * audit logging.
 */
app.use('/api/v1', (req: any, _res, next) => {
  const path = req.path;
  if (req.method === 'POST' && path === '/auth/register') {
    if (req.body?.name && !req.body.displayName) req.body.displayName = req.body.name;
    req.url = '/users';
  } else if (req.method === 'POST' && path === '/workshop/vehicles' && req.body?.customerId) {
    req.url = `/customers/${req.body.customerId}/vehicles`;
  } else if (req.method === 'POST' && path === '/workshop/jobs') {
    req.url = '/jobs';
  } else if (req.method === 'PATCH' && /^\/workshop\/jobs\/[^/]+\/stage$/.test(path)) {
    req.method = 'POST';
    req.url = path.replace(/^\/workshop\/jobs\/([^/]+)\/stage$/, '/jobs/$1/transitions');
  } else if (req.method === 'POST' && /^\/workshop\/jobs\/[^/]+\/parts$/.test(path)) {
    req.url = path.replace(/^\/workshop\/jobs\/([^/]+)\/parts$/, '/jobs/$1/parts/issue');
  } else if (req.method === 'GET' && /^\/workshop\/jobs\/[^/]+\/invoice$/.test(path)) {
    req.url = path.replace(/^\/workshop\/jobs\/([^/]+)\/invoice$/, '/jobs/$1/invoice-preview');
  } else if (req.method === 'POST' && path === '/training/sessions') {
    req.url = '/training-sessions';
  } else if (req.method === 'POST' && path === '/training/assessments' && req.body?.sessionId) {
    req.url = `/training-sessions/${req.body.sessionId}/assessments`;
  } else if (req.method === 'GET' && /^\/training\/certificates\/verify\//.test(path)) {
    req.url = path.replace(/^\/training\/certificates\/verify\//, '/certificates/verify/');
  } else if (req.method === 'GET' && path === '/analytics/dashboard') {
    req.url = '/dashboards/workshop';
  }
  next();
});

const v1 = express.Router();
v1.use(publicTrainingRoutes); // public endpoints first: later routers apply auth to everything
v1.use(authRoutes);
v1.use(customerRoutes);
v1.use(jobRoutes);
v1.use(inventoryRoutes);
v1.use(purchasingRoutes);
v1.use(trainingRoutes);
v1.use(analyticsRoutes);
app.use('/api/v1', v1);

app.use((req, res) => fail(res, 404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`));
app.use(errorHandler);

export default app;
