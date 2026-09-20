/**
 * OpenAPI contract. This is the document the frontend and any other consumer codes against, so it
 * is generated from one table that lists every route the server actually mounts.
 */

type Op = {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  public?: boolean;
  body?: any;
  queries?: string[];
  errors?: string[];
  /** Creates a resource: documented (and returned) as 201 Created instead of 200 OK. */
  created?: boolean;
};

const S = {
  str: { type: 'string' },
  uuid: { type: 'string', format: 'uuid' },
  num: { type: 'number' },
  int: { type: 'integer' },
  bool: { type: 'boolean' },
  dt: { type: 'string', format: 'date-time' },
};
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required });

const OPS: Op[] = [
  // Auth & users
  { method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Authenticate and receive access + refresh tokens', public: true, body: obj({ email: S.str, password: S.str }, ['email', 'password']), errors: ['401', '429'] },
  { method: 'post', path: '/auth/refresh', tag: 'Auth', summary: 'Rotate a refresh token', public: true, body: obj({ refreshToken: S.str }, ['refreshToken']), errors: ['401'] },
  { method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'Revoke a refresh token', public: true, body: obj({ refreshToken: S.str }, ['refreshToken']) },
  { method: 'get', path: '/me', tag: 'Auth', summary: 'Current user with roles and effective permissions' },
  { method: 'get', path: '/users', tag: 'Auth', summary: 'List users in the organization' },
  { method: 'post', path: '/users', tag: 'Auth', summary: 'Create a user and assign roles', body: obj({ email: S.str, password: S.str, displayName: S.str, roles: { type: 'array', items: S.str } }, ['email', 'password', 'displayName', 'roles']) , created: true },
  { method: 'patch', path: '/users/{id}/roles', tag: 'Auth', summary: 'Replace a user role assignment', body: obj({ roles: { type: 'array', items: S.str } }, ['roles']) },

  // Customers & vehicles
  { method: 'get', path: '/customers', tag: 'Customers', summary: 'Search customers', queries: ['q', 'page', 'pageSize'] },
  { method: 'post', path: '/customers', tag: 'Customers', summary: 'Create a customer', body: obj({ name: S.str, phone: S.str, email: S.str, preferredContact: { type: 'string', enum: ['PHONE', 'EMAIL', 'SMS'] } }, ['name']) },
  { method: 'get', path: '/customers/{id}', tag: 'Customers', summary: 'Customer with vehicles' },
  { method: 'patch', path: '/customers/{id}', tag: 'Customers', summary: 'Update a customer', body: obj({ name: S.str, phone: S.str, email: S.str, preferredContact: { type: 'string', enum: ['PHONE', 'EMAIL', 'SMS'] }, status: S.str, notes: S.str }) },
  { method: 'patch', path: '/vehicles/{id}', tag: 'Customers', summary: 'Update a vehicle. Mileage may only move forward.', body: obj({ plateNo: S.str, vin: S.str, make: S.str, model: S.str, year: S.int, mileage: S.int, status: S.str }), errors: ['422'] },
  { method: 'get', path: '/customers/{id}/vehicles', tag: 'Customers', summary: 'Vehicles of a customer' },
  { method: 'post', path: '/customers/{id}/vehicles', tag: 'Customers', summary: 'Register a vehicle', body: obj({ plateNo: S.str, vin: S.str, make: S.str, model: S.str, year: S.int, mileage: S.int }, ['plateNo', 'vin', 'make', 'model']) , created: true },
  { method: 'get', path: '/vehicles/{id}/service-history', tag: 'Customers', summary: 'Full service history with parts and invoice totals' },
  { method: 'post', path: '/vehicles/{id}/reminders/generate', tag: 'Customers', summary: 'Generate the next service reminder from org intervals' },
  { method: 'get', path: '/reminders', tag: 'Customers', summary: 'Due service reminders', queries: ['status'] },

  // Jobs
  { method: 'post', path: '/jobs', tag: 'Jobs', summary: 'Open a job card (status RECEIVED)', body: obj({ customerId: S.uuid, vehicleId: S.uuid, complaint: S.str, serviceType: S.str, priority: S.str, receivedMileage: S.int, expectedAt: S.dt, scheduledStartAt: S.dt, scheduledEndAt: S.dt, estimateAmount: S.num, bayId: S.uuid, technicianId: S.uuid }, ['customerId', 'vehicleId', 'complaint', 'serviceType', 'receivedMileage']) , created: true },
  { method: 'get', path: '/jobs', tag: 'Jobs', summary: 'List job cards', queries: ['status', 'q', 'page', 'pageSize'] },
  { method: 'get', path: '/jobs/{id}', tag: 'Jobs', summary: 'Job card with timeline, labor, parts, approvals, invoice' },
  { method: 'patch', path: '/jobs/{id}', tag: 'Jobs', summary: 'Assign bay, technician and schedule (step 2 of the primary workflow). Re-books the shared bay calendar and is rejected if the window overlaps another job or a published training session.', body: obj({ bayId: S.uuid, technicianId: S.uuid, priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] }, expectedAt: S.dt, scheduledStartAt: S.dt, scheduledEndAt: S.dt, estimateAmount: S.num, complaint: S.str, serviceType: S.str }), errors: ['400', '422'] },
  { method: 'post', path: '/jobs/{id}/customer-approvals', tag: 'Jobs', summary: 'Record the customer decision before billable work', body: obj({ decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] }, channel: { type: 'string', enum: ['PHONE', 'IN_PERSON', 'SMS', 'EMAIL', 'PORTAL'] }, referenceNo: S.str, approvedAmount: S.num, note: S.str }, ['decision', 'channel', 'referenceNo']), errors: ['422'] },
  { method: 'post', path: '/jobs/{id}/transitions', tag: 'Jobs', summary: 'Move the job card through its state machine', body: obj({ toStatus: { type: 'string', enum: ['IN_PROGRESS', 'QUALITY_CHECK', 'READY', 'DELIVERED', 'CANCELLED'] }, reason: S.str }, ['toStatus']), errors: ['422'] },
  { method: 'post', path: '/jobs/{id}/labor', tag: 'Jobs', summary: 'Record a labor entry. The hourly rate is resolved server side from the service-type rate, the technician rate, then the organisation default; it is never accepted from the client.', body: obj({ minutes: S.int, billable: S.bool, technicianId: S.uuid, note: S.str }, ['minutes']), errors: ['422'] },
  { method: 'post', path: '/jobs/{id}/sublet', tag: 'Jobs', summary: 'Record sublet work', body: obj({ vendorId: S.uuid, description: S.str, cost: S.num, price: S.num, billable: S.bool }, ['description', 'cost', 'price']) },
  { method: 'post', path: '/jobs/{id}/parts/issue', tag: 'Jobs', summary: 'Issue a part to the job card (atomic stock deduction). The selling price is read from the parts catalogue; a part without a selling price cannot be issued.', body: obj({ partId: S.uuid, storeId: S.uuid, quantity: S.num }, ['partId', 'storeId', 'quantity']), errors: ['422'] },
  { method: 'post', path: '/job-parts/{id}/reversals', tag: 'Jobs', summary: 'Reverse an issued part with reason and authorisation', body: obj({ quantity: S.num, reason: S.str }, ['quantity', 'reason']), errors: ['422'] },
  { method: 'get', path: '/jobs/{id}/invoice-preview', tag: 'Invoicing', summary: 'Computed invoice totals without persisting', queries: ['discount'] },
  { method: 'post', path: '/jobs/{id}/invoices', tag: 'Invoicing', summary: 'Issue the invoice computed from labor, parts and sublet', body: obj({ discount: S.num }), errors: ['409', '422'] },
  { method: 'get', path: '/invoices/{id}', tag: 'Invoicing', summary: 'Invoice with lines, payments and outstanding balance' },
  { method: 'post', path: '/invoices/{id}/payment-references', tag: 'Invoicing', summary: 'Attach a payment reference', body: obj({ referenceNo: S.str, amount: S.num, method: { type: 'string', enum: ['CASH', 'CARD', 'TRANSFER', 'WALLET'] }, note: S.str }, ['referenceNo', 'amount', 'method']) },

  // Inventory
  { method: 'get', path: '/parts', tag: 'Inventory', summary: 'Parts catalog with aggregated stock', queries: ['q', 'page', 'pageSize'] },
  { method: 'post', path: '/parts', tag: 'Inventory', summary: 'Create a part. sellPrice is the catalogue price invoices are computed from.', body: obj({ sku: S.str, name: S.str, nameAr: S.str, category: S.str, barcode: S.str, minLevel: S.num, maxLevel: S.num, averageCost: S.num, sellPrice: S.num }, ['sku', 'name']) },
  { method: 'patch', path: '/parts/{id}/price', tag: 'Inventory', summary: 'Change the catalogue selling price. The only way a price changes, separately permissioned and audited.', body: obj({ sellPrice: S.num, reason: S.str }, ['sellPrice']) },
  { method: 'patch', path: '/parts/{id}/levels', tag: 'Inventory', summary: 'Update min/max levels', body: obj({ minLevel: S.num, maxLevel: S.num }, ['minLevel', 'maxLevel']) },
  { method: 'get', path: '/stores', tag: 'Inventory', summary: 'List stores' },
  { method: 'post', path: '/stores', tag: 'Inventory', summary: 'Create a store', body: obj({ code: S.str, name: S.str }, ['code', 'name']) },
  { method: 'get', path: '/stock/balances', tag: 'Inventory', summary: 'Per store/part balances', queries: ['storeId'] },
  { method: 'get', path: '/stock/movements', tag: 'Inventory', summary: 'Immutable stock ledger', queries: ['partId', 'page', 'pageSize'] },
  { method: 'post', path: '/stock/adjustments', tag: 'Inventory', summary: 'Authorised stock adjustment with reason', body: obj({ storeId: S.uuid, partId: S.uuid, delta: S.num, reason: S.str }, ['storeId', 'partId', 'delta', 'reason']) },
  { method: 'post', path: '/stock/transfers', tag: 'Inventory', summary: 'Transfer stock between stores', body: obj({ fromStoreId: S.uuid, toStoreId: S.uuid, partId: S.uuid, quantity: S.num, reason: S.str }, ['fromStoreId', 'toStoreId', 'partId', 'quantity', 'reason']) },
  { method: 'get', path: '/stock/alerts', tag: 'Inventory', summary: 'Parts at or below minimum with explainable reorder suggestion' },

  // Purchasing
  { method: 'get', path: '/vendors', tag: 'Purchasing', summary: 'List vendors' },
  { method: 'post', path: '/vendors', tag: 'Purchasing', summary: 'Create a vendor', body: obj({ name: S.str, contact: S.str }, ['name']) },
  { method: 'post', path: '/purchase-orders', tag: 'Purchasing', summary: 'Create a draft purchase order; approvals required derived from threshold', body: obj({ vendorId: S.uuid, lines: { type: 'array', items: obj({ partId: S.uuid, quantity: S.num, unitCost: S.num }, ['partId', 'quantity', 'unitCost']) } }, ['vendorId', 'lines']) },
  { method: 'get', path: '/purchase-orders', tag: 'Purchasing', summary: 'List purchase orders', queries: ['status'] },
  { method: 'get', path: '/purchase-orders/{id}', tag: 'Purchasing', summary: 'Purchase order with lines, approvals and receipts' },
  { method: 'post', path: '/purchase-orders/{id}/submit', tag: 'Purchasing', summary: 'Submit for approval' },
  { method: 'post', path: '/purchase-orders/{id}/approvals', tag: 'Purchasing', summary: 'Record an approval decision (separation of duties enforced)', body: obj({ decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] }, note: S.str }, ['decision']), errors: ['409'] },
  { method: 'post', path: '/purchase-orders/{id}/goods-receipts', tag: 'Purchasing', summary: 'Record a PENDING goods receipt (no stock movement yet)', body: obj({ storeId: S.uuid, lines: { type: 'array', items: obj({ purchaseOrderLineId: S.uuid, acceptedQty: S.num, rejectedQty: S.num }, ['purchaseOrderLineId', 'acceptedQty']) } }, ['storeId', 'lines']) },
  { method: 'post', path: '/goods-receipts/{id}/accept', tag: 'Purchasing', summary: 'Accept the receipt — this is the only path that increases stock' },
  { method: 'post', path: '/goods-receipts/{id}/reject', tag: 'Purchasing', summary: 'Reject the receipt; stock is untouched', body: obj({ reason: S.str }, ['reason']) },

  // Training
  { method: 'post', path: '/terms', tag: 'Training', summary: 'Create a term', body: obj({ code: S.str, name: S.str, startsOn: S.str, endsOn: S.str }, ['code', 'name', 'startsOn', 'endsOn']) },
  { method: 'get', path: '/terms', tag: 'Training', summary: 'List terms' },
  { method: 'post', path: '/courses', tag: 'Training', summary: 'Create a course', body: obj({ code: S.str, name: S.str, durationHours: S.int, termId: S.uuid }, ['code', 'name']) },
  { method: 'get', path: '/courses', tag: 'Training', summary: 'List courses' },
  { method: 'post', path: '/competencies', tag: 'Training', summary: 'Create a competency', body: obj({ code: S.str, name: S.str }, ['code', 'name']) },
  { method: 'post', path: '/courses/{id}/tasks', tag: 'Training', summary: 'Add a practical task and map competencies', body: obj({ code: S.str, title: S.str, required: S.bool, weight: S.num, competencyIds: { type: 'array', items: S.uuid } }, ['code', 'title']) },
  { method: 'get', path: '/courses/{id}/tasks', tag: 'Training', summary: 'Practical tasks with competency mapping' },
  { method: 'post', path: '/student-groups', tag: 'Training', summary: 'Create a student group', body: obj({ code: S.str, name: S.str, termId: S.uuid }, ['code', 'name']) },
  { method: 'post', path: '/students', tag: 'Training', summary: 'Create a student', body: obj({ studentNo: S.str, fullName: S.str, userId: S.uuid, groupId: S.uuid }, ['studentNo', 'fullName']) },
  { method: 'get', path: '/students', tag: 'Training', summary: 'List students' },
  { method: 'post', path: '/training-sessions', tag: 'Training', summary: 'Create a draft session', body: obj({ courseId: S.uuid, title: S.str, startsAt: S.dt, endsAt: S.dt, bayId: S.uuid, mentorId: S.uuid, groupId: S.uuid, capacity: S.int }, ['courseId', 'startsAt', 'endsAt', 'capacity']) , created: true },
  { method: 'get', path: '/training-sessions', tag: 'Training', summary: 'List sessions', queries: ['status'] },
  { method: 'get', path: '/training-sessions/{id}/conflicts', tag: 'Training', summary: 'Dry-run bay/mentor/technician conflict check' },
  { method: 'post', path: '/training-sessions/{id}/publish', tag: 'Training', summary: 'Publish a session; rejected with 400 RESOURCE_CONFLICT on any bay, mentor or technician overlap (blueprint status table)' },
  { method: 'post', path: '/training-sessions/{id}/enrollments', tag: 'Training', summary: 'Enroll students (capacity enforced)', body: obj({ studentIds: { type: 'array', items: S.uuid } }, ['studentIds']) },
  { method: 'post', path: '/training-sessions/{id}/attendance', tag: 'Training', summary: 'Record attendance', body: obj({ studentId: S.uuid, status: { type: 'string', enum: ['PRESENT', 'ABSENT', 'LATE'] } }, ['studentId', 'status']) },
  { method: 'post', path: '/training-sessions/{id}/assessments', tag: 'Training', summary: 'Record an assessment (always PENDING_SIGNATURE)', body: obj({ studentId: S.uuid, taskId: S.uuid, result: { type: 'string', enum: ['PASS', 'FAIL', 'NEEDS_IMPROVEMENT'] }, timeOnTask: S.int, mentorNote: S.str }, ['studentId', 'taskId', 'result', 'timeOnTask']) },
  { method: 'post', path: '/assessments/{id}/signoff', tag: 'Training', summary: 'Supervisor sign-off (cannot be the recording mentor)', errors: ['409'] },
  { method: 'get', path: '/students/{id}/competency-coverage', tag: 'Training', summary: 'Coverage, attendance and blocking gaps for certification', queries: ['courseId'] },
  { method: 'post', path: '/training-sessions/{id}/cancel', tag: 'Training', summary: 'Cancel a session and release its bay back to the shared calendar', body: obj({ reason: S.str }, ['reason']), errors: ['422'] },
  { method: 'post', path: '/certificates', tag: 'Training', summary: 'Issue a certificate when all rules are met', body: obj({ studentId: S.uuid, courseId: S.uuid }, ['studentId', 'courseId']), errors: ['422'] },
  { method: 'post', path: '/certificates/{id}/revoke', tag: 'Training', summary: 'Revoke a certificate', body: obj({ reason: S.str }, ['reason']) },
  { method: 'get', path: '/certificates/verify/{token}', tag: 'Training', summary: 'Public certificate verification (minimal disclosure)', public: true },

  // Analytics
  { method: 'get', path: '/dashboards/workshop', tag: 'Analytics', summary: 'Workshop KPIs' },
  { method: 'get', path: '/dashboards/inventory', tag: 'Analytics', summary: 'Inventory KPIs' },
  { method: 'get', path: '/dashboards/finance', tag: 'Analytics', summary: 'Finance KPIs' },
  { method: 'get', path: '/dashboards/training', tag: 'Analytics', summary: 'Training KPIs' },
  { method: 'get', path: '/dashboards/student', tag: 'Analytics', summary: 'Student self-service dashboard', queries: ['studentId'] },
  { method: 'get', path: '/exports/{dataset}', tag: 'Analytics', summary: 'CSV/JSON export: jobs, invoices, stock, assessments, audit', queries: ['format'] },
  { method: 'get', path: '/predictions/reorder', tag: 'Analytics', summary: 'Explainable rule-based reorder baseline' },
  { method: 'get', path: '/predictions/training-risk', tag: 'Analytics', summary: 'Explainable training completion risk baseline', queries: ['courseId'] },
  { method: 'post', path: '/predictions/{model}/runs', tag: 'Analytics', summary: 'Persist a versioned prediction snapshot' },
  { method: 'get', path: '/predictions/{model}/runs', tag: 'Analytics', summary: 'Historical prediction runs' },
  { method: 'get', path: '/audit-events', tag: 'Analytics', summary: 'Audit trail', queries: ['entityType', 'action', 'page', 'pageSize'] },
  { method: 'get', path: '/notifications', tag: 'Analytics', summary: 'Notifications for the current user' },
  { method: 'post', path: '/notifications/{id}/read', tag: 'Analytics', summary: 'Mark a notification read' },
  { method: 'post', path: '/attachments', tag: 'Analytics', summary: 'Register attachment metadata', body: obj({ entityType: S.str, entityId: S.uuid, fileName: S.str, contentType: S.str, sizeBytes: S.int, storageKey: S.str }, ['entityType', 'entityId', 'fileName', 'contentType', 'sizeBytes', 'storageKey']) },
  { method: 'get', path: '/attachments', tag: 'Analytics', summary: 'Attachments for an entity', queries: ['entityType', 'entityId'] },
  { method: 'get', path: '/bays', tag: 'Analytics', summary: 'List bays' },
  { method: 'post', path: '/bays', tag: 'Analytics', summary: 'Create a bay', body: obj({ code: S.str, name: S.str }, ['code', 'name']) },
  { method: 'get', path: '/settings', tag: 'Analytics', summary: 'Organisation settings (tax, thresholds, intervals)' },
  { method: 'patch', path: '/settings', tag: 'Analytics', summary: 'Update organisation settings', body: obj({ taxRate: S.num, poApprovalThreshold: S.num, poApprovalsRequiredAbove: S.int, poApprovalsRequiredBelow: S.int, reminderIntervalDays: S.int, reminderIntervalKm: S.int, certificateMinAttendanceRatio: S.num }) },

  // ---- Added after mapping against the official PDF ----
  { method: 'get', path: '/vehicles/{id}', tag: 'Customers', summary: 'Vehicle detail with service history and the next service rule (WST-FR-03)' },
  { method: 'post', path: '/vehicles/{id}/archive', tag: 'Customers', summary: 'Archive a vehicle (blocked while job cards are open)', body: obj({ reason: S.str }, ['reason']), errors: ['422'] },
  { method: 'post', path: '/customers/{id}/archive', tag: 'Customers', summary: 'Archive a customer', body: obj({ reason: S.str }, ['reason']), errors: ['422'] },
  { method: 'get', path: '/jobs/{id}/work-items', tag: 'Jobs', summary: 'Work checklist of a job card (WST-FR-04)' },
  { method: 'post', path: '/jobs/{id}/work-items', tag: 'Jobs', summary: 'Add checklist items to a job card', body: obj({ items: { type: 'array', items: obj({ description: S.str, descriptionAr: S.str, required: S.bool }, ['description']) } }, ['items']) },
  { method: 'patch', path: '/work-items/{id}', tag: 'Jobs', summary: 'Update a checklist item; required items must be closed before quality check', body: obj({ status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'NOT_APPLICABLE'] }, note: S.str }, ['status']) },
  { method: 'post', path: '/jobs/{id}/parts/reserve', tag: 'Jobs', summary: 'Reserve stock for a job without moving it (WST-FR-06)', body: obj({ partId: S.uuid, storeId: S.uuid, quantity: S.num }, ['partId', 'storeId', 'quantity']), errors: ['422'] },
  { method: 'get', path: '/jobs/{id}/reservations', tag: 'Jobs', summary: 'Reservations held for a job card' },
  { method: 'post', path: '/reservations/{id}/release', tag: 'Jobs', summary: 'Release a reservation with a reason', body: obj({ reason: S.str }, ['reason']) },
  { method: 'get', path: '/invoices/{id}/statement', tag: 'Invoicing', summary: 'Invoice statement as JSON or PDF with a reconciliation block (WST-FR-09)', queries: ['format'] },
  { method: 'post', path: '/parts/{id}/compatibilities', tag: 'Inventory', summary: 'Record vehicle compatibility for a part (WST-FR-07)', body: obj({ make: S.str, model: S.str, yearFrom: S.int, yearTo: S.int }, ['make']) },
  { method: 'get', path: '/vehicles/{id}/compatible-parts', tag: 'Inventory', summary: 'Parts compatible with a vehicle, with availability' },
  { method: 'post', path: '/stock-counts', tag: 'Inventory', summary: 'Record a physical stock count (no stock movement yet)', body: obj({ storeId: S.uuid, reason: S.str, lines: { type: 'array', items: obj({ partId: S.uuid, countedQty: S.num }, ['partId', 'countedQty']) } }, ['storeId', 'reason', 'lines']) },
  { method: 'get', path: '/stock-counts/{id}', tag: 'Inventory', summary: 'Stock count with variance per line' },
  { method: 'post', path: '/stock-counts/{id}/approve', tag: 'Inventory', summary: 'Approve a count; this is what writes the adjustment to the ledger', errors: ['409', '422'] },
  { method: 'get', path: '/stock/reconciliation', tag: 'Inventory', summary: 'Proves every balance equals the sum of its ledger movements' },
  { method: 'get', path: '/certificates', tag: 'Training', summary: 'Issued and revoked certificates', queries: ['status', 'studentId', 'page', 'pageSize'] },

  // Student self-service (WST-FR-01: "a student cannot access another student's record").
  // None of these take an identifier: the student id comes from the token, so reading somebody
  // else's record is not expressible rather than merely rejected.
  { method: 'get', path: '/me/student', tag: 'Training', summary: 'The signed-in student profile', errors: ['403'] },
  { method: 'get', path: '/me/sessions', tag: 'Training', summary: 'Sessions the signed-in student is enrolled in, with their own attendance', queries: ['page', 'pageSize'], errors: ['403'] },
  { method: 'get', path: '/me/attendance', tag: 'Training', summary: 'The signed-in student attendance record and ratio', errors: ['403'] },
  { method: 'get', path: '/me/results', tag: 'Training', summary: 'Tasks and results for the signed-in student. Unsigned assessments are shown as pending, never as a grade.', errors: ['403'] },
  { method: 'get', path: '/me/competencies', tag: 'Training', summary: 'Competency coverage and certification gaps per course for the signed-in student', errors: ['403'] },
  { method: 'get', path: '/me/certificates', tag: 'Training', summary: 'Certificates issued to the signed-in student', errors: ['403'] },
  { method: 'get', path: '/me/certificates/{id}/qr', tag: 'Training', summary: 'Re-render the QR code for the student own certificate', queries: ['format'], errors: ['403', '404', '409'] },
  { method: 'get', path: '/certificates/{id}/qr', tag: 'Training', summary: 'QR code (SVG or PNG data URL) for the public verification URL (WST-FR-12)', queries: ['token', 'format'] },
  { method: 'get', path: '/dashboards/reconciliation', tag: 'Analytics', summary: 'Dashboard totals reconciled against source transactions (WST-FR-13)' },
  { method: 'post', path: '/predictions/runs/{id}/decision', tag: 'Analytics', summary: 'Record the human decision on a suggestion: accept, override or reject (WST-FR-14)', body: obj({ decision: { type: 'string', enum: ['ACCEPTED', 'OVERRIDDEN', 'REJECTED'] }, overrideValue: S.num, note: S.str, outcome: { type: 'object' } }, ['decision']) },
  { method: 'get', path: '/predictions/evaluation', tag: 'Analytics', summary: 'Acceptance / override / fallback statistics per model version' },
  { method: 'get', path: '/i18n/error-codes', tag: 'Analytics', summary: 'Bilingual error-code catalog for the UI (WST-FR-02)', public: true },
];


