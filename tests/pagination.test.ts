/**
 * Common pack, engineering conventions: "Use pagination, filtering, sorting, and explicit export
 * jobs for large lists; enforce maximum page and export size." Several list endpoints returned
 * every row in the table with no page, no total and no ceiling.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { as, login } from './helpers.js';

let manager: any, supervisor: any, auditor: any;

beforeAll(async () => {
  manager = await login('manager@wst.local');
  supervisor = await login('supervisor@wst.local');
  auditor = await login('auditor@wst.local');
});

/** Endpoint, the token that may read it, and whether the seed guarantees more than one row. */
const ENDPOINTS: Array<[string, () => string, boolean]> = [
  ['/api/v1/customers', () => manager.token, true],
  ['/api/v1/jobs', () => manager.token, true],
  ['/api/v1/parts', () => manager.token, true],
  ['/api/v1/stores', () => manager.token, true],
  ['/api/v1/stock/balances', () => manager.token, true],
  ['/api/v1/stock/movements', () => manager.token, true],
  ['/api/v1/vendors', () => manager.token, true],
  ['/api/v1/purchase-orders', () => manager.token, true],
  ['/api/v1/students', () => supervisor.token, true],
  ['/api/v1/courses', () => supervisor.token, false],
  ['/api/v1/training-sessions', () => supervisor.token, true],
  ['/api/v1/certificates', () => supervisor.token, false],
  ['/api/v1/audit-events', () => auditor.token, true],
];

describe('every list endpoint is paginated', () => {
  for (const [path, token, multiRow] of ENDPOINTS) {
    it(`reports page metadata for ${path}`, async () => {
      const r = await as(token()).get(`${path}?page=1&pageSize=2`);
      expect(r.status, path).toBe(200);
      expect(Array.isArray(r.body.data)).toBe(true);
      expect(r.body.data.length).toBeLessThanOrEqual(2);
      expect(r.body.meta.page).toBe(1);
      expect(r.body.meta.pageSize).toBe(2);
      expect(r.body.meta).toHaveProperty('total');
    });

    if (multiRow) {
      it(`returns a different page two for ${path}`, async () => {
        const first = await as(token()).get(`${path}?page=1&pageSize=1`);
        const second = await as(token()).get(`${path}?page=2&pageSize=1`);
        expect(second.status).toBe(200);
        expect(second.body.meta.page).toBe(2);
        if (first.body.data.length && second.body.data.length)
          expect(JSON.stringify(second.body.data[0])).not.toBe(JSON.stringify(first.body.data[0]));
      });
    }
  }

  it('caps the page size so a caller cannot ask for the whole table', async () => {
    const r = await as(manager.token).get('/api/v1/parts?pageSize=100000');
    expect(r.status).toBe(200);
    expect(r.body.meta.pageSize).toBeLessThanOrEqual(200);
    expect(r.body.data.length).toBeLessThanOrEqual(200);
  });

  it('falls back to a sane page rather than failing on nonsense input', async () => {
    const r = await as(manager.token).get('/api/v1/parts?page=-5&pageSize=abc');
    expect(r.status).toBe(200);
    expect(r.body.meta.page).toBe(1);
    expect(r.body.meta.pageSize).toBeGreaterThan(0);
  });

  it('counts the whole filtered set, not just the returned page', async () => {
    const page = await as(manager.token).get('/api/v1/parts?pageSize=2');
    expect(page.body.meta.total).toBeGreaterThan(page.body.data.length);
  });
});
