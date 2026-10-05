const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json({ limit: '4mb' }));

const GENERAL_PIN = '4321';

function getIdentity(pin) {
  // Bubble Bounce uses one general PIN for everyone. No legacy staff PINs are accepted.
  if (String(pin || '').trim() !== GENERAL_PIN) return null;
  return { name: 'Bubble Bounce Team', role: 'Staff' };
}

function dbClient() {
  const url = process.env.TURSO_DATABASE_URL || process.env.TURSO_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.TURSO_TOKEN;
  if (!url) throw new Error('Missing TURSO_DATABASE_URL (or TURSO_URL)');
  if (!authToken) throw new Error('Missing TURSO_AUTH_TOKEN (or TURSO_TOKEN)');
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

  try { await client.execute("ALTER TABLE bookings ADD COLUMN assigned_driver TEXT DEFAULT ''"); } catch (_) {}
  try { await client.execute("ALTER TABLE bookings ADD COLUMN assigned_vehicle TEXT DEFAULT ''"); } catch (_) {}

  await client.execute('CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date)');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_bookings_business ON bookings(business)');
}

async function listTables(client) {
  const rs = await client.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return rs.rows.map(r => String(r[0]));
}

async function readBookingTable(client) {
  const rs = await client.execute('SELECT * FROM bookings ORDER BY booking_date DESC, id DESC LIMIT 3000');
  const columns = rs.columns.map(String);
  return {
    allTableNames: await listTables(client),
    tables: [{ name: 'bookings', columns, rows: rs.rows.map(r => rowToObject(r, columns)) }]
  };
}

function text(v) { return v === undefined || v === null ? '' : String(v); }
function boolInt(v) { return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true' ? 1 : 0; }

function bookingParams(source, b, index) {
  const externalId = text(b.id ?? b.external_id ?? b._id ?? index);
  const extras = Array.isArray(b.extras) ? b.extras.join('|') : text(b.extras);
  return {
    external_id: externalId,
    business: text(source || b._source || b.business || 'bbb'),
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

async function upsertBookings(client, source, bookings) {
  let saved = 0;
  for (let i = 0; i < bookings.length; i++) {
    const p = bookingParams(source, bookings[i], i);
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
        delivered=excluded.delivered,
        collected=excluded.collected,
        hub_notes=excluded.hub_notes,
        assigned_driver=CASE WHEN excluded.assigned_driver <> '' THEN excluded.assigned_driver ELSE bookings.assigned_driver END,
        assigned_vehicle=CASE WHEN excluded.assigned_vehicle <> '' THEN excluded.assigned_vehicle ELSE bookings.assigned_vehicle END,
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

async function updateBookingFieldInDb(client, source, externalId, field, value) {
  const col = editableFieldMap[field];
  if (!col) throw new Error('This booking field is not allowed to sync.');
  const val = (field === '_delivered' || field === '_collected') ? boolInt(value) : text(value);
  const rs = await client.execute({
    sql: `UPDATE bookings SET "${col}" = ?, updated_at = CURRENT_TIMESTAMP WHERE business = ? AND external_id = ?`,
    args: [val, text(source), text(externalId)]
  });
  return Number(rs.rowsAffected || 0);
}

async function healthPayload() {
  const client = dbClient();
  await client.execute('SELECT 1 AS ok');
  await ensureSchema(client);
  const names = await listTables(client);
  const countRs = await client.execute('SELECT COUNT(*) AS n FROM bookings');
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
    if (identity && identity.configError) return res.status(500).json({ ok: false, error: identity.configError });
    if (!identity) return res.status(401).json({ ok: false, error: 'Incorrect PIN' });

    // PIN validation must not depend on Turso being available. This lets staff log in
    // and lets the app show a useful database error separately if Turso is offline.
    if (action === 'login') {
      return res.json({ ok: true, user: identity });
    }

    const client = dbClient();
    await ensureSchema(client);

    if (action === 'bookings') {
      const data = await readBookingTable(client);
      return res.json({ ok: true, user: identity, ...data, fetchedAt: new Date().toISOString() });
    }

    if (action === 'save-bookings') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const source = text(req.body?.source || 'bbb');
      const bookings = Array.isArray(req.body?.bookings) ? req.body.bookings : [];
      if (source !== 'bbb') return res.status(400).json({ ok: false, error: 'This dashboard only accepts Bubble Bounce bookings.' });
      if (bookings.length > 3000) return res.status(413).json({ ok: false, error: 'Too many bookings in one sync' });
      const saved = await upsertBookings(client, source, bookings);
      return res.json({ ok: true, saved, source });
    }

    if (action === 'update-booking') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { source, externalId, field, value } = req.body || {};
      if (text(source) !== 'bbb') return res.status(400).json({ ok: false, error: 'This dashboard only accepts Bubble Bounce bookings.' });
      const changed = await updateBookingFieldInDb(client, source, externalId, field, value);
      return res.json({ ok: true, changed });
    }

    if (action === 'clear-bookings') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const beforeRs = await client.execute('SELECT COUNT(*) AS n FROM bookings');
      const deleted = Number(beforeRs.rows[0]?.[0] || 0);
      await client.execute('DELETE FROM bookings');
      // Reset AUTOINCREMENT only when SQLite has created the sequence table.
      try { await client.execute("DELETE FROM sqlite_sequence WHERE name='bookings'"); } catch (_) {}
      return res.json({ ok: true, deleted });
    }

    return res.status(404).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('Delivery Dash API error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'Server error', type: err.name || 'Error' });
  }
});

// Single-file frontend: serve only index.html. Do not expose server.js, package.json,
// deployment notes, or other repository files through the public web service.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Delivery Dash running on port ${PORT}`);
  try {
    const client = dbClient();
    await ensureSchema(client);
    console.log('Turso schema ready: bookings + stock tables checked/created.');
  } catch (err) {
    console.error('Startup database/schema check failed:', err.message || err);
  }
});
