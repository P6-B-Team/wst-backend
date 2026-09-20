import { pool } from './index.js';
import { hashPassword } from '../auth.js';

/**
 * Synthetic seed data sized for the acceptance scenarios.
 * Two organizations are created on purpose: ORG A is the demo workshop, ORG B exists so that
 * cross-organization isolation can be demonstrated and tested.
 */

const PERMISSIONS = [
  'customer:read', 'customer:write',
  'job:create', 'job:read', 'job:approve', 'job:transition',
  'labor:write',
  'stock:read', 'stock:write', 'stock:issue', 'stock:reverse', 'stock:adjust',
  // Narrow grants added for the streamlined blueprint: a technician may issue parts to a job card
  // (only that endpoint, not reservations or store operations) and a mentor may create a DRAFT
  // training session (publishing still needs training:write).
  'part:issue', 'training:schedule',
  'purchase:read', 'purchase:write', 'purchase:approve', 'purchase:receive',
  'invoice:read', 'invoice:write', 'payment:write',
  'training:read', 'training:write', 'attendance:write',
  'assessment:write', 'assessment:signoff',
  'certificate:issue', 'certificate:revoke',
  'report:read', 'audit:read', 'admin:users', 'attachment:write',
];

const ROLES: Record<string, string[]> = {
  WORKSHOP_MANAGER: [
    'customer:read', 'customer:write', 'job:create', 'job:read', 'job:approve', 'job:transition',
    'labor:write', 'stock:read', 'stock:write', 'stock:issue', 'stock:reverse', 'stock:adjust',
    'purchase:read', 'purchase:write', 'purchase:approve', 'purchase:receive',
    'invoice:read', 'invoice:write', 'payment:write', 'report:read', 'audit:read', 'admin:users', 'attachment:write',
  ],
  SERVICE_ADVISOR: ['customer:read', 'customer:write', 'job:create', 'job:read', 'job:approve', 'job:transition', 'invoice:read', 'invoice:write', 'payment:write', 'attachment:write'],
  TECHNICIAN: ['job:read', 'job:transition', 'labor:write', 'stock:read', 'part:issue', 'attachment:write'],
  QUALITY_CHECKER: ['job:read', 'job:transition', 'report:read'],
  STOREKEEPER: ['stock:read', 'stock:write', 'stock:issue', 'stock:adjust', 'purchase:read', 'purchase:receive', 'job:read'],
  STORE_SUPERVISOR: ['stock:read', 'stock:write', 'stock:issue', 'stock:reverse', 'stock:adjust', 'purchase:read', 'purchase:receive', 'report:read'],
  PROCUREMENT: ['purchase:read', 'purchase:write', 'stock:read', 'report:read'],
  PROCUREMENT_APPROVER: ['purchase:read', 'purchase:approve', 'report:read'],
  FINANCE_VIEWER: ['invoice:read', 'report:read'],
  TRAINING_SUPERVISOR: ['training:read', 'training:write', 'attendance:write', 'assessment:write', 'assessment:signoff', 'certificate:issue', 'certificate:revoke', 'report:read'],
  MENTOR: ['training:read', 'training:schedule', 'attendance:write', 'assessment:write', 'job:read'],
  STUDENT: [],
  AUDITOR: ['audit:read', 'report:read', 'job:read', 'stock:read', 'invoice:read', 'training:read'],
};

const ORG_A = '00000000-0000-0000-0000-000000000001';
const ORG_B = '00000000-0000-0000-0000-000000000002';

