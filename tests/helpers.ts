import request from 'supertest';
import app from '../src/app.js';

export const api = () => request(app);
export const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export async function login(email: string, password = 'Password123!') {
  const r = await api().post('/api/v1/auth/login').send({ email, password });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.data.accessToken as string, refreshToken: r.body.data.refreshToken as string, user: r.body.data.user };
}

export const as = (token: string) => ({
  get: (url: string) => api().get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body?: any) => api().post(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
  patch: (url: string, body?: any) => api().patch(url).set('Authorization', `Bearer ${token}`).send(body ?? {}),
});

/** Opens a job card that has already been approved by the customer. */
export async function approvedJob(managerToken: string) {
  const m = as(managerToken);
  const customer = (await m.post('/api/v1/customers', { name: uniq('Customer') })).body.data;
  const vehicle = (
    await m.post(`/api/v1/customers/${customer.id}/vehicles`, {
      plateNo: uniq('PL').slice(0, 14), vin: uniq('VIN'), make: 'Toyota', model: 'Corolla', year: 2021, mileage: 50000,
    })
  ).body.data;
  const job = (
    await m.post('/api/v1/jobs', {
      customerId: customer.id, vehicleId: vehicle.id, complaint: 'Brake noise', serviceType: 'BRAKES', receivedMileage: 50100,
    })
  ).body.data;
  await m.post(`/api/v1/jobs/${job.id}/customer-approvals`, {
    decision: 'APPROVED', channel: 'PHONE', referenceNo: uniq('APR'), approvedAmount: 2000,
  });
  return { customer, vehicle, job };
}

export async function firstStore(token: string) {
  return (await as(token).get('/api/v1/stores')).body.data.find((s: any) => s.code === 'MAIN');
}

export async function createStockedPart(token: string, onHand: number, sellPrice = 80) {
  const m = as(token);
  const store = await firstStore(token);
  const part = (await m.post('/api/v1/parts', {
    sku: uniq('SKU'), name: 'Test Part', minLevel: 1, maxLevel: 20, averageCost: 25, sellPrice,
  })).body.data;
  await m.post('/api/v1/stock/adjustments', { storeId: store.id, partId: part.id, delta: onHand, reason: 'Opening balance for test' });
  return { part, store };
}