const envelope = (dataSchema: any = { type: 'object' }) => ({
  type: 'object',
  properties: { data: dataSchema, meta: { type: 'object' }, error: { type: 'object', nullable: true } },
});

const ERRORS: Record<string, string> = {
  400: 'Validation error, bay/mentor overlap (RESOURCE_CONFLICT / BAY_DOUBLE_BOOKED) or insufficient stock (INSUFFICIENT_STOCK)',
  401: 'Authentication required or invalid',
  403: 'Permission denied or outside organization scope',
  404: 'Not found',
  409: 'Conflict (duplicate, separation of duties, capacity, invalid state)',
  422: 'Business rule rejected the request',
  429: 'Too many attempts',
};

const paths: Record<string, any> = {};
for (const op of OPS) {
  const p = `/api/v1${op.path}`;
  paths[p] ||= {};
  const params = [
    ...Array.from(op.path.matchAll(/\{(\w+)\}/g)).map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    })),
    ...(op.queries ?? []).map((q) => ({ name: q, in: 'query', required: false, schema: { type: 'string' } })),
  ];
  paths[p][op.method] = {
    tags: [op.tag],
    summary: op.summary,
    operationId: `${op.method}${op.path.replace(/[\/{}-]/g, '_')}`,
    ...(op.public ? { security: [] } : {}),
    ...(params.length ? { parameters: params } : {}),
    ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: op.body } } } } : {}),
    responses: {
      [op.created ? 201 : 200]: {
        description: op.created ? 'Created' : 'Success',
        content: { 'application/json': { schema: envelope() } },
      },
      ...Object.fromEntries(
        [...new Set(['400', '401', '403', '404', ...(op.errors ?? [])])].map((code) => [
          code, { description: ERRORS[code], content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        ])
      ),
    },
  };
}

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'WST — Workshop Management & Student Practical Training API',
    version: '1.2.0',
    description:
      'Backend for Project 6. Every response uses the envelope { data, meta, error }. All business data is scoped by organization_id and enforced server side. Business rules (customer approval before billable work, computed invoices, non-negative stock, authorised reversals, purchase approval thresholds with separation of duties, stock only on accepted receipts, conflict-free session publishing, signed assessments before certification) are enforced in the API, not in the UI.',
  },
  servers: [{ url: process.env.PUBLIC_URL || 'http://localhost:4000' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Auth' }, { name: 'Customers' }, { name: 'Jobs' }, { name: 'Invoicing' },
    { name: 'Inventory' }, { name: 'Purchasing' }, { name: 'Training' }, { name: 'Analytics' },
  ],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          data: { nullable: true },
          meta: { type: 'object' },
          error: {
            type: 'object',
            properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' } },
          },
        },
      },
    },
  },
  paths,
};

export default openapi;
