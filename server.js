const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json({ limit: '4mb' }));

// Bubble Bounce has one general PIN for the whole team.
const GENERAL_PIN = '4321';

function getIdentity(pin) {
  if (String(pin || '').trim() !== GENERAL_PIN) return null;
  return { name: 'Bubble Bounce Team', role: 'Staff' };
}

function dbClient() {
  const url = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.TURSO_TOKEN;
  if (!url) throw new Error('Missing TURSO_DATABASE_URL');
  if (!authToken) throw new Error('Missing TURSO_AUTH_TOKEN');
  return createClient({ url, authToken });
}

function scalar(v) {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return v;
}

function rowToObject(row, columns) {
  const obj = {};
  columns.forEach((c, i) => { obj[c] = scalar(row[i]); });
  return obj;
}

function text(v) { return v === undefined || v === null ? '' : String(v); }
function boolInt(v) { return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true' ? 1 : 0; }

async function ensureSchema(client) {
  await client.execute(`CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT NOT NULL,
    business TEXT NOT NULL DEFAULT 'bbb',
    customer_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    booking_date TEXT DEFAULT '',
    collection_date TEXT DEFAULT '',
    status TEXT DEFAULT 'confirmed',
    product_name TEXT DEFAULT '',
    extras TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    setup_notes TEXT DEFAULT '',
    balloon_colors TEXT DEFAULT '',
    delivery_time TEXT DEFAULT '',
    collection_time TEXT DEFAULT '',
    delivered INTEGER NOT NULL DEFAULT 0,
    collected INTEGER NOT NULL DEFAULT 0,
    hub_notes TEXT DEFAULT '',
    assigned_driver TEXT DEFAULT '',
    assigned_vehicle TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(business, external_id)
  )`);

  await client.execute(`CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT NOT NULL,
    category TEXT DEFAULT '',
    item_type TEXT DEFAULT 'equipment',
    quantity INTEGER NOT NULL DEFAULT 0,
    available_quantity INTEGER NOT NULL DEFAULT 0,
    motor_quantity INTEGER NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // Four stable driver/vehicle slots. The names can be changed in the Drivers tab,
  // while bookings stay linked to the slot (driver-1 / vehicle-1 etc.).
  await client.execute(`CREATE TABLE IF NOT EXISTS transport_slots (
    slot INTEGER PRIMARY KEY,
    driver_name TEXT DEFAULT '',
    vehicle_name TEXT DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  try { await client.execute("ALTER TABLE bookings ADD COLUMN assigned_driver TEXT DEFAULT ''"); } catch (_) {}
  try { await client.execute("ALTER TABLE bookings ADD COLUMN assigned_vehicle TEXT DEFAULT ''"); } catch (_) {}

  const defaults = [
    [1, '', 'Bantam'],
    [2, '', 'Vehicle 2'],
    [3, '', 'Vehicle 3'],
    [4, '', 'Vehicle 4']
  ];
  for (const [slot, driver, vehicle] of defaults) {
    await client.execute({
      sql: `INSERT OR IGNORE INTO transport_slots (slot, driver_name, vehicle_name) VALUES (?, ?, ?)`,
      args: [slot, driver, vehicle]
    });
  }

  await client.execute('CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_bookings_business ON bookings(business)');
}

async function listTables(client) {
  const rs = await client.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return rs.rows.map(r => String(r[0]));
}

async function readTransportSlots(client) {
  const rs = await client.execute('SELECT slot, driver_name, vehicle_name FROM transport_slots ORDER BY slot');
  return rs.rows.map(r => ({
    slot: Number(r[0]),
    driver_name: text(r[1]),
    vehicle_name: text(r[2])
  }));
}

async function saveTransportSlots(client, slots) {
  const safe = Array.isArray(slots) ? slots : [];
  for (const s of safe) {
    const slot = Number(s.slot);
    if (![1, 2, 3, 4].includes(slot)) continue;
    await client.execute({
      sql: `INSERT INTO transport_slots (slot, driver_name, vehicle_name, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(slot) DO UPDATE SET
              driver_name=excluded.driver_name,
              vehicle_name=excluded.vehicle_name,
              updated_at=CURRENT_TIMESTAMP`,
      args: [slot, text(s.driver_name).trim(), text(s.vehicle_name).trim()]
    });
  }
  return readTransportSlots(client);
}

async function readBookingTable(client) {
  const rs = await client.execute("SELECT * FROM bookings WHERE business = 'bbb' ORDER BY booking_date DESC, id DESC LIMIT 3000");
  const columns = rs.columns.map(String);
  return {
    allTableNames: await listTables(client),
    tables: [{ name: 'bookings', columns, rows: rs.rows.map(r => rowToObject(r, columns)) }],
    transportSlots: await readTransportSlots(client)
  };
}

function bookingParams(b, index) {
  const externalId = text(b.id ?? b.external_id ?? b._id ?? `manual-${Date.now()}-${index}`);
  const extras = Array.isArray(b.extras) ? b.extras.join('|') : text(b.extras);
  return {
    external_id: externalId,
    business: 'bbb',
    customer_name: text(b.name ?? b.customer_name),
    phone: text(b.phone),
    address: text(b.addr ?? b.address),
    booking_date: text(b.date ?? b.booking_date),
    collection_date: text(b.edate ?? b.collection_date ?? b.date),
    status: text(b.status || 'confirmed'),
    product_name: text(b.castleNameRaw ?? b.product_name ?? b.product ?? b.item),
    extras,
    notes: text(b.notes),
    setup_notes: text(b.setup ?? b.setup_notes),
    balloon_colors: text(b.balloonColors ?? b.balloon_colors),
    delivery_time: text(b._delivTime ?? b.delivery_time),
    collection_time: text(b._collectTime ?? b.collection_time),
    delivered: boolInt(b._delivered ?? b.delivered),
    collected: boolInt(b._collected ?? b.collected),
    hub_notes: text(b._hubNotes ?? b.hub_notes),
    assigned_driver: text(b._assignedDriver ?? b.assigned_driver),
    assigned_vehicle: text(b._assignedVehicle ?? b.assigned_vehicle)
  };
}

async function upsertBookings(client, bookings) {
  let saved = 0;
  for (let i = 0; i < bookings.length; i++) {
    const p = bookingParams(bookings[i], i);
    await client.execute({
      sql: `INSERT INTO bookings (
        external_id,business,customer_name,phone,address,booking_date,collection_date,status,
        product_name,extras,notes,setup_notes,balloon_colors,delivery_time,collection_time,
        delivered,collected,hub_notes,assigned_driver,assigned_vehicle,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(business, external_id) DO UPDATE SET
        customer_name=excluded.customer_name,
        phone=excluded.phone,
        address=excluded.address,
        booking_date=excluded.booking_date,
        collection_date=excluded.collection_date,
        status=excluded.status,
        product_name=excluded.product_name,
        extras=excluded.extras,
        notes=excluded.notes,
        setup_notes=excluded.setup_notes,
        balloon_colors=excluded.balloon_colors,
        delivery_time=excluded.delivery_time,
        collection_time=excluded.collection_time,
        -- Operational progress must survive a CSV re-import.
        delivered=bookings.delivered,
        collected=bookings.collected,
        hub_notes=CASE WHEN bookings.hub_notes <> '' THEN bookings.hub_notes ELSE excluded.hub_notes END,
        assigned_driver=CASE WHEN bookings.assigned_driver <> '' THEN bookings.assigned_driver ELSE excluded.assigned_driver END,
        assigned_vehicle=CASE WHEN bookings.assigned_vehicle <> '' THEN bookings.assigned_vehicle ELSE excluded.assigned_vehicle END,
        updated_at=CURRENT_TIMESTAMP`,
      args: [
        p.external_id,p.business,p.customer_name,p.phone,p.address,p.booking_date,p.collection_date,p.status,
        p.product_name,p.extras,p.notes,p.setup_notes,p.balloon_colors,p.delivery_time,p.collection_time,
        p.delivered,p.collected,p.hub_notes,p.assigned_driver,p.assigned_vehicle
      ]
    });
    saved++;
  }
  return saved;
}

const editableFieldMap = {
  _delivTime: 'delivery_time',
  _collectTime: 'collection_time',
  _delivered: 'delivered',
  _collected: 'collected',
  _hubNotes: 'hub_notes',
  _assignedDriver: 'assigned_driver',
  _assignedVehicle: 'assigned_vehicle',
  status: 'status'
};

async function updateBookingFieldInDb(client, externalId, field, value) {
  const col = editableFieldMap[field];
  if (!col) throw new Error('This booking field is not allowed to sync.');
  const val = (field === '_delivered' || field === '_collected') ? boolInt(value) : text(value);
  const rs = await client.execute({
    sql: `UPDATE bookings SET "${col}" = ?, updated_at = CURRENT_TIMESTAMP WHERE business = 'bbb' AND external_id = ?`,
    args: [val, text(externalId)]
  });
  return Number(rs.rowsAffected || 0);
}

async function healthPayload() {
  const client = dbClient();
  await client.execute('SELECT 1 AS ok');
  await ensureSchema(client);
  const names = await listTables(client);
  const countRs = await client.execute("SELECT COUNT(*) AS n FROM bookings WHERE business = 'bbb'");
  const bookingCount = Number(countRs.rows[0]?.[0] || 0);
  return { ok: true, database: true, tables: names, bookingCount, schemaReady: true };
}

app.get('/healthz', (req, res) => res.status(200).json({ ok: true, service: 'bubble-bounce-delivery-hub' }));

app.get('/api/health', async (req, res) => {
  try {
    res.json(await healthPayload());
  } catch (err) {
    console.error('Health error:', err);
    res.status(500).json({ ok: false, error: err.message || 'Server error', type: err.name || 'Error' });
  }
});

app.all('/api', async (req, res) => {
  const action = String(req.query.action || 'health');
  try {
    if (action === 'health') return res.json(await healthPayload());

    const pin = req.get('X-App-Pin') || (req.body && req.body.pin) || '';
    const identity = getIdentity(pin);
    if (!identity) return res.status(401).json({ ok: false, error: 'Incorrect PIN' });

    // Login is independent of Turso so a database outage does not look like a PIN error.
    if (action === 'login') return res.json({ ok: true, user: identity });

    const client = dbClient();
    await ensureSchema(client);

    if (action === 'bookings') {
      const data = await readBookingTable(client);
      return res.json({ ok: true, user: identity, ...data, fetchedAt: new Date().toISOString() });
    }

    if (action === 'save-bookings') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const bookings = Array.isArray(req.body?.bookings) ? req.body.bookings : [];
      if (bookings.length > 3000) return res.status(413).json({ ok: false, error: 'Too many bookings in one sync' });
      const saved = await upsertBookings(client, bookings);
      return res.json({ ok: true, saved, source: 'bbb' });
    }

    if (action === 'update-booking') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { externalId, field, value } = req.body || {};
      const changed = await updateBookingFieldInDb(client, externalId, field, value);
      return res.json({ ok: true, changed });
    }

    if (action === 'save-transport-settings') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const slots = await saveTransportSlots(client, req.body?.slots || []);
      return res.json({ ok: true, slots });
    }

    if (action === 'clear-bookings') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const beforeRs = await client.execute("SELECT COUNT(*) AS n FROM bookings WHERE business = 'bbb'");
      const deleted = Number(beforeRs.rows[0]?.[0] || 0);
      await client.execute("DELETE FROM bookings WHERE business = 'bbb'");
      return res.json({ ok: true, deleted });
    }

    return res.status(404).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('Bubble Bounce Delivery Hub API error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Server error', type: err.name || 'Error' });
  }
});

// Serve only the Bubble Bounce app page. Repository files are not public.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Bubble Bounce Delivery Hub running on port ${PORT}`);
  try {
    const client = dbClient();
    await ensureSchema(client);
    console.log('Turso schema ready: Bubble Bounce bookings, stock and transport slots checked/created.');
  } catch (err) {
    console.error('Startup database/schema check failed:', err.message || err);
  }
});