async function main() {
  const password = await hashPassword('Password123!');

  for (const [id, name] of [[ORG_A, 'WST Demo Workshop'], [ORG_B, 'Rival Workshop (isolation test)']] as const) {
    await pool.query('insert into organizations(id,name) values($1,$2) on conflict (id) do nothing', [id, name]);
    await pool.query('insert into org_settings(organization_id) values($1) on conflict do nothing', [id]);
  }

  for (const p of PERMISSIONS) await pool.query('insert into permissions(code) values($1) on conflict do nothing', [p]);
  for (const [role, perms] of Object.entries(ROLES)) {
    await pool.query('insert into roles(code) values($1) on conflict do nothing', [role]);
    const roleId = (await pool.query('select id from roles where code=$1', [role])).rows[0].id;
    await pool.query('delete from role_permissions where role_id=$1', [roleId]);
    for (const p of perms) {
      const pid = (await pool.query('select id from permissions where code=$1', [p])).rows[0].id;
      await pool.query('insert into role_permissions(role_id,permission_id) values($1,$2) on conflict do nothing', [roleId, pid]);
    }
  }

  const user = async (org: string, email: string, name: string, roles: string[]) => {
    const existing = await pool.query('select id from users where lower(email)=lower($1)', [email]);
    const id = existing.rowCount
      ? existing.rows[0].id
      : (await pool.query('insert into users(organization_id,email,password_hash,display_name) values($1,$2,$3,$4) returning id', [org, email, password, name])).rows[0].id;
    await pool.query('delete from user_roles where user_id=$1', [id]);
    for (const r of roles) {
      const rid = (await pool.query('select id from roles where code=$1', [r])).rows[0].id;
      await pool.query('insert into user_roles(user_id,role_id) values($1,$2) on conflict do nothing', [id, rid]);
    }
    return id as string;
  };

  const manager = await user(ORG_A, 'manager@wst.local', 'Mona Manager', ['WORKSHOP_MANAGER']);
  const advisor = await user(ORG_A, 'advisor@wst.local', 'Adel Advisor', ['SERVICE_ADVISOR']);
  const tech = await user(ORG_A, 'tech@wst.local', 'Tarek Technician', ['TECHNICIAN']);
  const qc = await user(ORG_A, 'qc@wst.local', 'Qadri Quality', ['QUALITY_CHECKER']);
  const technicians = [tech];
  for (let i = 2; i <= 5; i++)
    technicians.push(await user(ORG_A, `tech${i}@wst.local`, `Technician ${i}`, ['TECHNICIAN']));
  const keeper = await user(ORG_A, 'store@wst.local', 'Samir Storekeeper', ['STOREKEEPER']);
  const storeSup = await user(ORG_A, 'store.supervisor@wst.local', 'Sawsan Store Supervisor', ['STORE_SUPERVISOR']);
  const buyer = await user(ORG_A, 'buyer@wst.local', 'Peter Procurement', ['PROCUREMENT']);
  const approver1 = await user(ORG_A, 'approver1@wst.local', 'Aya Approver', ['PROCUREMENT_APPROVER']);
  const approver2 = await user(ORG_A, 'approver2@wst.local', 'Amr Approver', ['PROCUREMENT_APPROVER']);
  const supervisor = await user(ORG_A, 'supervisor@wst.local', 'Suzan Supervisor', ['TRAINING_SUPERVISOR']);
  const mentor = await user(ORG_A, 'mentor@wst.local', 'Magdy Mentor', ['MENTOR']);
  const mentors = [mentor];
  for (let i = 2; i <= 3; i++)
    mentors.push(await user(ORG_A, `mentor${i}@wst.local`, `Mentor ${i}`, ['MENTOR']));
  // 5 technicians + 3 mentors = the eight technicians/mentors the acceptance scenario asks for
  const auditor = await user(ORG_A, 'auditor@wst.local', 'Ola Auditor', ['AUDITOR']);
  const studentUser = await user(ORG_A, 'student@wst.local', 'Sara Student', ['STUDENT']);
  const rivalManager = await user(ORG_B, 'manager@rival.local', 'Rival Manager', ['WORKSHOP_MANAGER']);

  // ---- workshop resources
  for (const [code, name, nameAr] of [
    ['BAY-1', 'General Bay 1', 'خليج عام ١'],
    ['BAY-2', 'General Bay 2', 'خليج عام ٢'],
    ['BAY-3', 'Diagnostics Bay', 'خليج الفحص'],
    ['BAY-T', 'Training Bay', 'خليج التدريب'],
  ] as const)
    await pool.query(
      'insert into bays(organization_id,code,name,name_ar) values($1,$2,$3,$4) on conflict(organization_id,code) do update set name_ar=excluded.name_ar',
      [ORG_A, code, name, nameAr]
    );
  await pool.query('insert into bays(organization_id,code,name) values($1,$2,$3) on conflict(organization_id,code) do nothing', [ORG_B, 'BAY-1', 'Rival Bay']);

  const storeA = (await pool.query(
    "insert into stores(organization_id,code,name) values($1,'MAIN','Main Store') on conflict(organization_id,code) do update set name=excluded.name returning id",
    [ORG_A]
  )).rows[0].id;
  await pool.query("insert into stores(organization_id,code,name) values($1,'AUX','Auxiliary Store') on conflict(organization_id,code) do nothing", [ORG_A]);
  await pool.query("insert into stores(organization_id,code,name) values($1,'MAIN','Rival Store') on conflict(organization_id,code) do nothing", [ORG_B]);

  const auxStore = (await pool.query("select id from stores where organization_id=$1 and code='AUX'", [ORG_A])).rows[0].id;
  const makes = ['Toyota', 'Hyundai', 'Kia', 'Nissan'];

  /**
   * Opening stock is written as a balance *and* a matching ledger movement, so the append-only
   * ledger reconciles to the balances from the very first row (WST-FR-07 acceptance evidence).
   */
  const openingBalance = async (storeId: string, partId: string, qty: number) => {
    const existing = await pool.query('select id, on_hand from stock_balances where store_id=$1 and part_id=$2', [storeId, partId]);
    const current = existing.rowCount ? Number(existing.rows[0].on_hand) : 0;
    const delta = qty - current;
    if (existing.rowCount) await pool.query('update stock_balances set on_hand=$1 where id=$2', [qty, existing.rows[0].id]);
    else await pool.query('insert into stock_balances(store_id,part_id,on_hand,reserved) values($1,$2,$3,0)', [storeId, partId, qty]);
    if (delta === 0) return;
    await pool.query(
      `insert into stock_movements(organization_id,store_id,part_id,type,quantity,reference_type,reason,created_by,balance_after)
       values($1,$2,$3,'OPENING',$4,'SEED','Seeded opening balance',$5,$6)`,
      [ORG_A, storeId, partId, delta, manager, qty]
    );
  };
  for (let i = 1; i <= 100; i++) {
    const category = i % 3 === 0 ? 'FILTER' : i % 3 === 1 ? 'BRAKE' : 'ELECTRICAL';
    const nameAr = category === 'FILTER' ? `فلتر رقم ${i}` : category === 'BRAKE' ? `فرامل رقم ${i}` : `قطعة كهربائية ${i}`;
    const cost = 10 + (i % 7);
    // Every part carries a catalogue selling price: parts without one cannot be issued, because
    // the invoice is computed from this price rather than from anything the caller types.
    const sellPrice = Math.round(cost * 1.4 * 100) / 100;
    const part = (await pool.query(
      `insert into parts(organization_id,sku,name,name_ar,category,barcode,min_level,max_level,average_cost,sell_price)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict(organization_id,sku) do update set name=excluded.name, name_ar=excluded.name_ar,
             sell_price=excluded.sell_price returning id`,
      [ORG_A, `SKU-${String(i).padStart(4, '0')}`, `Demo Part ${i}`, nameAr, category,
       `62900000${String(i).padStart(5, '0')}`, 5, 40, cost, sellPrice]
    )).rows[0].id;
    await pool.query(
      `insert into part_compatibilities(part_id, make, model, year_from, year_to) values($1,$2,$3,2015,2026)
       on conflict do nothing`,
      [part, makes[i % makes.length], ['Corolla', 'Elantra', 'Cerato', 'Sunny'][i % 4]]
    );
    // a few parts deliberately start low so the reorder baseline has something to report
    const qty = i <= 5 ? 2 : 50;
    await openingBalance(storeA, part, qty);
    if (i % 2 === 0) await openingBalance(auxStore, part, 15);
  }

  // Labour rates live in the database, not in the request body (WST-FR-09 / the brief's
  // "hardest part": the invoice is computed from logged labour, so the rate must be a system fact).
  for (const [serviceType, rate] of [
    ['BRAKES', 180], ['DIAGNOSTICS', 220], ['AC', 200], ['SERVICE', 150], ['SUSPENSION', 190], ['ENGINE', 240],
  ] as const)
    await pool.query(
      `insert into labor_rates(organization_id, service_type, rate) values($1,$2,$3)
       on conflict(organization_id, service_type) do update set rate=excluded.rate`,
      [ORG_A, serviceType, rate]
    );
  await pool.query('update org_settings set default_labor_rate=150 where organization_id=$1', [ORG_A]);

  const customerIds: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const existing = await pool.query('select id from customers where organization_id=$1 and name=$2', [ORG_A, `Demo Customer ${i}`]);
    const c = existing.rowCount
      ? existing.rows[0].id
      : (await pool.query('insert into customers(organization_id,name,phone,email,preferred_contact) values($1,$2,$3,$4,$5) returning id', [
          ORG_A, `Demo Customer ${i}`, `0100000${String(i).padStart(4, '0')}`, `customer${i}@example.com`,
          ['PHONE', 'EMAIL', 'SMS'][i % 3],
        ])).rows[0].id;
    customerIds.push(c);
  }
  // 30 vehicles across 20 customers — some customers own more than one vehicle
  for (let i = 1; i <= 30; i++) {
    await pool.query(
      `insert into vehicles(organization_id,customer_id,plate_no,vin,make,model,year,mileage)
       values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
      [ORG_A, customerIds[i % customerIds.length], `ABC-${1000 + i}`, `VIN-DEMO-${String(i).padStart(8, '0')}`,
       makes[i % makes.length], ['Corolla', 'Elantra', 'Cerato', 'Sunny'][i % 4], 2018 + (i % 6), 40000 + i * 1000]
    );
  }
  const rivalCustomer = (await pool.query('insert into customers(organization_id,name,phone) values($1,$2,$3) returning id', [ORG_B, 'Rival Customer', '01055555555'])).rows[0].id;
  await pool.query('insert into vehicles(organization_id,customer_id,plate_no,vin,make,model,year) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing', [ORG_B, rivalCustomer, 'RIV-001', 'VIN-RIVAL-0001', 'Nissan', 'Sunny', 2020]);

  for (const [name, contact] of [['Nile Auto Parts', 'sales@nileparts.example'], ['Delta Spare Co', 'orders@deltaspare.example']] as const) {
    const exists = await pool.query('select 1 from vendors where organization_id=$1 and name=$2', [ORG_A, name]);
    if (!exists.rowCount) await pool.query('insert into vendors(organization_id,name,contact) values($1,$2,$3)', [ORG_A, name, contact]);
  }

  // ---- training catalogue
  const term = (await pool.query(
    `insert into terms(organization_id,code,name,starts_on,ends_on) values($1,'T-2026A','Spring 2026', current_date - 30, current_date + 90)
     on conflict(organization_id,code) do update set name=excluded.name returning id`,
    [ORG_A]
  )).rows[0].id;

  const courseExisting = await pool.query('select id from courses where organization_id=$1 and code=$2', [ORG_A, 'C-BRAKES']);
  const course = courseExisting.rowCount
    ? courseExisting.rows[0].id
    : (await pool.query('insert into courses(organization_id,code,name,duration_hours,term_id) values($1,$2,$3,$4,$5) returning id', [ORG_A, 'C-BRAKES', 'Brake Systems Practical', 40, term])).rows[0].id;

  const competencyIds: string[] = [];
  for (const [code, name] of [['CMP-DIAG', 'Diagnostics'], ['CMP-SAFE', 'Workshop Safety'], ['CMP-BRK', 'Brake Service']] as const) {
    const r = await pool.query(
      'insert into competencies(organization_id,code,name) values($1,$2,$3) on conflict(organization_id,code) do update set name=excluded.name returning id',
      [ORG_A, code, name]
    );
    competencyIds.push(r.rows[0].id);
  }

  const taskIds: string[] = [];
  for (const [i, [code, title]] of [['T-01', 'Inspect and measure brake discs'], ['T-02', 'Replace brake pads'], ['T-03', 'Bleed the brake system']].entries()) {
    const exists = await pool.query('select id from practical_tasks where course_id=$1 and code=$2', [course, code]);
    const id = exists.rowCount
      ? exists.rows[0].id
      : (await pool.query('insert into practical_tasks(course_id,code,title,required,weight) values($1,$2,$3,true,1) returning id', [course, code, title])).rows[0].id;
    await pool.query('insert into task_competencies(task_id,competency_id) values($1,$2) on conflict do nothing', [id, competencyIds[i % competencyIds.length]]);
    taskIds.push(id);
  }

  const group = (await pool.query(
    "insert into student_groups(organization_id,term_id,code,name) values($1,$2,'G-A','Group A') on conflict(organization_id,code) do update set name=excluded.name returning id",
    [ORG_A, term]
  )).rows[0].id;

  const groupB = (await pool.query(
    "insert into student_groups(organization_id,term_id,code,name) values($1,$2,'G-B','Group B') on conflict(organization_id,code) do update set name=excluded.name returning id",
    [ORG_A, term]
  )).rows[0].id;

  for (let i = 1; i <= 40; i++) {
    const no = `S-${String(i).padStart(3, '0')}`;
    const exists = await pool.query('select 1 from students where organization_id=$1 and student_no=$2', [ORG_A, no]);
    if (!exists.rowCount)
      await pool.query('insert into students(organization_id,student_no,full_name,user_id,group_id) values($1,$2,$3,$4,$5)', [
        ORG_A, no, `Student ${i}`, i === 1 ? studentUser : null, i <= 20 ? group : groupB,
      ]);
  }

  // four training sessions on non-overlapping windows (acceptance scenario 1)
  const trainingBay = (await pool.query("select id from bays where organization_id=$1 and code='BAY-T'", [ORG_A])).rows[0].id;
  for (const [i, title] of ['Brakes practical — week 1', 'Brakes practical — week 2', 'Diagnostics practical', 'Safety induction'].entries()) {
    const exists = await pool.query('select 1 from training_sessions where organization_id=$1 and title=$2', [ORG_A, title]);
    if (exists.rowCount) continue;
    await pool.query(
      `insert into training_sessions(organization_id,course_id,title,starts_at,ends_at,bay_id,mentor_id,group_id,capacity,status)
       values($1,$2,$3, date_trunc('hour', now()) + (($4 * 24) || ' hours')::interval,
              date_trunc('hour', now()) + (($4 * 24 + 3) || ' hours')::interval, $5, $6, $7, 20, 'DRAFT')`,
      [ORG_A, course, title, String(i + 1), trainingBay, mentors[i % mentors.length], i < 2 ? group : groupB]
    );
  }

  console.log(`Seed complete.
  Organizations : ORG A (demo) and ORG B (isolation test)
  Login password for every seeded account: Password123!
  manager@wst.local            WORKSHOP_MANAGER
  advisor@wst.local            SERVICE_ADVISOR
  tech@wst.local               TECHNICIAN
  qc@wst.local                 QUALITY_CHECKER
  store@wst.local              STOREKEEPER
  store.supervisor@wst.local   STORE_SUPERVISOR   (can reverse issued parts)
  buyer@wst.local              PROCUREMENT
  approver1@wst.local          PROCUREMENT_APPROVER
  approver2@wst.local          PROCUREMENT_APPROVER
  supervisor@wst.local         TRAINING_SUPERVISOR
  mentor@wst.local             MENTOR
  auditor@wst.local            AUDITOR
  student@wst.local            STUDENT
  manager@rival.local          WORKSHOP_MANAGER in ORG B`);
  void [advisor, tech, qc, keeper, storeSup, buyer, approver1, approver2, supervisor, auditor, manager, rivalManager, technicians, mentors];
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
