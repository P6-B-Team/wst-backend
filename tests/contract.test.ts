import { describe, it, expect } from 'vitest';
import app from '../src/app.js';
import { openapi } from '../src/openapi.js';

/** Walks the Express router tree and returns every mounted "METHOD /path" under /api/v1. */
function mountedRoutes(): string[] {
  const found: string[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) found.push(`${method.toUpperCase()} ${path}`);
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const mount = layer.regexp?.fast_slash
          ? ''
          : String(layer.regexp?.source ?? '')
              .replace(/^\^/, '')
              .replace('\\/?(?=\\/|$)', '')
              .replace(/\$$/, '')
              .replace(/\\\//g, '/');
        walk(layer.handle.stack, prefix + mount);
      }
    }
  };
  walk((app as any)._router.stack, '');
  return [...new Set(found)];
}

const toOpenApiPath = (p: string) => p.replace(/:(\w+)/g, '{$1}');

describe('OpenAPI contract completeness', () => {
  const routes = mountedRoutes().filter((r) => r.includes('/api/v1'));
  const documented = new Set(
    Object.entries(openapi.paths).flatMap(([path, ops]: any) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
  );

  it('mounts a non-trivial API surface', () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it('documents every mounted endpoint', () => {
    const missing = routes.map((r) => {
      const [method, path] = r.split(' ');
      return `${method} ${toOpenApiPath(path)}`;
    }).filter((r) => !documented.has(r));
    expect(missing).toEqual([]);
  });

  it('does not document endpoints that do not exist', () => {
    const mounted = new Set(routes.map((r) => {
      const [method, path] = r.split(' ');
      return `${method} ${toOpenApiPath(path)}`;
    }));
    const phantom = [...documented].filter((d) => !mounted.has(d));
    expect(phantom).toEqual([]);
  });

  it('marks public endpoints as unauthenticated and everything else as bearer secured', () => {
    expect((openapi.paths as any)['/api/v1/auth/login'].post.security).toEqual([]);
    expect((openapi.paths as any)['/api/v1/certificates/verify/{token}'].get.security).toEqual([]);
    expect((openapi.paths as any)['/api/v1/jobs'].post.security).toBeUndefined(); // inherits the global bearerAuth
    expect(openapi.security).toEqual([{ bearerAuth: [] }]);
  });

  it('describes the documented error codes for business-rule endpoints', () => {
    const transitions = (openapi.paths as any)['/api/v1/jobs/{id}/transitions'].post;
    expect(Object.keys(transitions.responses)).toContain('422');
    const approvals = (openapi.paths as any)['/api/v1/purchase-orders/{id}/approvals'].post;
    expect(Object.keys(approvals.responses)).toContain('409');
  });

  it('serves the spec over HTTP', async () => {
    const request = (await import('supertest')).default;
    const r = await request(app).get('/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.info.title).toContain('WST');
    expect(Object.keys(r.body.paths).length).toBeGreaterThan(50);
  });
});
