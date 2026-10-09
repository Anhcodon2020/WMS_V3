require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3005;
const CA_CERT_PATH = process.env.MYSQL_CA_CERT_PATH || path.join(__dirname, 'ca.pem');
const pickingListExportProgress = new Map();
function setPickingListExportProgress(progressId, progress) {
  const updatedAt = Date.now();
  for (const [id, entry] of pickingListExportProgress) {
    if (entry.status !== 'running' && updatedAt - entry.updatedAt > 30 * 60 * 1000) {
      pickingListExportProgress.delete(id);
    }
  }
  pickingListExportProgress.set(progressId, { ...progress, updatedAt });
}

const mysqlSslOptions = (() => {
  try {
    if (fs.existsSync(CA_CERT_PATH)) {
      return { ca: fs.readFileSync(CA_CERT_PATH), rejectUnauthorized: true };
    }
  } catch (error) {
    // ignore and fallback to Aiven default SSL config
  }

  return { rejectUnauthorized: false };
})();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'mysql-connector-api' });
});

function parseConnectionString(connectionString) {
  if (!connectionString) return null;

  try {
    const url = new URL(connectionString);

    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.replace('/', '')),
      ssl: mysqlSslOptions
    };
  } catch (error) {
    return null;
  }
}

async function getConnection(config) {
  const finalConfig = {
    host: config.host,
    port: Number(config.port || 3306),
    user: config.user,
    password: config.password || '',
    database: config.database,
    ssl: config.ssl || mysqlSslOptions,
    connectTimeout: 10000,
    multipleStatements: false,
    charset: 'utf8mb4',
    decimalNumbers: true,
    typeCast: true,
    allowPublicKeyRetrieval: true
  };

  return mysql.createConnection(finalConfig);
}

function getTodayGMT7() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

app.post('/api/test-connection', async (req, res) => {
  const { host, port, user, password, database, connectionString } = req.body || {};
  const parsedConnection = parseConnectionString(connectionString);

  const finalConfig = parsedConnection || { host, port, user, password, database };

  if (!finalConfig.host || !finalConfig.user || !finalConfig.database) {
    return res.status(400).json({
      ok: false,
      message: 'Thiếu thông tin: host, user hoặc database.'
    });
  }

  let connection;

  try {
    connection = await getConnection(finalConfig);
    const [result] = await connection.execute('SELECT 1 + 1 AS ok');
    const [tables] = await connection.query('SHOW TABLES');
    const tableList = (tables || []).slice(0, 10).map((row) => Object.values(row)[0]);

    return res.json({
      ok: true,
      message: 'Kết nối MySQL thành công.',
      serverStatus: result[0]?.ok,
      tables: tableList
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Không thể kết nối đến MySQL.'
    });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

app.post('/api/query', async (req, res) => {
  const { host, port, user, password, database, sql, params, connectionString } = req.body || {};
  const parsedConnection = parseConnectionString(connectionString);
  const finalConfig = parsedConnection || { host, port, user, password, database };

  if (!finalConfig.host || !finalConfig.user || !finalConfig.database || !sql) {
    return res.status(400).json({
      ok: false,
      message: 'Thiếu thông tin kết nối hoặc cú pháp SQL.'
    });
  }

  let connection;

  try {
    connection = await getConnection(finalConfig);
    const [rows] = await connection.execute(sql, Array.isArray(params) ? params : []);

    return res.json({
      ok: true,
      rows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Không thể chạy câu lệnh SQL.'
    });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

function getMasterdataConfig(req) {
  const source = req.method === 'GET' ? req.query || {} : req.body || {};
  const { connectionString, host, port, user, password, database } = source;
  return parseConnectionString(connectionString) || { host, port, user, password, database };
}

function normalizeMasterdataRow(row) {
  const values = Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).toLowerCase().replace(/[^a-z0-9]/g, ''), value]));
  const getValue = (keys) => keys.map((key) => values[String(key).toLowerCase().replace(/[^a-z0-9]/g, '')]).find((value) => value !== undefined);
  const length = Number(getValue(['lenght', 'length', 'Lenght(cm)']) ?? 0);
  const width = Number(getValue(['width', 'width(cm)']) ?? 0);
  const height = Number(getValue(['height', 'Height(cm)']) ?? 0);
  const cartonPerPallet = Number(row.cartonperpallet ?? row.cartonPerPallet ?? 0);
  const sku = String(getValue(['sku']) || '').trim();
  const codeSup = String(getValue(['codesup', 'MANCC']) || '').trim();
  const kindPallet = row.kindpallet || (length <= 120 && width <= 120 ? '1m2' : length <= 160 && width <= 160 ? '1m6' : length <= 190 && width <= 190 ? '1m9' : 'oversize');

  return {
    MANCC: codeSup,
    sku,
    quantity: Number(getValue(['quantity', 'qty']) ?? 0),
    weight: Number(getValue(['weight']) ?? 0),
    lenght: length,
    width,
    height,
    cbm: (length * width * height) / 1000000,
    refix: getValue(['refix']) || (sku.length === 8 ? sku.slice(-5) : ''),
    loosecase: getValue(['loosecase', 'loosecarton']) || (height <= 10 ? 'Y' : 'N'),
    cartonperpallet: cartonPerPallet,
    kindpallet: kindPallet,
    chipboard: getValue(['chipboard']) || '',
    remark: getValue(['remark', 'remarks']) || ''
  };
}

app.get('/api/masterdata', async (req, res) => {
  const config = getMasterdataConfig(req);
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute(`
      SELECT m.*, n.Name_doc AS supplierName
      FROM masterdata m
      LEFT JOIN nhacungcap n ON n.MANCC = m.MANCC
      ORDER BY m.id DESC
    `);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải masterdata.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/suppliers', async (req, res) => {
  const config = getMasterdataConfig(req);
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute('SELECT MANCC, Name_doc FROM nhacungcap ORDER BY MANCC');
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải danh sách nhà cung cấp.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/suppliers', async (req, res) => {
  const config = getMasterdataConfig(req);
  const MANCC = String(req.body?.supplier?.MANCC || '').trim();
  const Name_doc = String(req.body?.supplier?.Name_doc || '').trim();
  if (!config.host || !config.user || !config.database || !MANCC || !Name_doc) return res.status(400).json({ ok: false, message: 'Cần nhập mã và tên nhà cung cấp.' });
  let connection;
  try {
    connection = await getConnection(config);
    await connection.execute('INSERT INTO nhacungcap (MANCC, Name_doc) VALUES (?, ?)', [MANCC, Name_doc]);
    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.code === 'ER_DUP_ENTRY' ? 'Mã nhà cung cấp đã tồn tại.' : (error.message || 'Không thể thêm nhà cung cấp.') });
  } finally { if (connection) await connection.end(); }
});

app.put('/api/suppliers/:mancc', async (req, res) => {
  const config = getMasterdataConfig(req);
  const MANCC = String(req.params.mancc || '').trim();
  const Name_doc = String(req.body?.supplier?.Name_doc || '').trim();
  if (!config.host || !config.user || !config.database || !MANCC || !Name_doc) return res.status(400).json({ ok: false, message: 'Cần nhập tên nhà cung cấp.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [result] = await connection.execute('UPDATE nhacungcap SET Name_doc = ? WHERE MANCC = ?', [Name_doc, MANCC]);
    if (!result.affectedRows) return res.status(404).json({ ok: false, message: 'Không tìm thấy nhà cung cấp.' });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể cập nhật nhà cung cấp.' });
  } finally { if (connection) await connection.end(); }
});

async function ensureInventoryTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      parent_po_invent VARCHAR(100),
      sku_inventory VARCHAR(100),
      qty_inventory DECIMAL(18,3) DEFAULT 0,
      date_rcv DATE,
      date_update DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      qty_rcv DECIMAL(18,3) DEFAULT 0,
      KEY idx_inventory_parentpo (parent_po_invent),
      KEY idx_inventory_sku (sku_inventory)
    )
  `);
}

app.get('/api/inventory', async (req, res) => {
  const config = getMasterdataConfig(req);
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureInventoryTable(connection);
    await ensureInboundLocationColumn(connection);
    const [rows] = await connection.execute(`
          SELECT i.*, m.cbm AS cbmperunit, DATEDIFF(DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)), i.date_rcv) AS due_date,
              (i.qty_inventory * COALESCE(m.cbm, 0)) AS totalcbm,
              (
                SELECT GROUP_CONCAT(DISTINCT NULLIF(TRIM(loc.location), '') SEPARATOR ',')
                FROM inbound loc
                WHERE TRIM(loc.po) = TRIM(i.parent_po_invent)
                  AND TRIM(loc.sku) = TRIM(i.sku_inventory)
                  AND DATE(loc.datercv) <=> i.date_rcv
              ) AS location
      FROM inventory i
      LEFT JOIN masterdata m ON m.sku = i.sku_inventory
      ORDER BY i.date_rcv DESC, i.id DESC
    `);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải inventory.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/inventory/import', (req, res) => {
  res.status(405).json({ ok: false, message: 'API import inventory chỉ hỗ trợ phương thức POST.' });
});

app.post('/api/inventory/import', async (req, res) => {
  const config = getMasterdataConfig(req);
  const inputRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const clearExisting = Boolean(req.body?.clearExisting);
  if (!config.host || !config.user || !config.database || !inputRows.length) return res.status(400).json({ ok: false, message: 'Thiếu kết nối hoặc dữ liệu import.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureInventoryTable(connection);
    await connection.beginTransaction();
    if (clearExisting) await connection.execute('DELETE FROM inventory');
    const rowsToImport = inputRows.filter((row) => Number(row.qty_inventory) > 0);
    for (const row of rowsToImport) {
      await connection.execute(
        'INSERT INTO inventory (parent_po_invent, sku_inventory, qty_inventory, date_rcv, date_update, qty_rcv) VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR), ?)',
        [String(row.parent_po_invent || '').trim(), String(row.sku_inventory || '').trim(), Number(row.qty_inventory || 0), row.date_rcv || null, Number(row.qty_rcv || 0)]
      );
    }
    await connection.commit();
    return res.json({ ok: true, inserted: rowsToImport.length });
  } catch (error) {
    if (connection) await connection.rollback();
    return res.status(500).json({ ok: false, message: error.message || 'Không thể import inventory.' });
  } finally { if (connection) await connection.end(); }
});

app.put('/api/inventory/:id/parentpo', async (req, res) => {
  const config = getMasterdataConfig(req);
  const id = Number(req.params.id);
  const parentpo = String(req.body?.parent_po_invent || '').trim();
  if (!config.host || !config.user || !config.database || !Number.isInteger(id) || !parentpo) return res.status(400).json({ ok: false, message: 'Thiếu id hoặc Parent PO.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureInventoryTable(connection);
    const [result] = await connection.execute('UPDATE inventory SET parent_po_invent = ?, date_update = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR) WHERE id = ?', [parentpo, id]);
    if (!result.affectedRows) return res.status(404).json({ ok: false, message: 'Không tìm thấy dòng inventory.' });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể cập nhật Parent PO.' });
  } finally { if (connection) await connection.end(); }
});

app.put('/api/inventory/:id/location', async (req, res) => {
  const config = getMasterdataConfig(req);
  const id = Number(req.params.id);
  const location = String(req.body?.location ?? '').trim();
  if (!config.host || !config.user || !config.database || !Number.isInteger(id) || !Object.prototype.hasOwnProperty.call(req.body || {}, 'location')) {
    return res.status(400).json({ ok: false, message: 'Thiếu id hoặc location.' });
  }
  let connection;
  try {
    connection = await getConnection(config);
    await ensureInventoryTable(connection);
    await ensureInboundLocationColumn(connection);
    const [[inventoryRow]] = await connection.execute(
      "SELECT parent_po_invent, sku_inventory, DATE_FORMAT(date_rcv, '%Y-%m-%d') AS date_rcv FROM inventory WHERE id = ?",
      [id]
    );
    if (!inventoryRow) return res.status(404).json({ ok: false, message: 'Không tìm thấy dòng inventory.' });
    const [inboundRows] = await connection.execute(`
      SELECT id
      FROM inbound
      WHERE TRIM(po) = TRIM(?)
        AND TRIM(sku) = TRIM(?)
        AND DATE(datercv) <=> ?
    `, [inventoryRow.parent_po_invent, inventoryRow.sku_inventory, inventoryRow.date_rcv]);
    if (!inboundRows.length) return res.status(404).json({ ok: false, message: 'Không tìm thấy inbound khớp Parent PO, SKU và ngày nhập.' });
    await connection.execute(`
      UPDATE inbound
      SET location = ?
      WHERE TRIM(po) = TRIM(?)
        AND TRIM(sku) = TRIM(?)
        AND DATE(datercv) <=> ?
    `, [location || null, inventoryRow.parent_po_invent, inventoryRow.sku_inventory, inventoryRow.date_rcv]);
    return res.json({ ok: true, affectedRows: inboundRows.length });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể cập nhật location.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/masterdata/import', async (req, res) => {
  const config = getMasterdataConfig(req);
  const inputRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!config.host || !config.user || !config.database || !inputRows.length) return res.status(400).json({ ok: false, message: 'Thiếu kết nối hoặc dữ liệu import.' });
  let connection;
  const result = { inserted: 0, updated: 0, rejected: [] };
  try {
    connection = await getConnection(config);
    await connection.beginTransaction();
    for (let index = 0; index < inputRows.length; index += 1) {
      const row = normalizeMasterdataRow(inputRows[index]);
      if (!row.MANCC || !row.sku) { result.rejected.push({ row: index + 2, reason: 'Thiếu CodeSup hoặc sku' }); continue; }
      const [suppliers] = await connection.execute('SELECT MANCC FROM nhacungcap WHERE MANCC = ? LIMIT 1', [row.MANCC]);
      if (!suppliers.length) { result.rejected.push({ row: index + 2, reason: `CodeSup ${row.MANCC} không tồn tại trong nhacungcap` }); continue; }
      const [existing] = await connection.execute('SELECT id FROM masterdata WHERE MANCC = ? AND sku = ? LIMIT 1', [row.MANCC, row.sku]);
      const values = [row.MANCC, row.sku, row.quantity, row.weight, row.lenght, row.width, row.height, row.cbm, row.refix, row.loosecase, row.cartonperpallet, row.kindpallet, row.chipboard, row.remark];
      if (existing.length) {
        await connection.execute(`UPDATE masterdata SET MANCC=?, sku=?, quantity=?, weight=?, lenght=?, width=?, height=?, cbm=?, refix=?, loosecase=?, cartonperpallet=?, kindpallet=?, chipboard=?, remark=? WHERE id=?`, [...values, existing[0].id]);
        result.updated += 1;
      } else {
        await connection.execute(`INSERT INTO masterdata (MANCC, sku, quantity, weight, lenght, width, height, cbm, refix, loosecase, cartonperpallet, kindpallet, chipboard, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, values);
        result.inserted += 1;
      }
    }
    await connection.commit();
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (connection) await connection.rollback();
    return res.status(500).json({ ok: false, message: error.message || 'Không thể import masterdata.', ...result });
  } finally { if (connection) await connection.end(); }
});

app.put('/api/masterdata/:id', async (req, res) => {
  const config = getMasterdataConfig(req);
  const id = Number(req.params.id);
  const row = normalizeMasterdataRow(req.body?.row || {});
  if (!config.host || !config.user || !config.database || !Number.isInteger(id) || !row.MANCC || !row.sku) return res.status(400).json({ ok: false, message: 'Thiếu id, kết nối hoặc dữ liệu masterdata.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [result] = await connection.execute(`UPDATE masterdata SET MANCC=?, sku=?, quantity=?, weight=?, length=?, width=?, height=?, cbm=?, refix=?, loosecase=?, cartonperpallet=?, kindpallet=?, chipboard=?, remark=? WHERE id=?`, [row.MANCC, row.sku, row.quantity, row.weight, row.lenght, row.width, row.height, row.cbm, row.refix, row.loosecase, row.cartonperpallet, row.kindpallet, row.chipboard, row.remark, id]);
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (error) { return res.status(500).json({ ok: false, message: error.message || 'Không thể cập nhật masterdata.' }); }
  finally { if (connection) await connection.end(); }
});

app.delete('/api/masterdata/:id', async (req, res) => {
  const config = getMasterdataConfig(req);
  const id = Number(req.params.id);
  if (!config.host || !config.user || !config.database || !Number.isInteger(id)) return res.status(400).json({ ok: false, message: 'Thiếu id hoặc kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [result] = await connection.execute('DELETE FROM masterdata WHERE id = ?', [id]);
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (error) { return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa masterdata.' }); }
  finally { if (connection) await connection.end(); }
});

function getBbrreportConfig(req) {
  const source = req.method === 'GET' ? req.query || {} : req.body || {};
  const { connectionString, host, port, user, password, database } = source;
  return parseConnectionString(connectionString) || { host, port, user, password, database };
}

async function ensureDsoTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS dso (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      release_key VARCHAR(200) NULL,
      status_dso VARCHAR(100) NULL,
      child_po VARCHAR(200) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_dso_release_key (release_key),
      KEY idx_dso_childpo (child_po)
    )
  `);
}

app.post('/api/dso/import/start', async (req, res) => {
  const config = getMasterdataConfig(req);
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureDsoTable(connection);
    const [result] = await connection.execute('DELETE FROM dso');
    return res.json({ ok: true, deletedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa dữ liệu DSO cũ.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/dso/import/batch', async (req, res) => {
  const config = getMasterdataConfig(req);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 500) : [];
  if (!config.host || !config.user || !config.database || !rows.length) return res.status(400).json({ ok: false, message: 'Không có dữ liệu DSO để nhập.' });
  const values = rows.map((row) => [String(row.release_key || '').trim(), String(row.status_dso || '').trim(), String(row.child_po || '').trim()]);
  let connection;
  try {
    connection = await getConnection(config);
    await ensureDsoTable(connection);
    const placeholders = values.map(() => '(?, ?, ?)').join(', ');
    const [result] = await connection.execute(`INSERT INTO dso (release_key, status_dso, child_po) VALUES ${placeholders}`, values.flat());
    return res.json({ ok: true, insertedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể nhập dữ liệu DSO.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/dso', async (req, res) => {
  const config = getMasterdataConfig(req);
  const releaseKey = String(req.query?.release_key || '').trim();
  const childPo = String(req.query?.child_po || '').trim();
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureDsoTable(connection);
    const filters = [releaseKey, `%${releaseKey}%`, childPo, `%${childPo}%`];
    const whereClause = `
      WHERE (? = '' OR TRIM(COALESCE(d.release_key, '')) LIKE ?)
        AND (? = '' OR TRIM(COALESCE(d.child_po, '')) LIKE ?)
    `;
    const [[summary]] = await connection.execute(`SELECT COUNT(*) AS totalRows FROM dso d ${whereClause}`, filters);
    const [rows] = await connection.execute(`
      SELECT d.release_key, d.status_dso, d.child_po, b.parentpo
      FROM dso d
      LEFT JOIN (
        SELECT
          TRIM(po) AS po,
          GROUP_CONCAT(DISTINCT NULLIF(TRIM(parentpo), '') ORDER BY TRIM(parentpo) SEPARATOR ', ') AS parentpo
        FROM bbrreport
        WHERE NULLIF(TRIM(po), '') IS NOT NULL
        GROUP BY TRIM(po)
      ) b ON b.po = TRIM(d.child_po)
      ${whereClause}
      ORDER BY d.id DESC
      LIMIT 5000
    `, filters);
    return res.json({ ok: true, totalRows: summary.totalRows, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải dữ liệu DSO.' });
  } finally { if (connection) await connection.end(); }
});

async function ensureReleasingTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS releasing (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      release_key VARCHAR(200) NULL,
      release_date VARCHAR(10) NULL,
      sku VARCHAR(150) NULL,
      release_qty DECIMAL(18,3) NOT NULL DEFAULT 0,
      status VARCHAR(100) NULL,
      original_qty DECIMAL(18,3) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_releasing_key (release_key),
      KEY idx_releasing_sku (sku)
    )
  `);
}

app.post('/api/releasing/import/start', async (req, res) => {
  const config = getMasterdataConfig(req);
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureReleasingTable(connection);
    const [result] = await connection.execute('DELETE FROM releasing');
    return res.json({ ok: true, deletedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa dữ liệu releasing cũ.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/releasing/import/batch', async (req, res) => {
  const config = getMasterdataConfig(req);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 500) : [];
  if (!config.host || !config.user || !config.database || !rows.length) return res.status(400).json({ ok: false, message: 'Không có dữ liệu releasing để nhập.' });
  const quantity = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const values = rows.map((row) => [
    String(row.release_key || '').trim(),
    String(row.release_date || '').trim(),
    String(row.sku || '').trim(),
    quantity(row.release_qty),
    String(row.status || '').trim(),
    quantity(row.original_qty)
  ]);
  let connection;
  try {
    connection = await getConnection(config);
    await ensureReleasingTable(connection);
    const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const [result] = await connection.execute(`INSERT INTO releasing (release_key, release_date, sku, release_qty, status, original_qty) VALUES ${placeholders}`, values.flat());
    return res.json({ ok: true, insertedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể nhập dữ liệu releasing.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/releasing', async (req, res) => {
  const config = getMasterdataConfig(req);
  const sku = String(req.query?.sku || '').trim();
  const releaseKey = String(req.query?.releaseKey || '').trim();
  const childPo = String(req.query?.childPo || '').trim();
  const parentPo = String(req.query?.parentPo || '').trim();
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureReleasingTable(connection);
    const whereClause = `
      WHERE (? = '' OR TRIM(r.sku) LIKE ?)
        AND (? = '' OR TRIM(r.release_key) LIKE ?)
        AND (? = '' OR EXISTS (
          SELECT 1 FROM dso d_filter
          WHERE TRIM(d_filter.release_key) = TRIM(r.release_key)
            AND TRIM(d_filter.child_po) LIKE ?
        ))
        AND (? = '' OR EXISTS (
          SELECT 1 FROM dso d_filter
          INNER JOIN bbrreport b_filter ON TRIM(b_filter.po) = TRIM(d_filter.child_po)
          WHERE TRIM(d_filter.release_key) = TRIM(r.release_key)
            AND TRIM(b_filter.parentpo) LIKE ?
        ))
    `;
    const filters = [sku, `%${sku}%`, releaseKey, `%${releaseKey}%`, childPo, `%${childPo}%`, parentPo, `%${parentPo}%`];
    const [[summary]] = await connection.execute(`SELECT COUNT(*) AS totalRows, COALESCE(SUM(r.release_qty), 0) AS totalReleaseQty FROM releasing r ${whereClause}`, filters);
    const [rows] = await connection.execute(`
      SELECT
        r.release_key,
        r.release_date,
        r.sku,
        r.release_qty,
        r.status,
        r.original_qty,
        GROUP_CONCAT(DISTINCT NULLIF(TRIM(d.child_po), '') ORDER BY TRIM(d.child_po) SEPARATOR ', ') AS child_po,
        GROUP_CONCAT(DISTINCT NULLIF(TRIM(b.parentpo), '') ORDER BY TRIM(b.parentpo) SEPARATOR ', ') AS parentpo
      FROM releasing r
      LEFT JOIN dso d ON TRIM(d.release_key) = TRIM(r.release_key)
      LEFT JOIN bbrreport b ON TRIM(b.po) = TRIM(d.child_po)
      ${whereClause}
      GROUP BY r.id, r.release_key, r.release_date, r.sku, r.release_qty, r.status, r.original_qty
      ORDER BY STR_TO_DATE(r.release_date, '%d/%m/%y') DESC, r.id DESC
      LIMIT 100
    `, filters);
    return res.json({ ok: true, totalRows: summary.totalRows, totalReleaseQty: summary.totalReleaseQty, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải dữ liệu releasing.' });
  } finally { if (connection) await connection.end(); }
});


async function ensureDetailPickingListTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS detail_pickinglist (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      picking_no VARCHAR(20) NOT NULL,
      hubdc VARCHAR(100) NULL,
      fdc VARCHAR(100) NULL,
      sku VARCHAR(150) NULL,
      carton_qty DECIMAL(18,3) NOT NULL DEFAULT 0,
      release_key VARCHAR(200) NULL,
      due_date INT NOT NULL DEFAULT 0,
      parentpo VARCHAR(200) NULL,
      childpo VARCHAR(200) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_detail_pickinglist_no (picking_no),
      KEY idx_detail_pickinglist_hubdc (hubdc),
      KEY idx_detail_pickinglist_sku (sku)
    )
  `);
}

async function ensureOutboundTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS outbound (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      jobno VARCHAR(100) NOT NULL,
      rsl VARCHAR(200) NULL,
      parentpo VARCHAR(200) NULL,
      childpo VARCHAR(200) NULL,
      fdc VARCHAR(100) NULL,
      sku VARCHAR(150) NULL,
      carton DECIMAL(18,3) NOT NULL DEFAULT 0,
      cbm DECIMAL(18,6) NOT NULL DEFAULT 0,
      datercv DATETIME NULL,
      container VARCHAR(50) NULL,
      seal VARCHAR(100) NULL,
      datestuff DATE NULL,
      plan_date DATE NULL,
      KEY idx_outbound_jobno (jobno),
      KEY idx_outbound_parentpo_sku (parentpo, sku)
    )
  `);
}

app.get('/api/allowcate/dashboard', async (req, res) => {
  const config = getMasterdataConfig(req);

  if (!config.host || !config.user || !config.database) {
    return res.status(400).json({
      ok: false,
      message: 'Thiếu thông tin kết nối database.'
    });
  }

  let connection;

  try {
    connection = await getConnection(config);

    // Đảm bảo bảng releasing tồn tại
    await ensureReleasingTable(connection);

    // =========================================================
    // 1. SUMMARY
    // =========================================================
    const [[summary]] = await connection.execute(`
      SELECT
        COUNT(*) AS totalRows,

        COUNT(
          DISTINCT NULLIF(TRIM(release_key), '')
        ) AS totalReleaseKeys,

        COALESCE(
          SUM(release_qty),
          0
        ) AS totalReleaseQty

      FROM releasing
      WHERE TRIM(COALESCE(status, '')) = '1'
        AND EXISTS (
          SELECT 1
          FROM dso sd
          INNER JOIN bbrreport sb ON TRIM(sb.po) = TRIM(sd.child_po)
          INNER JOIN inventory si
            ON TRIM(si.parent_po_invent) = TRIM(sb.parentpo)
           AND TRIM(si.sku_inventory) = TRIM(releasing.sku)
          WHERE TRIM(sd.release_key) = TRIM(releasing.release_key)
            AND COALESCE(si.qty_inventory, 0) > 0
        )
    `);

    // =========================================================
    // 2. DETAIL DATA
    // =========================================================
    const [rows] = await connection.execute(`
      SELECT
        r.release_key,
        r.release_date,
        r.sku,
        r.release_qty,
        r.status,

        TRIM(d.child_po) AS child_po,

        TRIM(b.parentpo) AS parentpo,

        TRIM(DC.hubdc) AS hubdc,

        TRIM(DC.fdc) AS fdc,

        COALESCE(inv.qty_inventory, 0) AS qty_inventory,

        COALESCE(m.cbm, 0) AS cbm_per_sku,

        DATE_FORMAT(inv.date_rcv, '%Y-%m-%d') AS date_rcv,

        DATEDIFF(
          DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)),
          inv.date_rcv
        ) AS due_date,

        ROUND(
          COALESCE(inv.qty_inventory, 0) * COALESCE(m.cbm, 0),
          3
        ) AS totalcbm,

        ROUND(
          LEAST(
            COALESCE(r.release_qty, 0),
            COALESCE(inv.qty_inventory, 0)
          ) * COALESCE(m.cbm, 0),
          3
        ) AS release_cbm

      FROM releasing r

      /* =====================================================
         DSO
         release_key -> child_po
         ===================================================== */
      LEFT JOIN (
        SELECT DISTINCT
          TRIM(release_key) AS release_key,
          TRIM(child_po) AS child_po

        FROM dso

        WHERE NULLIF(TRIM(release_key), '') IS NOT NULL
          AND NULLIF(TRIM(child_po), '') IS NOT NULL
      ) d

        ON BINARY TRIM(d.release_key)
         = BINARY TRIM(r.release_key)


      /* =====================================================
         BBR REPORT
         child_po -> parentpo
         ===================================================== */
      LEFT JOIN (
        SELECT DISTINCT
          TRIM(po) AS po,
          TRIM(parentpo) AS parentpo

        FROM bbrreport

        WHERE NULLIF(TRIM(po), '') IS NOT NULL
      ) b

        ON BINARY TRIM(b.po)
         = BINARY TRIM(d.child_po)


      /* =====================================================
         DC
         3 ký tự đầu của child_po -> dc.id

         Dùng CAST AS UNSIGNED để tránh:
         '018' <> '18'
         ===================================================== */
      LEFT JOIN DC

        ON CAST(DC.id AS UNSIGNED)
         = CAST(
             LEFT(TRIM(d.child_po), 3)
             AS UNSIGNED
           )


      /* =====================================================
         INVENTORY
         parentpo + sku -> quantity and receipt date
         ===================================================== */
      LEFT JOIN (
        SELECT
          TRIM(parent_po_invent) AS parentpo,
          TRIM(sku_inventory) AS sku,
          SUM(COALESCE(qty_inventory, 0)) AS qty_inventory,
          MAX(date_rcv) AS date_rcv
        FROM inventory
        WHERE NULLIF(TRIM(parent_po_invent), '') IS NOT NULL
          AND NULLIF(TRIM(sku_inventory), '') IS NOT NULL
        GROUP BY TRIM(parent_po_invent), TRIM(sku_inventory)
      ) inv

        ON BINARY inv.parentpo = BINARY TRIM(b.parentpo)
       AND BINARY inv.sku = BINARY TRIM(r.sku)


      /* =====================================================
         MASTERDATA
         sku -> CBM per unit
         ===================================================== */
      LEFT JOIN (
        SELECT
          TRIM(sku) AS sku,
          MAX(COALESCE(cbm, 0)) AS cbm
        FROM masterdata
        WHERE NULLIF(TRIM(sku), '') IS NOT NULL
        GROUP BY TRIM(sku)
      ) m

        ON BINARY m.sku = BINARY TRIM(r.sku)

      WHERE TRIM(COALESCE(r.status, '')) = '1'
        AND COALESCE(inv.qty_inventory, 0) > 0

      /* =====================================================
         SORT
         ===================================================== */
      ORDER BY

        CASE
          WHEN NULLIF(TRIM(b.parentpo), '') IS NULL THEN 0
          ELSE 1
        END ASC,

        STR_TO_DATE(
          r.release_date,
          '%d/%m/%y'
        ) DESC,

        r.id DESC,

        TRIM(d.child_po)

      LIMIT 20000
    `);

    // =========================================================
    // 3. RESPONSE
    // =========================================================
    return res.json({
      ok: true,
      summary,
      rows
    });

  } catch (error) {

    console.error(
      'ERROR /api/allowcate/dashboard:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        error.message ||
        'Không thể tải dashboard allocation.'
    });

  } finally {

    if (connection) {
      await connection.end();
    }
  }
});

app.post('/api/allowcate/picking', async (req, res) => {
  const config = getMasterdataConfig(req);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!config.host || !config.user || !config.database || !rows.length) {
    return res.status(400).json({ ok: false, message: 'Cần chọn ít nhất một dòng để tạo Picking.' });
  }

  let connection;
  try {
    connection = await getConnection(config);
    await ensureDetailPickingListTable(connection);
    const pickingNo = getTodayGMT7().replaceAll('-', '');
    await connection.beginTransaction();
    for (const row of rows) {
      await connection.execute(`
        INSERT INTO detail_pickinglist (
          picking_no, hubdc, fdc, sku, carton_qty, release_key,
          due_date, parentpo, childpo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        pickingNo,
        String(row.hubdc || '').trim(),
        String(row.fdc || '').trim(),
        String(row.sku || '').trim(),
        Number(row.release_qty || 0),
        String(row.release_key || '').trim(),
        Number(row.due_date || 0),
        String(row.parentpo || '').trim(),
        String(row.child_po || '').trim()
      ]);
    }
    await connection.commit();
    return res.json({ ok: true, pickingNo, inserted: rows.length });
  } catch (error) {
    if (connection) await connection.rollback();
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tạo Picking List.' });
  } finally {
    if (connection) await connection.end();
  }
});

app.get('/api/pickinglist', async (req, res) => {
  const config = getMasterdataConfig(req);
  const requestedPickingNo = String(req.query?.picking_no || '').trim();
  if (!config.host || !config.user || !config.database) {
    return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  }

  let connection;
  try {
    connection = await getConnection(config);
    await ensureDetailPickingListTable(connection);
    const [pickingRows] = await connection.execute(`
      SELECT DISTINCT picking_no
      FROM detail_pickinglist
      WHERE NULLIF(TRIM(picking_no), '') IS NOT NULL
      ORDER BY picking_no DESC
    `);
    const pickingNo = requestedPickingNo || String(pickingRows[0]?.picking_no || '').trim();
    if (!pickingNo) return res.json({ ok: true, pickingNos: [], pickingNo: '', summary: [], rows: [] });

    const [rows] = await connection.execute(`
      SELECT
        d.id,
        d.fdc,
        d.hubdc,
        d.parentpo,
        d.release_key,
        d.sku,
        COALESCE(n.Name_doc, '') AS supplier_name,
        d.childpo AS childlpo,
        d.due_date AS duedate,
        d.carton_qty,
        COALESCE(inv.qty_inventory, 0) AS qty_inventory,
        COALESCE(m.cbm, 0) AS cbm_per_sku,
        COALESCE(m.kindpallet, '') AS kindpallet,
        COALESCE(m.length, 0) AS length,
        COALESCE(m.width, 0) AS width,
        COALESCE(m.height, 0) AS height,
        ROUND((COALESCE(m.length, 0) * COALESCE(m.width, 0) * COALESCE(m.height, 0)) / 1000000, 6) AS dimension_cbm,
        ROUND(COALESCE(m.cbm, 0) * d.carton_qty, 3) AS total_cbm
      FROM detail_pickinglist d
      LEFT JOIN masterdata m ON TRIM(m.sku) = TRIM(d.sku)
      LEFT JOIN nhacungcap n ON TRIM(n.MANCC) = TRIM(m.MANCC)
      LEFT JOIN (
        SELECT
          TRIM(parent_po_invent) AS parentpo,
          TRIM(sku_inventory) AS sku,
          SUM(COALESCE(qty_inventory, 0)) AS qty_inventory
        FROM inventory
        GROUP BY TRIM(parent_po_invent), TRIM(sku_inventory)
      ) inv ON inv.parentpo = TRIM(d.parentpo) AND inv.sku = TRIM(d.sku)
      WHERE d.picking_no = ?
      ORDER BY TRIM(d.fdc), TRIM(d.hubdc), TRIM(d.parentpo), TRIM(d.sku), d.id
    `, [pickingNo]);
    const inventoryPools = new Map();
    const allocationOrder = [...rows].sort((left, right) => Number(right.duedate || 0) - Number(left.duedate || 0) || Number(left.id) - Number(right.id));
    for (const row of allocationOrder) {
      const key = `${String(row.parentpo || '').trim()}|${String(row.sku || '').trim()}`;
      if (!inventoryPools.has(key)) inventoryPools.set(key, Number(row.qty_inventory || 0));
      const remaining = inventoryPools.get(key);
      const allocated = Math.max(0, Math.min(remaining, Number(row.carton_qty || 0)));
      inventoryPools.set(key, remaining - allocated);
      row.qty_inventory = allocated;
    }
    const summary = Object.values(rows.reduce((groups, row) => {
      const fdc = String(row.fdc || '').trim() || 'Chưa map';
      if (!groups[fdc]) groups[fdc] = { fdc, total_cbm: 0, carton_qty: 0 };
      groups[fdc].total_cbm += Number(row.total_cbm || 0);
      groups[fdc].carton_qty += Number(row.carton_qty || 0);
      return groups;
    }, {})).map(row => ({ ...row, total_cbm: Number(row.total_cbm.toFixed(3)) }));
    return res.json({ ok: true, pickingNos: pickingRows.map(row => row.picking_no), pickingNo, summary, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải Picking List.' });
  } finally {
    if (connection) await connection.end();
  }
});



app.post('/api/pickinglist/delete', async (req, res) => {
  const config = getMasterdataConfig(req);
  const pickingNo = String(req.body?.picking_no || '').trim();
  if (!config.host || !config.user || !config.database || !pickingNo) {
    return res.status(400).json({ ok: false, message: 'Cần chọn Picking No để xóa dữ liệu.' });
  }

  let connection;
  try {
    connection = await getConnection(config);
    await ensureDetailPickingListTable(connection);
    const [result] = await connection.execute(
      'DELETE FROM detail_pickinglist WHERE picking_no = ?',
      [pickingNo]
    );
    return res.json({ ok: true, deletedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa dòng Picking.' });
  } finally {
    if (connection) await connection.end();
  }
});

app.post('/api/pickinglist/split', async (req, res) => {
  const config = getMasterdataConfig(req);
  const pickingNo = String(req.body?.picking_no || '').trim();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!config.host || !config.user || !config.database || !pickingNo || rows.length !== 1) {
    return res.status(400).json({ ok: false, message: 'Cần chọn đúng một SKU và số lượng tách.' });
  }

  let connection;
  try {
    connection = await getConnection(config);
    await ensureDetailPickingListTable(connection);
    await connection.beginTransaction();
    let inserted = 0;
    for (const selectedRow of rows) {
      const id = String(selectedRow.id ?? '').trim();
      const splitQty = Number(selectedRow.split_qty);
      if (!/^\d+$/.test(id) || !Number.isFinite(splitQty) || splitQty <= 0) throw new Error('ID hoặc số lượng tách không hợp lệ.');
      const [[source]] = await connection.execute(`
        SELECT d.*, COALESCE(inv.qty_inventory, 0) AS qty_inventory
        FROM detail_pickinglist d
        LEFT JOIN (
          SELECT TRIM(parent_po_invent) AS parentpo, TRIM(sku_inventory) AS sku,
                 SUM(COALESCE(qty_inventory, 0)) AS qty_inventory
          FROM inventory
          GROUP BY TRIM(parent_po_invent), TRIM(sku_inventory)
        ) inv ON inv.parentpo = TRIM(d.parentpo) AND inv.sku = TRIM(d.sku)
        WHERE d.id = ? AND d.picking_no = ?
        LIMIT 1 FOR UPDATE
      `, [id, pickingNo]);
      if (!source) throw new Error('Không tìm thấy đúng dòng Picking cần tách.');
      const sourceCartonQty = Number(source.carton_qty || 0);
      if (splitQty > sourceCartonQty) {
        throw new Error(`Số lượng tách của SKU ${source.sku} vượt quá số lượng còn lại.`);
      }
      if (splitQty > Number(source.qty_inventory || 0)) {
        throw new Error(`SKU ${source.sku} không đủ tồn kho để tách.`);
      }
      await connection.execute('UPDATE detail_pickinglist SET carton_qty = carton_qty - ? WHERE id = ?', [splitQty, source.id]);
      await connection.execute(`
        INSERT INTO detail_pickinglist (
          picking_no, hubdc, fdc, sku, carton_qty, release_key,
          due_date, parentpo, childpo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [source.picking_no, source.hubdc, source.fdc, source.sku, splitQty, source.release_key, source.due_date, source.parentpo, source.childpo]);
      inserted += 1;
    }
    await connection.commit();
    return res.json({ ok: true, inserted });
  } catch (error) {
    if (connection) await connection.rollback();
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tách SKU.' });
  } finally {
    if (connection) await connection.end();
  }
});

app.get('/api/pickinglist/export-outbound/progress', (req, res) => {
  const progressId = String(req.query?.progress_id || '').trim();
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(progressId)) {
    return res.status(400).json({ ok: false, message: 'Mã theo dõi tiến độ không hợp lệ.' });
  }

  const progress = pickingListExportProgress.get(progressId);
  if (!progress) return res.status(404).json({ ok: false, message: 'Không tìm thấy tiến độ xuất.' });
  return res.json({ ok: true, progress });
});

app.post('/api/pickinglist/export-outbound', async (req, res) => {
  const config = getMasterdataConfig(req);
  const pickingNo = String(req.body?.picking_no || '').trim();
  const jobno = String(req.body?.jobno || '').trim();
  const progressId = String(req.body?.progress_id || '').trim();
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const progressTotal = rows.filter(row => /^\d+$/.test(String(row?.id ?? '').trim()) && Number.isFinite(Number(row?.split_qty)) && Number(row.split_qty) > 0).length;
  if (!config.host || !config.user || !config.database || !pickingNo || !jobno || !rows.length || !/^[a-zA-Z0-9-]{16,100}$/.test(progressId)) {
    return res.status(400).json({ ok: false, message: 'Cần nhập Job No và chọn ít nhất một SKU để xuất outbound.' });
  }
  if (!progressTotal) return res.status(400).json({ ok: false, message: 'Không có SKU hợp lệ để xuất outbound.' });
  setPickingListExportProgress(progressId, {
    status: 'running',
    completed: 0,
    total: progressTotal,
    message: 'Đang chuẩn bị dữ liệu...'
  });

  let connection;
  try {
    connection = await getConnection(config);
    await ensureDetailPickingListTable(connection);
    await ensureReleasingTable(connection);
    await ensureInventoryTable(connection);
    await ensureOutboundTable(connection);
    await connection.beginTransaction();
    const [existingJobRows] = await connection.execute(
      'SELECT id FROM outbound WHERE TRIM(jobno) = ? LIMIT 1 FOR UPDATE',
      [jobno]
    );
    if (existingJobRows.length) {
      await connection.rollback();
      setPickingListExportProgress(progressId, {
        status: 'failed',
        completed: 0,
        total: progressTotal,
        message: `Job No ${jobno} đã tồn tại trong outbound.`
      });
      return res.status(409).json({
        ok: false,
        message: `Job No ${jobno} đã tồn tại trong outbound. Vui lòng chọn mã xx khác.`
      });
    }
    let exported = 0;

    for (const selectedRow of rows) {
      const id = String(selectedRow.id ?? '').trim();
      const carton = Number(selectedRow.split_qty);
      if (!/^\d+$/.test(id) || !Number.isFinite(carton) || carton <= 0) continue;
      const [[detail]] = await connection.execute('SELECT * FROM detail_pickinglist WHERE id = ? AND picking_no = ? FOR UPDATE', [id, pickingNo]);
      if (!detail) throw new Error('Không tìm thấy dòng Picking được chọn.');
      if (carton > Number(detail.carton_qty || 0)) throw new Error(`SKU ${detail.sku} có số lượng chọn lớn hơn carton của Picking.`);

      const [inventoryRows] = await connection.execute(`
        SELECT id, qty_inventory FROM inventory
        WHERE TRIM(parent_po_invent) = TRIM(?) AND TRIM(sku_inventory) = TRIM(?)
        ORDER BY date_rcv ASC, id ASC FOR UPDATE
      `, [detail.parentpo, detail.sku]);
      if (inventoryRows.reduce((total, row) => total + Number(row.qty_inventory || 0), 0) < carton) {
        throw new Error(`SKU ${detail.sku} không đủ tồn kho để xuất.`);
      }
      let remainingToDeduct = carton;
      for (const inventoryRow of inventoryRows) {
        if (remainingToDeduct <= 0) break;
        const deduction = Math.min(Number(inventoryRow.qty_inventory || 0), remainingToDeduct);
        if (deduction > 0) {
          await connection.execute('UPDATE inventory SET qty_inventory = qty_inventory - ?, date_update = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR) WHERE id = ?', [deduction, inventoryRow.id]);
          remainingToDeduct -= deduction;
        }
      }

      const [releaseRows] = await connection.execute(`
        SELECT id, release_qty FROM releasing
        WHERE TRIM(release_key) = TRIM(?) AND TRIM(sku) = TRIM(?)
          AND TRIM(COALESCE(status, '')) = '1'
        ORDER BY id FOR UPDATE
      `, [detail.release_key, detail.sku]);
      const availableReleaseQty = releaseRows.reduce((total, row) => total + Math.max(0, Number(row.release_qty || 0)), 0);
      if (!releaseRows.length) throw new Error(`Không tìm thấy releasing đang hoạt động cho Release Key ${detail.release_key}, SKU ${detail.sku}.`);
      if (carton > availableReleaseQty) throw new Error(`SKU ${detail.sku} có số lượng chọn lớn hơn release_qty.`);
      let releaseQtyToDeduct = carton;
      for (const releaseRow of releaseRows) {
        if (releaseQtyToDeduct <= 0) break;
        const rowReleaseQty = Math.max(0, Number(releaseRow.release_qty || 0));
        const deduction = Math.min(rowReleaseQty, releaseQtyToDeduct);
        if (deduction <= 0) continue;
        const remainingReleaseQty = Number((rowReleaseQty - deduction).toFixed(3));
        if (remainingReleaseQty === 0) {
          await connection.execute("UPDATE releasing SET release_qty = 0, status = '3' WHERE id = ?", [releaseRow.id]);
        } else {
          await connection.execute('UPDATE releasing SET release_qty = ? WHERE id = ?', [remainingReleaseQty, releaseRow.id]);
        }
        releaseQtyToDeduct = Number((releaseQtyToDeduct - deduction).toFixed(3));
      }

      const [[masterdata]] = await connection.execute('SELECT COALESCE(cbm, 0) AS cbm_per_sku FROM masterdata WHERE TRIM(sku) = TRIM(?) LIMIT 1', [detail.sku]);
      await connection.execute(`
        INSERT INTO outbound (jobno, rsl, parentpo, childpo, fdc, sku, carton, cbm, datercv)
        VALUES (?, ?, ?, ?, LEFT(TRIM(?), 3), ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR))
      `, [jobno, detail.release_key, detail.parentpo, detail.childpo, detail.childpo, detail.sku, carton, Number(masterdata?.cbm_per_sku || 0) * carton]);
      const [deleteResult] = await connection.execute('DELETE FROM detail_pickinglist WHERE id = ? AND picking_no = ?', [id, pickingNo]);
      if (deleteResult.affectedRows !== 1) throw new Error(`Không thể xóa dòng Picking ID ${id} sau khi xuất.`);
      exported += 1;
      setPickingListExportProgress(progressId, {
        status: 'running',
        completed: exported,
        total: progressTotal,
        message: `Đang xuất SKU ${exported}/${progressTotal}...`
      });
    }
    if (!exported) throw new Error('Không có dòng hợp lệ để xuất outbound.');
    await connection.commit();
    setPickingListExportProgress(progressId, {
      status: 'complete',
      completed: exported,
      total: progressTotal,
      message: 'Đã xuất xong.'
    });
    return res.json({ ok: true, exported, jobno });
  } catch (error) {
    if (connection) await connection.rollback();
    pickingListExportProgress.set(progressId, {
      status: 'failed',
      completed: 0,
      total: progressTotal,
      message: error.message || 'Không thể xuất outbound.'
    });
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xuất outbound.' });
  } finally {
    if (connection) await connection.end();
  }
});

async function ensureBbrreportTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS bbrreport (
      id INT AUTO_INCREMENT PRIMARY KEY,
      origin VARCHAR(50),
      supplier VARCHAR(150),
      parentpo VARCHAR(100),
      po VARCHAR(100),
      item VARCHAR(100),
      deliverydate DATE,
      qty DECIMAL(18,3) DEFAULT 0,
      cbm DECIMAL(18,6) DEFAULT 0,
      hub_DC VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_parentpo (parentpo),
      KEY idx_po_item (po, item)
    )
  `);
}

app.get('/api/bbrreport', async (req, res) => {
  const config = getBbrreportConfig(req);
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureBbrreportTable(connection);
    const [rows] = await connection.execute(`
          SELECT b.*, DATE_FORMAT(b.deliverydate, '%Y-%m-%d') AS deliverydate,
             n.Name_doc AS supplierName, m.kindpallet AS kindpallet, m.MANCC AS supplierCode, d.fdc AS fdc,
             EXISTS(SELECT 1 FROM inbound i WHERE i.po = b.parentpo) AS hasInbound,
             (b.qty * b.cbm) AS totalcbm
      FROM bbrreport b
      LEFT JOIN masterdata m ON m.sku = b.item
      LEFT JOIN nhacungcap n ON n.MANCC = m.MANCC
          LEFT JOIN dc d ON d.hub_dc = b.hub_DC
      ORDER BY b.deliverydate DESC, b.id DESC
    `);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải bbrreport.' });
  } finally { if (connection) await connection.end(); }
});

app.put('/api/bbrreport/deliverydate-by-parentpo', async (req, res) => {
  const config = getBbrreportConfig(req);
  const parentpo = String(req.body?.parentpo || '').trim();
  const deliverydate = String(req.body?.deliverydate || '').trim();
  if (!config.host || !config.user || !config.database || !parentpo || !/^\d{4}-\d{2}-\d{2}$/.test(deliverydate)) {
    return res.status(400).json({ ok: false, message: 'Thiếu kết nối, Parent PO hoặc ngày giao hàng không hợp lệ.' });
  }
  let connection;
  try {
    connection = await getConnection(config);
    await ensureBbrreportTable(connection);
    const [result] = await connection.execute('UPDATE bbrreport SET deliverydate = ? WHERE parentpo = ?', [deliverydate, parentpo]);
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể cập nhật deliverydate.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/bbrreport/import', async (req, res) => {
  const config = getBbrreportConfig(req);
  const inputRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!config.host || !config.user || !config.database || !inputRows.length) return res.status(400).json({ ok: false, message: 'Thiếu kết nối hoặc dữ liệu import.' });
  let connection;
  const result = { inserted: 0, updated: 0, rejected: [] };
  try {
    connection = await getConnection(config);
    await ensureBbrreportTable(connection);
    await connection.beginTransaction();
    for (let index = 0; index < inputRows.length; index += 1) {
      const row = inputRows[index] || {};
      const parentpo = String(row.parentpo || '').trim();
      const po = String(row.po || '').trim();
      const item = String(row.item || '').trim();
      const qty = Number(row.qty || 0);
      if (!parentpo || !po || !item || qty <= 0) { result.rejected.push({ row: index + 2, reason: 'Thiếu parentpo, po hoặc item hoặc qty không hợp lệ' }); continue; }
      const cbm = Number(row.cbm || 0);
      const deliverydate = row.deliverydate || null;
      const hubDc = String(row.hub_DC || row.hub_DC || '').trim();
      const [existing] = await connection.execute('SELECT id FROM bbrreport WHERE parentpo = ? AND po = ? AND item = ? LIMIT 1', [parentpo, po, item]);
      if (existing.length) {
        await connection.execute('UPDATE bbrreport SET deliverydate = ?, qty = ?, cbm = ?, hub_DC = ? WHERE id = ?', [deliverydate, qty, cbm, hubDc, existing[0].id]);
        result.updated += 1;
      } else {
        await connection.execute(
          'INSERT INTO bbrreport (origin, supplier, parentpo, po, item, deliverydate, qty, cbm, hub_DC) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [String(row.origin || '').trim(), String(row.supplier || '').trim(), parentpo, po, item, deliverydate, qty, cbm, hubDc]
        );
        result.inserted += 1;
      }
    }
    await connection.commit();
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (connection) await connection.rollback();
    return res.status(500).json({ ok: false, message: error.message || 'Không thể import bbrreport.', ...result });
  } finally { if (connection) await connection.end(); }
});

app.delete('/api/bbrreport/by-parentpo', async (req, res) => {
  const config = getBbrreportConfig(req);
  const parentpo = String(req.body?.parentpo || '').trim();
  if (!config.host || !config.user || !config.database || !parentpo) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối hoặc parentpo.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureBbrreportTable(connection);
    const [result] = await connection.execute('DELETE FROM bbrreport WHERE parentpo = ?', [parentpo]);
    return res.json({ ok: true, message: 'Đã xóa theo parentpo.', affectedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa theo parentpo.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/insert-inbound', async (req, res) => {
  const { connectionString, row } = req.body || {};
  const parsedConnection = parseConnectionString(connectionString);
  const finalConfig = parsedConnection || { host: req.body.host, port: req.body.port, user: req.body.user, password: req.body.password, database: req.body.database };

  if (!finalConfig.host || !finalConfig.user || !finalConfig.database || !row) {
    return res.status(400).json({
      ok: false,
      message: 'Thiếu thông tin kết nối hoặc dữ liệu phiếu nhập.'
    });
  }

  const payload = {
    MANCC: row.MANCC || row.supplier || '',
    po: row.po || row.parentPO || '',
    sku: row.sku || row.item || '',
    carton: Number(row.carton || row.qty || 0),
    contxe: row.contXe || row.contxe || '',
    datercv: row.datercv || row.receivedDate || row.date || getTodayGMT7(),
    cbm: Number(row.cbm || 0),
    labour: row.labour || '',
    PackinglistNo: row.packingListNo || row.PackinglistNo || ''
  };

  const sql = `
    INSERT INTO inbound (
      MANCC, po, sku, carton, contxe, datercv, cbm, labour, PackinglistNo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    payload.MANCC,
    payload.po,
    payload.sku,
    payload.carton,
    payload.contxe,
    payload.datercv,
    payload.cbm,
    payload.labour,
    payload.PackinglistNo
  ];

  let connection;

  try {
    connection = await getConnection(finalConfig);
    const [result] = await connection.execute(sql, params);

    return res.json({
      ok: true,
      message: 'Lưu phiếu vào bảng inbound thành công.',
      insertId: result && result.insertId
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Không thể lưu phiếu vào bảng inbound.'
    });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

app.put('/api/update-inbound/:id', async (req, res) => {
  const { connectionString, row } = req.body || {};
  const parsedConnection = parseConnectionString(connectionString);
  const finalConfig = parsedConnection || { host: req.body.host, port: req.body.port, user: req.body.user, password: req.body.password, database: req.body.database };
  const id = Number(req.params.id);

  if (!finalConfig.host || !finalConfig.user || !finalConfig.database || !row || !Number.isInteger(id)) {
    return res.status(400).json({
      ok: false,
      message: 'Thiếu thông tin kết nối, id hoặc dữ liệu phiếu nhập.'
    });
  }

  const params = [
    row.MANCC || row.supplier || '',
    row.po || row.parentPO || '',
    row.sku || row.item || '',
    Number(row.carton || row.qty || 0),
    row.contXe || row.contxe || '',
    row.datercv || row.receivedDate || row.date || getTodayGMT7(),
    Number(row.cbm || 0),
    row.labour || '',
    row.packingListNo || row.PackinglistNo || '',
    id
  ];

  const sql = `
    UPDATE inbound
    SET MANCC = ?, po = ?, sku = ?, carton = ?, contxe = ?, datercv = ?, cbm = ?, labour = ?, PackinglistNo = ?
    WHERE id = ?
  `;

  let connection;

  try {
    connection = await getConnection(finalConfig);
    const [result] = await connection.execute(sql, params);

    return res.json({
      ok: true,
      message: 'Cập nhật phiếu inbound thành công.',
      affectedRows: result.affectedRows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Không thể cập nhật phiếu inbound.'
    });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

app.delete('/api/inbound/:id', async (req, res) => {
  const { connectionString } = req.body || {};
  const parsedConnection = parseConnectionString(connectionString);
  const finalConfig = parsedConnection || { host: req.body.host, port: req.body.port, user: req.body.user, password: req.body.password, database: req.body.database };
  const id = Number(req.params.id);

  if (!finalConfig.host || !finalConfig.user || !finalConfig.database || !Number.isInteger(id)) {
    return res.status(400).json({
      ok: false,
      message: 'Thiếu thông tin kết nối hoặc id không hợp lệ.'
    });
  }

  let connection;

  try {
    connection = await getConnection(finalConfig);
    const [result] = await connection.execute('DELETE FROM inbound WHERE id = ?', [id]);

    return res.json({
      ok: true,
      message: 'Đã xóa dòng inbound.',
      affectedRows: result.affectedRows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Không thể xóa dòng inbound.'
    });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

async function ensureInboundLocationColumn(connection) {
  const [columns] = await connection.execute("SHOW COLUMNS FROM inbound LIKE 'location'");
  if (!columns.length) await connection.execute('ALTER TABLE inbound ADD COLUMN location VARCHAR(500) NULL');
}

app.get('/api/inbound/packing-lists', async (req, res) => {
  const config = getMasterdataConfig(req);
  const receivedDate = String(req.query?.receivedDate || '').trim();
  if (!config.host || !config.user || !config.database || !/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) return res.status(400).json({ ok: false, message: 'Cần chọn ngày nhập hợp lệ.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute('SELECT DISTINCT PackinglistNo FROM inbound WHERE datercv = ? AND PackinglistNo IS NOT NULL AND PackinglistNo <> \'\' ORDER BY PackinglistNo', [receivedDate]);
    return res.json({ ok: true, rows: rows.map((row) => row.PackinglistNo) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải Packing List.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/inbound/skus', async (req, res) => {
  const config = getMasterdataConfig(req);
  const packingListNo = String(req.query?.packingListNo || '').trim();
  if (!config.host || !config.user || !config.database || !packingListNo) return res.status(400).json({ ok: false, message: 'Cần chọn Packing List.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureInboundLocationColumn(connection);
    const [rows] = await connection.execute('SELECT id, sku, carton, cbm, location FROM inbound WHERE PackinglistNo = ? AND sku IS NOT NULL AND sku <> \'\' ORDER BY sku, id', [packingListNo]);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải SKU.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/locations', async (req, res) => {
  const config = getMasterdataConfig(req);
  const keyword = String(req.query?.keyword || '').trim();
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute('SELECT loc_id FROM location WHERE loc_id LIKE ? ORDER BY loc_id LIMIT 50', [`%${keyword}%`]);
    return res.json({ ok: true, rows: rows.map((row) => row.loc_id) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải danh sách location.' });
  } finally { if (connection) await connection.end(); }
});

app.put('/api/inbound/location', async (req, res) => {
  const config = getMasterdataConfig(req);
  const packingListNo = String(req.body?.packingListNo || '').trim().toUpperCase();
  const sku = String(req.body?.sku || '').trim();
  const location = String(req.body?.location || '').trim();
  if (!config.host || !config.user || !config.database || !packingListNo || !sku || !location) return res.status(400).json({ ok: false, message: 'Cần chọn Packing List, SKU và location.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureInboundLocationColumn(connection);
    const [rows] = await connection.execute('SELECT id, location FROM inbound WHERE PackinglistNo = ? AND sku = ?', [packingListNo, sku]);
    if (!rows.length) return res.status(404).json({ ok: false, message: 'Không tìm thấy inbound theo Packing List và SKU đã chọn.' });
    for (const row of rows) {
      const locations = String(row.location || '').split(',').map((value) => value.trim()).filter(Boolean);
      if (!locations.includes(location)) locations.push(location);
      await connection.execute('UPDATE inbound SET location = ? WHERE id = ?', [locations.join(','), row.id]);
    }
    return res.json({ ok: true, affectedRows: rows.length });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể cập nhật location.' });
  } finally { if (connection) await connection.end(); }
});

app.put('/api/inbound-by-packing-list', async (req, res) => {
  const { connectionString, packingListNo, contXe, labour, receivedDate } = req.body || {};
  const parsedConnection = parseConnectionString(connectionString);
  const finalConfig = parsedConnection || { host: req.body.host, port: req.body.port, user: req.body.user, password: req.body.password, database: req.body.database };
  const normalizedPackingListNo = String(packingListNo || '').trim();
  const normalizedDate = String(receivedDate || '').trim();

  if (!finalConfig.host || !finalConfig.user || !finalConfig.database || !normalizedPackingListNo || !normalizedDate) {
    return res.status(400).json({
      ok: false,
      message: 'Thiếu thông tin kết nối, Packing List No hoặc ngày nhập hàng.'
    });
  }

  let connection;

  try {
    connection = await getConnection(finalConfig);
    const [result] = await connection.execute(
      'UPDATE inbound SET contxe = ?, labour = ?, datercv = ? WHERE PackinglistNo = ?',
      [String(contXe || '').trim().toUpperCase(), String(labour || '').trim(), normalizedDate, normalizedPackingListNo]
    );

    return res.json({
      ok: true,
      message: 'Đã cập nhật thông tin Packing List.',
      affectedRows: result.affectedRows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Không thể cập nhật thông tin Packing List.'
    });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

app.delete('/api/inbound-by-packing-list', async (req, res) => {
  const { connectionString, packingListNo } = req.body || {};
  const parsedConnection = parseConnectionString(connectionString);
  const finalConfig = parsedConnection || { host: req.body.host, port: req.body.port, user: req.body.user, password: req.body.password, database: req.body.database };
  const normalizedPackingListNo = String(packingListNo || '').trim();

  if (!finalConfig.host || !finalConfig.user || !finalConfig.database || !normalizedPackingListNo) {
    return res.status(400).json({
      ok: false,
      message: 'Thiếu thông tin kết nối hoặc Packing List No.'
    });
  }

  let connection;

  try {
    connection = await getConnection(finalConfig);
    const [result] = await connection.execute('DELETE FROM inbound WHERE PackinglistNo = ?', [normalizedPackingListNo]);

    return res.json({
      ok: true,
      message: 'Đã xóa các dòng theo Packing List No.',
      affectedRows: result.affectedRows
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || 'Không thể xóa theo Packing List No.'
    });
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

async function ensureOutboundProductTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS outbound_product (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      jobno VARCHAR(100) NOT NULL,
      cont VARCHAR(255) NULL,
      date_stuff DATE NOT NULL,
      nhanvien VARCHAR(500) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_outbound_product_job_date (jobno, date_stuff),
      KEY idx_outbound_product_date (date_stuff),
      KEY idx_outbound_product_employee (nhanvien)
    )
  `);
}

app.get('/api/outbound-product/jobs', async (req, res) => {
  const config = getMasterdataConfig(req);
  const exportDate = String(req.query?.date || '').trim();
  if (!config.host || !config.user || !config.database || !/^\d{4}-\d{2}-\d{2}$/.test(exportDate)) return res.status(400).json({ ok: false, message: 'Cần chọn ngày xuất hợp lệ.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureOutboundProductTable(connection);
    const [rows] = await connection.execute(`
      SELECT
        TRIM(o.jobno) AS jobno,
        GROUP_CONCAT(DISTINCT NULLIF(TRIM(o.container), '') ORDER BY TRIM(o.container) SEPARATOR ', ') AS cont,
        COALESCE(
          MAX(NULLIF(TRIM(p.nhanvien), '')),
          GROUP_CONCAT(DISTINCT NULLIF(TRIM(s.userscan), '') ORDER BY TRIM(s.userscan) SEPARATOR ', ')
        ) AS nhanvien,
        MAX(p.id) IS NOT NULL AS saved
      FROM outbound o
      LEFT JOIN scanfile s ON TRIM(s.jobno) = TRIM(o.jobno)
      LEFT JOIN outbound_product p ON TRIM(p.jobno) = TRIM(o.jobno) AND p.date_stuff = ?
      WHERE DATE(o.datestuff) = ?
        AND NULLIF(TRIM(o.jobno), '') IS NOT NULL
      GROUP BY TRIM(o.jobno)
      ORDER BY TRIM(o.jobno)
    `, [exportDate, exportDate]);
    const [savedRows] = await connection.execute(`
      SELECT jobno, cont, DATE_FORMAT(date_stuff, '%d/%m/%Y') AS date_stuff, nhanvien
      FROM outbound_product
      WHERE date_stuff = ?
      ORDER BY jobno
    `, [exportDate]);
    return res.json({ ok: true, jobs: rows, records: savedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải Job No outbound.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/outbound-product', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.body?.jobno || '').trim();
  const cont = String(req.body?.cont || '').trim();
  const dateStuff = String(req.body?.date_stuff || '').trim();
  const nhanvien = String(req.body?.nhanvien || '').trim();
  if (!config.host || !config.user || !config.database || !jobno || !cont || !nhanvien || !/^\d{4}-\d{2}-\d{2}$/.test(dateStuff)) return res.status(400).json({ ok: false, message: 'Cần chọn ngày, Job No, container và nhân viên.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureOutboundProductTable(connection);
    const [result] = await connection.execute(`
      INSERT INTO outbound_product (jobno, cont, date_stuff, nhanvien)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE cont = VALUES(cont), nhanvien = VALUES(nhanvien)
    `, [jobno, cont, dateStuff, nhanvien]);
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể lưu outbound product.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/outbound-product/kpi', async (req, res) => {
  const config = getMasterdataConfig(req);
  const selectedDate = String(req.query?.date || '').trim();
  if (!config.host || !config.user || !config.database || !/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) return res.status(400).json({ ok: false, message: 'Cần chọn ngày hợp lệ.' });
  const monthStart = `${selectedDate.slice(0, 7)}-01`;
  const monthEnd = new Date(`${monthStart}T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  const endDate = monthEnd.toISOString().slice(0, 10);
  let connection;
  try {
    connection = await getConnection(config);
    await ensureOutboundProductTable(connection);
    const [rows] = await connection.execute(`
      SELECT TRIM(nhanvien) AS nhanvien, COUNT(*) AS total_jobs
      FROM outbound_product
      WHERE date_stuff BETWEEN ? AND ?
        AND NULLIF(TRIM(nhanvien), '') IS NOT NULL
      GROUP BY TRIM(nhanvien)
      ORDER BY total_jobs DESC, TRIM(nhanvien)
    `, [monthStart, endDate]);
    return res.json({ ok: true, monthStart, endDate, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải KPI nhân viên.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/outbound/summary', async (req, res) => {
  const config = getMasterdataConfig(req);
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
        const [rows] = await connection.execute(`
          SELECT jobno,
           EXISTS (
             SELECT 1
             FROM scanfile s
             WHERE TRIM(s.jobno) = TRIM(outbound.jobno)
           ) AS has_scanfile,
           DATE_FORMAT(DATE_ADD(datercv, INTERVAL 7 HOUR), '%Y-%m-%d') AS datercv, container, seal,
           DATE_FORMAT(datestuff, '%Y-%m-%d') AS datestuff, DATE_FORMAT(plan_date, '%Y-%m-%d') AS plan_date,
           GROUP_CONCAT(DISTINCT NULLIF(TRIM(fdc), '') ORDER BY TRIM(fdc) SEPARATOR ',') AS fdc,
           SUM(COALESCE(carton, 0)) AS totalcarton,
           SUM(COALESCE(cbm, 0)) AS totalcbm
          FROM outbound
          GROUP BY jobno, DATE_FORMAT(DATE_ADD(datercv, INTERVAL 7 HOUR), '%Y-%m-%d'), container, seal, datestuff, plan_date
          ORDER BY DATE_FORMAT(DATE_ADD(datercv, INTERVAL 7 HOUR), '%Y-%m-%d') DESC, jobno DESC, plan_date DESC
        `);
        const [fdcDetails] = await connection.execute(`
          SELECT RIGHT(TRIM(jobno_type), 3) AS fdc, pallet, COUNT(pallet_type) AS pallet_type_count
          FROM scanfile
          WHERE NULLIF(TRIM(jobno_type), '') IS NOT NULL
          GROUP BY RIGHT(TRIM(jobno_type), 3), pallet
          ORDER BY RIGHT(TRIM(jobno_type), 3), pallet
        `);
        const [fdcSummary] = await connection.execute(`
          SELECT
    RIGHT(TRIM(jobno_type), 3) AS fdc,
    TRIM(pallet_type) AS pallet_type,
    COUNT(DISTINCT pallet) AS pallet_count
          FROM scanfile
          WHERE pallet IS NOT NULL
            AND NULLIF(TRIM(jobno_type), '') IS NOT NULL
            AND NULLIF(TRIM(pallet_type), '') IS NOT NULL
            AND LOWER(TRIM(pallet_type)) <> 'loose'
          GROUP BY
              RIGHT(TRIM(jobno_type), 3),
              TRIM(pallet_type)
          ORDER BY
              RIGHT(TRIM(jobno_type), 3),
              TRIM(pallet_type);
        `);
        return res.json({ ok: true, rows, fdcDetails, fdcSummary });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải thống kê outbound.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/outbound/export-by-container', async (req, res) => {
  const config = getMasterdataConfig(req);
  const fromDate = String(req.query?.fromDate || '').trim();
  const toDate = String(req.query?.toDate || '').trim();
  if (!config.host || !config.user || !config.database || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) {
    return res.status(400).json({ ok: false, message: 'Vui lòng chọn khoảng ngày hợp lệ.' });
  }
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute(`
      SELECT
    DATE_FORMAT(o.datestuff, '%d/%m/%Y') AS datestuff,
    o.container,
    nv.nhanvien,
    o.totalcbm,
    o.totalcarton
  FROM (
    SELECT
      DATE(datestuff) AS datestuff,
      TRIM(container) AS container,
      SUM(COALESCE(cbm, 0)) AS totalcbm,
      SUM(COALESCE(carton, 0)) AS totalcarton
    FROM outbound
    WHERE DATE(datestuff) BETWEEN ? AND ?
      AND NULLIF(TRIM(container), '') IS NOT NULL
    GROUP BY
      DATE(datestuff),
      TRIM(container)
  ) AS o

  LEFT JOIN (
    SELECT
      TRIM(cont) AS container,
      GROUP_CONCAT(
        DISTINCT NULLIF(TRIM(nhanvien), '')
        ORDER BY TRIM(nhanvien)
        SEPARATOR ', '
      ) AS nhanvien
    FROM outbound_product
    WHERE NULLIF(TRIM(cont), '') IS NOT NULL
    GROUP BY TRIM(cont)
  ) AS nv
    ON nv.container = o.container

  ORDER BY
    o.datestuff,
    o.container
    `, [fromDate, toDate]);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xuất báo cáo container.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/outbound/export-chipboard', async (req, res) => {
  const config = getMasterdataConfig(req);
  const fromDate = String(req.query?.fromDate || '').trim();
  const toDate = String(req.query?.toDate || '').trim();
  if (!config.host || !config.user || !config.database || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) {
    return res.status(400).json({ ok: false, message: 'Vui lòng chọn khoảng ngày hợp lệ.' });
  }
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute(`
      SELECT
        TRIM(o.sku) AS sku,
        TRIM(m.chipboard) AS chipboard,
        SUM(COALESCE(o.cbm, 0)) AS totalcbm
      FROM outbound o
      INNER JOIN masterdata m ON TRIM(m.sku) = TRIM(o.sku)
      WHERE DATE(o.datestuff) BETWEEN ? AND ?
        AND CHAR_LENGTH(TRIM(COALESCE(m.chipboard, ''))) > 0
      GROUP BY TRIM(o.sku), TRIM(m.chipboard)
      ORDER BY TRIM(o.sku), TRIM(m.chipboard)
    `, [fromDate, toDate]);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xuất báo cáo chipboard.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/transactions/inbound-summary', async (req, res) => {
  const config = getMasterdataConfig(req);
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute(`
      SELECT
        TRIM(i.sku) AS sku,
        TRIM(i.po) AS parentpo,
        TRIM(i.PackinglistNo) AS packinglistno,
        DATE_FORMAT(DATE_ADD(i.datercv, INTERVAL 7 HOUR), '%Y-%m-%d') AS received_date,
        SUM(COALESCE(i.carton, 0)) AS total_carton
      FROM inbound i
      WHERE NULLIF(TRIM(i.sku), '') IS NOT NULL
        AND NULLIF(TRIM(i.po), '') IS NOT NULL
      GROUP BY
        TRIM(i.sku),
        TRIM(i.po),
        TRIM(i.PackinglistNo),
        DATE_FORMAT(DATE_ADD(i.datercv, INTERVAL 7 HOUR), '%Y-%m-%d')
      ORDER BY received_date DESC, TRIM(i.sku), TRIM(i.po)
    `);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải thống kê giao dịch inbound.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/transactions/outbound-details', async (req, res) => {
  const config = getMasterdataConfig(req);
  const sku = String(req.query?.sku || '').trim();
  const parentpo = String(req.query?.parentpo || '').trim();
  if (!config.host || !config.user || !config.database || !sku || !parentpo) return res.status(400).json({ ok: false, message: 'Cần chọn SKU và Parent PO.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute(`
      SELECT
        DATE_FORMAT(DATE_ADD(o.datestuff, INTERVAL 7 HOUR), '%Y-%m-%d') AS export_date,
        DATE_FORMAT(DATE_ADD(o.datercv, INTERVAL 7 HOUR), '%Y-%m-%d') AS datercv,
        TRIM(o.jobno) AS jobno,
        TRIM(o.childpo) AS childpo,
        TRIM(o.container) AS container,
        SUM(COALESCE(o.carton, 0)) AS total_carton
      FROM outbound o
      WHERE TRIM(o.sku) = ?
        AND TRIM(o.parentpo) = ?
      GROUP BY
        DATE_FORMAT(DATE_ADD(o.datestuff, INTERVAL 7 HOUR), '%Y-%m-%d'),
        DATE_FORMAT(DATE_ADD(o.datercv, INTERVAL 7 HOUR), '%Y-%m-%d'),
        TRIM(o.jobno),
        TRIM(o.childpo),
        TRIM(o.container)
      ORDER BY export_date DESC, jobno, childpo
    `, [sku, parentpo]);
    const totalCarton = rows.reduce((total, row) => total + Number(row.total_carton || 0), 0);
    const exportedCarton = rows.filter(row => String(row.container || '').trim().length > 0).reduce((total, row) => total + Number(row.total_carton || 0), 0);
    const remainingCarton = rows.filter(row => String(row.container || '').trim().length === 0).reduce((total, row) => total + Number(row.total_carton || 0), 0);
    return res.json({ ok: true, rows, totalCarton, exportedCarton, remainingCarton });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải chi tiết giao dịch outbound.' });
  } finally { if (connection) await connection.end(); }
});

app.delete('/api/transactions/inbound-sku', async (req, res) => {
  const config = getMasterdataConfig(req);
  const sku = String(req.body?.sku || '').trim();
  const parentpo = String(req.body?.parentpo || '').trim();
  if (!config.host || !config.user || !config.database || !sku || !parentpo) {
    return res.status(400).json({ ok: false, message: 'Cần chọn SKU và Parent PO hợp lệ.' });
  }
  let connection;
  try {
    connection = await getConnection(config);
    await ensureOutboundTable(connection);
    await connection.beginTransaction();
    const [inboundResult] = await connection.execute(
      'DELETE FROM inbound WHERE TRIM(sku) = TRIM(?) AND TRIM(po) = TRIM(?)',
      [sku, parentpo]
    );
    const [outboundResult] = await connection.execute(
      'DELETE FROM outbound WHERE TRIM(sku) = TRIM(?) AND TRIM(parentpo) = TRIM(?)',
      [sku, parentpo]
    );
    if (!inboundResult.affectedRows && !outboundResult.affectedRows) {
      await connection.rollback();
      return res.status(404).json({ ok: false, message: 'Không tìm thấy inbound hoặc outbound khớp Parent PO + SKU.' });
    }
    await connection.commit();
    return res.json({
      ok: true,
      deletedInbound: inboundResult.affectedRows,
      deletedOutbound: outboundResult.affectedRows
    });
  } catch (error) {
    if (connection) await connection.rollback();
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa inbound và outbound theo SKU.' });
  } finally {
    if (connection) await connection.end();
  }
});

async function ensureClpTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS importshipment (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      jobno VARCHAR(100) NOT NULL,
      jobno_shp VARCHAR(100) NULL,
      shipmentorder VARCHAR(100) NOT NULL,
      relese_key VARCHAR(150) NULL,
      ponumber VARCHAR(150) NULL,
      sku VARCHAR(150) NULL,
      finaldc VARCHAR(100) NULL,
      hubdc VARCHAR(100) NULL,
      systempallet VARCHAR(100) NULL,
      measurement VARCHAR(100) NULL,
      weight DECIMAL(18, 4) NULL,
      cbm_pallet DECIMAL(18, 4) NULL,
      carton DECIMAL(18, 4) NULL,
      palletnumber VARCHAR(100) NULL,
      cont VARCHAR(100) NULL,
      seal VARCHAR(100) NULL,
      cbm DECIMAL(18, 4) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_clp_jobno (jobno),
      INDEX idx_clp_shipmentorder (shipmentorder)
    )
  `);
}

app.get('/api/updateclp/jobs', async (req, res) => {
  const config = getMasterdataConfig(req);
  const exportDate = String(req.query?.date || '').trim();
  if (!config.host || !config.user || !config.database || !/^\d{4}-\d{2}-\d{2}$/.test(exportDate)) return res.status(400).json({ ok: false, message: 'Cần chọn ngày xuất hợp lệ.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute(`
      SELECT DISTINCT TRIM(jobno) AS jobno
      FROM outbound
      WHERE DATE(datestuff) = ?
        AND NULLIF(TRIM(container), '') IS NOT NULL
        AND CHAR_LENGTH(TRIM(container)) > 0
        AND NULLIF(TRIM(jobno), '') IS NOT NULL
      ORDER BY TRIM(jobno)
    `, [exportDate]);
    return res.json({ ok: true, jobs: rows.map((row) => row.jobno) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải danh sách Job No.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/updateclp/rows', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.query?.jobno || '').trim();
  const shipmentorder = String(req.query?.shipmentorder || '').trim();
  if (!config.host || !config.user || !config.database || !jobno) return res.status(400).json({ ok: false, message: 'Cần chọn Job No.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureClpTable(connection);
    const [rows] = await connection.execute(`
      SELECT i.jobno, i.jobno_shp, i.shipmentorder, i.relese_key, i.ponumber, i.sku, i.finaldc, i.hubdc,
             i.systempallet, i.measurement, i.weight, i.cbm_pallet, i.carton, i.palletnumber, i.cont, i.seal, i.cbm,
             COALESCE(scan.packer_name, '') AS packer_name
      FROM importshipment i
      LEFT JOIN (
        SELECT TRIM(jobno) AS jobno,
               GROUP_CONCAT(DISTINCT NULLIF(TRIM(userscan), '') ORDER BY TRIM(userscan) SEPARATOR ', ') AS packer_name
        FROM scanfile
        WHERE NULLIF(TRIM(jobno), '') IS NOT NULL
        GROUP BY TRIM(jobno)
      ) scan ON scan.jobno = TRIM(i.jobno_shp)
      WHERE TRIM(i.jobno_shp) = ?
        AND (? = '' OR TRIM(shipmentorder) = ?)
      ORDER BY i.id
    `, [jobno, shipmentorder, shipmentorder]);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải dữ liệu CLP.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/updateclp/shipment-orders', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.query?.jobno || '').trim();
  if (!config.host || !config.user || !config.database || !jobno) return res.status(400).json({ ok: false, message: 'Cần chọn Job No.' });
  const shipmentorder = String(req.query?.shipmentorder || '').trim();
  
  let connection;
  try {
    connection= await getConnection(config);
    await ensureClpTable(connection);
    const [rows] = await connection.execute(`
      SELECT i.*,
             COALESCE(scan.packer_name, '') AS packer_name
      FROM importshipment i
      LEFT JOIN (
        SELECT TRIM(jobno) AS jobno,
               GROUP_CONCAT(DISTINCT NULLIF(TRIM(userscan), '') ORDER BY TRIM(userscan) SEPARATOR ', ') AS packer_name
        FROM scanfile
        WHERE NULLIF(TRIM(jobno), '') IS NOT NULL
        GROUP BY TRIM(jobno)
      ) scan ON scan.jobno = TRIM(i.jobno_shp)
      WHERE TRIM(i.jobno_shp) = ?
      ORDER BY TRIM(i.shipmentorder)
    `, [jobno]);
    console.log(`jobno ${jobno}: ${rows.length} rows`);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải Shipment Order.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/updateclp/import', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno_shp = String(req.body?.jobno || '').trim();
  const shipmentorder = String(req.body?.shipmentorder || '').trim();
  const inputRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!config.host || !config.user || !config.database || !jobno_shp || !shipmentorder || !inputRows.length) return res.status(400).json({ ok: false, message: 'Thiếu Job No, Shipment Order hoặc dữ liệu import.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureClpTable(connection);

    const invalidImport = (message) => {
      const error = new Error(message);
      error.statusCode = 400;
      return error;
    };

    const [outboundRows] = await connection.execute(`
      SELECT DISTINCT
        TRIM(jobno) AS jobno_shp,
        NULLIF(TRIM(container), '') AS cont,
        NULLIF(TRIM(seal), '') AS seal
      FROM outbound
      WHERE TRIM(jobno) = ?
        AND NULLIF(TRIM(container), '') IS NOT NULL
      ORDER BY cont, seal
    `, [jobno_shp]);
    if (!outboundRows.length) {
      return res.status(400).json({ ok: false, message: `Không tìm thấy container trên outbound cho Job No ${jobno_shp}.` });
    }

    const resolveOutbound = (row) => {
      const rowContainer = String(row.cont ?? '').trim();
      if (rowContainer) {
        const match = outboundRows.find(item => String(item.cont ?? '').trim().toLowerCase() === rowContainer.toLowerCase());
        if (!match) throw invalidImport(`Container "${rowContainer}" trong Excel không khớp outbound của Job No ${jobno_shp}.`);
        return match;
      }
      if (outboundRows.length !== 1) {
        throw invalidImport(`Job No ${jobno_shp} có nhiều container trên outbound; cần có cột Container trong Excel để map chính xác.`);
      }
      return outboundRows[0];
    };

    const skuList = [...new Set(inputRows.map(row => String(row?.sku ?? '').trim()).filter(Boolean))];
    const masterdataBySku = new Map();
    if (skuList.length) {
      const [masterdataRows] = await connection.execute(`
        SELECT TRIM(sku) AS sku, MAX(COALESCE(cbm, 0)) AS cbm
        FROM masterdata
        WHERE TRIM(sku) IN (${skuList.map(() => '?').join(', ')})
        GROUP BY TRIM(sku)
      `, skuList);
      masterdataRows.forEach(row => masterdataBySku.set(String(row.sku).trim().toLowerCase(), Number(row.cbm || 0)));
    }

    const importedRows = inputRows.map((row) => {
      const excelJobno = String(row?.jobno ?? '').trim();
      if (!excelJobno) throw invalidImport('Có dòng Excel thiếu Job No.');
      const sku = String(row?.sku ?? '').trim();
      if (!sku) throw invalidImport('Có dòng Excel thiếu SKU nên không thể tính CBM.');
      const masterdataCbm = masterdataBySku.get(sku.toLowerCase());
      if (masterdataCbm === undefined) throw invalidImport(`Không tìm thấy SKU "${sku}" trong masterdata để tính CBM.`);

      const carton = row.carton === null || row.carton === undefined || String(row.carton).trim() === ''
        ? 0
        : Number(row.carton);
      if (!Number.isFinite(carton) || carton < 0) throw invalidImport(`Carton không hợp lệ cho SKU "${sku}".`);

      const outbound = resolveOutbound(row);
      return {
        ...row,
        jobno: excelJobno,
        jobno_shp,
        shipmentorder,
        cont: outbound.cont,
        seal: outbound.seal,
        cbm: Number((masterdataCbm * carton).toFixed(4))
      };
    });

    const [looseRows] = await connection.execute(`
      SELECT
        TRIM(s.jobno) AS jobno_shp,
        TRIM(s.sku) AS sku,
        COUNT(DISTINCT NULLIF(TRIM(s.sscc), '')) AS carton,
        m.cbm AS masterdata_cbm,
        ROUND(COUNT(DISTINCT NULLIF(TRIM(s.sscc), '')) * m.cbm, 4) AS cbm
      FROM scanfile s
      LEFT JOIN (
        SELECT TRIM(sku) AS sku, MAX(COALESCE(cbm, 0)) AS cbm
        FROM masterdata
        WHERE NULLIF(TRIM(sku), '') IS NOT NULL
        GROUP BY TRIM(sku)
      ) m ON LOWER(m.sku) = LOWER(TRIM(s.sku))
      WHERE TRIM(s.jobno) = ?
        AND LOWER(TRIM(COALESCE(s.pallet_type, ''))) = 'loose'
        AND NULLIF(TRIM(s.sku), '') IS NOT NULL
      GROUP BY TRIM(s.jobno), TRIM(s.sku), m.cbm
      HAVING COUNT(DISTINCT NULLIF(TRIM(s.sscc), '')) > 0
    `, [jobno_shp]);
    const looseImportRows = looseRows.map((row) => {
      if (row.masterdata_cbm === null || row.masterdata_cbm === undefined) {
        throw invalidImport(`Không tìm thấy SKU "${row.sku}" trong masterdata để tính CBM cho loose carton.`);
      }
      if (outboundRows.length !== 1) {
        throw invalidImport(`Job No ${jobno_shp} có nhiều container; không thể gán loose carton vào một container duy nhất.`);
      }
      const outbound = outboundRows[0];
      return {
        jobno: importedRows[0].jobno,
        jobno_shp,
        shipmentorder,
        sku: row.sku,
        carton: Number(row.carton || 0),
        cbm: Number(row.cbm || 0),
        cont: outbound.cont,
        seal: outbound.seal
      };
    });
    const rowsToInsert = [...importedRows, ...looseImportRows];

    await connection.beginTransaction();
    await connection.execute('DELETE FROM importshipment WHERE TRIM(jobno_shp) = ? AND TRIM(shipmentorder) = ?', [jobno_shp, shipmentorder]);
    const fields = ['jobno', 'jobno_shp', 'shipmentorder', 'relese_key', 'ponumber', 'sku', 'finaldc', 'hubdc', 'systempallet', 'measurement', 'weight', 'cbm_pallet', 'carton', 'palletnumber', 'cont', 'seal', 'cbm'];
    const placeholders = fields.map(() => '?').join(', ');
    let inserted = 0;
    for (const row of rowsToInsert) {
      const values = fields.map((field) => field === 'jobno_shp' ? jobno_shp : field === 'shipmentorder' ? shipmentorder : row[field] ?? null);
      await connection.execute(`INSERT INTO importshipment (${fields.join(', ')}) VALUES (${placeholders})`, values);
      inserted += 1;
    }
    await connection.commit();
    return res.json({ ok: true, inserted, imported: importedRows.length, loose: looseImportRows.length });
  } catch (error) {
    if (connection) await connection.rollback();
    return res.status(error.statusCode || 500).json({ ok: false, message: error.message || 'Không thể import dữ liệu CLP.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/updateclp/export-data', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.query?.jobno || '').trim();
  if (!config.host || !config.user || !config.database || !jobno) return res.status(400).json({ ok: false, message: 'Cần chọn Job No.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureClpTable(connection);
    const [rows] = await connection.execute(`
            SELECT i.jobno, i.jobno_shp, i.shipmentorder, i.relese_key, i.ponumber, i.sku,
              i.finaldc, i.hubdc, i.systempallet, i.measurement, i.weight,
              i.cbm_pallet, i.carton, i.palletnumber, i.cont, i.seal, i.cbm,
              (
           SELECT o.datestuff
           FROM outbound o
           WHERE TRIM(o.jobno) = TRIM(i.jobno_shp)
           ORDER BY o.id DESC
           LIMIT 1
              ) AS outbound_datestuff
      FROM importshipment i
      WHERE TRIM(i.jobno_shp) = ?
      ORDER BY i.id
    `, [jobno]);
    const detailJobno = rows[0]?.jobno_shp || jobno;
    const [detail] = await connection.execute(`
      SELECT TRIM(s.jobno_type) AS jobno_type, TRIM(s.sku) AS sku,
             COUNT(DISTINCT NULLIF(TRIM(s.sscc), '')) AS carton,
              COALESCE(m.length, 0) AS length,
              COALESCE(m.width, 0) AS width,
              ROUND(COUNT(DISTINCT NULLIF(TRIM(s.sscc), '')) * COALESCE(m.cbm, 0), 3) AS cbm
      FROM scanfile s
      LEFT JOIN masterdata m ON TRIM(m.sku) = TRIM(s.sku)
      WHERE TRIM(s.jobno) = ?
        AND LOWER(TRIM(COALESCE(s.pallet_type, ''))) = 'loose'
      GROUP BY TRIM(s.jobno_type), TRIM(s.sku), m.length, m.width, m.cbm
      HAVING COUNT(DISTINCT NULLIF(TRIM(s.sscc), '')) > 0
      ORDER BY TRIM(s.jobno_type), TRIM(s.sku)
    `, [detailJobno]);
    return res.json({ ok: true, rows, detail });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải dữ liệu export CLP.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/scan-update/summary', async (req, res) => {
  const config = getMasterdataConfig(req);
  const selectedJob = String(req.query?.jobno || '').trim();
  if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [jobRows] = await connection.execute(`
      SELECT DISTINCT TRIM(jobno) AS jobno
      FROM outbound
      WHERE NULLIF(TRIM(jobno), '') IS NOT NULL
        AND NULLIF(TRIM(container), '') IS NULL
      ORDER BY TRIM(jobno)
    `);
    const [rows] = await connection.execute(`
      SELECT
        TRIM(s.jobno_type) AS jobno_type,
        TRIM(s.jobno) AS jobno,
        TRIM(s.sku) AS sku,
        COUNT(DISTINCT NULLIF(TRIM(s.sscc), '')) AS total_sscc,
        COUNT(DISTINCT CASE WHEN NULLIF(TRIM(s.pallet), '') IS NOT NULL THEN TRIM(s.sscc) END) AS scanned_sscc
      FROM scanfile s
      INNER JOIN (
        SELECT DISTINCT TRIM(jobno) AS jobno
        FROM outbound
        WHERE NULLIF(TRIM(jobno), '') IS NOT NULL
          AND NULLIF(TRIM(container), '') IS NULL
      ) o ON o.jobno = TRIM(s.jobno)
      WHERE NULLIF(TRIM(s.jobno), '') IS NOT NULL
        AND (? = '' OR TRIM(s.jobno) = ?)
      GROUP BY TRIM(s.jobno_type), TRIM(s.sku), TRIM(s.jobno) 
      ORDER BY TRIM(s.jobno_type), TRIM(s.sku), TRIM(s.jobno)
    `, [selectedJob, selectedJob]);
    const [cartonRows] = await connection.execute(`
      SELECT COALESCE(SUM(carton), 0) AS total_carton
      FROM outbound
      WHERE NULLIF(TRIM(jobno), '') IS NOT NULL
        AND NULLIF(TRIM(container), '') IS NULL
        AND (? = '' OR TRIM(jobno) = ?)
    `, [selectedJob, selectedJob]);
    const [jobTypeRows] = await connection.execute(`
      SELECT TRIM(s.jobno_type) AS jobno_type,
             COUNT(DISTINCT NULLIF(TRIM(s.sscc), '')) AS total_sscc,
             COUNT(DISTINCT CASE WHEN NULLIF(TRIM(s.pallet), '') IS NOT NULL THEN TRIM(s.sscc) END) AS scanned_sscc
      FROM scanfile s
      INNER JOIN (
        SELECT DISTINCT TRIM(jobno) AS jobno
        FROM outbound
        WHERE NULLIF(TRIM(jobno), '') IS NOT NULL
          AND NULLIF(TRIM(container), '') IS NULL
      ) o ON o.jobno = TRIM(s.jobno)
      WHERE NULLIF(TRIM(s.jobno_type), '') IS NOT NULL
        AND (? = '' OR TRIM(s.jobno) = ?)
      GROUP BY TRIM(s.jobno_type)
      ORDER BY TRIM(s.jobno_type)
    `, [selectedJob, selectedJob]);
    const totalScannedSscc = rows.reduce((total, row) => total + Number(row.scanned_sscc || 0), 0);
    return res.json({ ok: true, jobs: jobRows.map((row) => row.jobno), rows, totalCarton: cartonRows[0]?.total_carton || 0, totalScannedSscc, ssccByJobType: jobTypeRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải dữ liệu scan.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/scan-update/import', async (req, res) => {
  const config = getMasterdataConfig(req);
  const inputRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!config.host || !config.user || !config.database || !inputRows.length) return res.status(400).json({ ok: false, message: 'Thiếu kết nối hoặc dữ liệu import.' });
  let connection;
  const result = { inserted: 0, rejected: [] };
  try {
    connection = await getConnection(config);
    await connection.beginTransaction();
    const [masterRows] = await connection.execute('SELECT sku, remark FROM masterdata');
    const remarkBySku = new Map(masterRows.map((row) => [String(row.sku || '').trim(), String(row.remark || '').trim()]));
    for (let index = 0; index < inputRows.length; index += 1) {
      const row = inputRows[index] || {};
      const jobno = String(row.jobno || '').trim();
      const masterDelivery = String(row.master_delivery || '').trim();
      const jobnoType = `${jobno}_${masterDelivery.slice(0, 3)}`;
      const releaseKey = String(row.release_key || '').trim();
      const sku = String(row.sku ?? '').trim();
      const sscc = String(row.sscc ?? row.SSCC ?? '').trim();
      const tagLabel = remarkBySku.has(sku) && remarkBySku.get(sku).length > 0 ? 'Y' : 'N';
      if (!jobno || !masterDelivery || !releaseKey || !sku || !sscc) {
        result.rejected.push({ row: index + 2, reason: 'Thiếu Job No, release_key, master_delivery, sku hoặc sscc' });
        continue;
      }
      await connection.execute(`
        INSERT INTO scanfile (
          release_key, sscc, master_delivery, qty, master_ctl, master_add1, master_add2,
          master_add3, master_add4,master_st_company, ship_to, st_zip, barcode, sku, jobno, jobno_type, tag_label
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        releaseKey,
        sscc,
        masterDelivery,
        row.qty ?? null,
        row.master_ctl ?? null,
        row.master_add1 ?? null,
        row.master_add2 ?? null,
        row.master_add3 ?? null,
        row.master_add4 ?? null,
        '',
        row.ship_to ?? null,
        row.st_zip ?? null,
        row.barcode ?? null,
        sku,
        jobno,
        jobnoType,
        tagLabel
      ]);
      result.inserted += 1;
    }
    await connection.commit();
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (connection) await connection.rollback();
    return res.status(500).json({ ok: false, message: error.message || 'Không thể import dữ liệu scan.', ...result });
  } finally { if (connection) await connection.end(); }
});

app.delete('/api/scan-update/row', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobnoType = String(req.body?.jobno_type || '').trim();
  const sku = String(req.body?.sku || '').trim();
  if (!config.host || !config.user || !config.database || !jobnoType || !sku) return res.status(400).json({ ok: false, message: 'Thiếu jobno_type hoặc SKU.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [result] = await connection.execute('DELETE FROM scanfile WHERE TRIM(jobno_type) = ? AND TRIM(sku) = ?', [jobnoType, sku]);
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa dữ liệu scan.' });
  } finally { if (connection) await connection.end(); }
});

app.delete('/api/scan-update/job', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.body?.jobno || '').trim();
  if (!config.host || !config.user || !config.database || !jobno) return res.status(400).json({ ok: false, message: 'Cần chọn Job No để xóa.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [result] = await connection.execute('DELETE FROM scanfile WHERE TRIM(jobno) = ?', [jobno]);
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa dữ liệu theo Job No.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/scan-update/pallets', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.query?.jobno || '').trim();
  const jobnoType = String(req.query?.jobno_type || '').trim();
  if (!config.host || !config.user || !config.database || !jobno || !jobnoType) return res.status(400).json({ ok: false, message: 'Cần chọn Job No và Job No type.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute(`
      SELECT DISTINCT TRIM(pallet) AS pallet
      FROM scanfile
      WHERE TRIM(jobno) = ?
        AND TRIM(jobno_type) = ?
        AND NULLIF(TRIM(pallet), '') IS NOT NULL
      ORDER BY TRIM(pallet)
    `, [jobno, jobnoType]);
    return res.json({ ok: true, pallets: rows.map((row) => row.pallet) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải danh sách pallet.' });
  } finally { if (connection) await connection.end(); }
});

app.patch('/api/scan-update/pallet/empty', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.body?.jobno || '').trim();
  const jobnoType = String(req.body?.jobno_type || '').trim();
  const pallet = String(req.body?.pallet || '').trim();
  if (!config.host || !config.user || !config.database || !jobno || !jobnoType || !pallet) return res.status(400).json({ ok: false, message: 'Cần chọn Job No, Job No type và pallet.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [result] = await connection.execute(`
      UPDATE scanfile
      SET pallet = '', pallet_type = 'empty', jobscan = 'empty'
      WHERE TRIM(jobno) = ?
        AND TRIM(jobno_type) = ?
        AND TRIM(pallet) = ?
    `, [jobno, jobnoType, pallet]);
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể làm rỗng pallet.' });
  } finally { if (connection) await connection.end(); }
});

app.delete('/api/scan-update/empty-pallets', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobnoType = String(req.body?.jobno_type || '').trim();
  if (!config.host || !config.user || !config.database || !jobnoType) return res.status(400).json({ ok: false, message: 'Cần chọn Job No type để xóa pallet rỗng.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [result] = await connection.execute(`
      DELETE FROM scanfile
      WHERE TRIM(jobno_type) = ?
        AND LOWER(COALESCE(TRIM(pallet), '')) IN ('', 'empty')
        AND LOWER(COALESCE(TRIM(pallet_type), '')) = 'empty'
        AND LOWER(COALESCE(TRIM(jobscan), '')) = 'empty'
    `, [jobnoType]);
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa pallet rỗng.' });
  } finally { if (connection) await connection.end(); }
});

function isValidIso6346Container(value) {
  const container = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{4}\d{7}$/.test(container) || !['U', 'J', 'Z'].includes(container[3])) return false;
  const letterValues = { A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20, K: 21, L: 23, M: 24, N: 25, O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31, U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38 };
  const sum = [...container.slice(0, 10)].reduce((total, character, index) => total + Number(character in letterValues ? letterValues[character] : character) * (2 ** index), 0);
  return (sum % 11) % 10 === Number(container[10]);
}

app.get('/api/outbound/picking-list', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.query?.jobno || '').trim();
  if (!config.host || !config.user || !config.database || !jobno) return res.status(400).json({ ok: false, message: 'Thiếu Job No hoặc thông tin kết nối database.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureInboundLocationColumn(connection);
    const [rows] = await connection.execute(`
      SELECT TRIM(o.fdc) AS fdc, o.parentpo, o.childpo, o.rsl, o.sku, o.carton, o.cbm,
             m.cbm AS cbmpersku, m.chipboard AS chip, m.weight AS weightpersku,
             (
               SELECT GROUP_CONCAT(DISTINCT NULLIF(TRIM(i.location), '') SEPARATOR ',')
               FROM inbound i
               WHERE TRIM(i.po) = TRIM(o.parentpo)
                 AND TRIM(i.sku) = TRIM(o.sku)
                 AND i.location IS NOT NULL AND TRIM(i.location) <> ''
             ) AS location
      FROM outbound o
      LEFT JOIN masterdata m ON m.sku = o.sku
      WHERE o.jobno = ?
      ORDER BY TRIM(o.fdc), o.parentpo, o.childpo, o.sku
    `, [jobno]);
    return res.json({ ok: true, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải picking list.' });
  } finally { if (connection) await connection.end(); }
});

app.delete('/api/outbound/job', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.body?.jobno || '').trim();
  if (!config.host || !config.user || !config.database || !jobno) return res.status(400).json({ ok: false, message: 'Cần chọn Job No cần xóa.' });
  let connection;
  try {
    connection = await getConnection(config);
    await ensureOutboundTable(connection);
    const [result] = await connection.execute('DELETE FROM outbound WHERE jobno = ?', [jobno]);
    if (!result.affectedRows) return res.status(404).json({ ok: false, message: 'Không tìm thấy Job No outbound.' });
    return res.json({ ok: true, deletedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa Job No outbound.' });
  } finally { if (connection) await connection.end(); }
});

app.put('/api/outbound/job', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.body?.jobno || '').trim();
  const newJobno = String(req.body?.newJobno || '').trim();
  const container = String(req.body?.container || '').trim().toUpperCase();
  const seal = String(req.body?.seal || '').trim();
  const datestuff = String(req.body?.datestuff || '').trim();
  const plan_date = String(req.body?.plan_date || '').trim();
  if (!config.host || !config.user || !config.database || !jobno || !newJobno) return res.status(400).json({ ok: false, message: 'Cần nhập Job No.' });
  if (container && !isValidIso6346Container(container)) return res.status(400).json({ ok: false, message: 'Số container không đúng chuẩn ISO 6346.' });
  if (datestuff && !/^\d{4}-\d{2}-\d{2}$/.test(datestuff)) return res.status(400).json({ ok: false, message: 'Ngày stuffing không hợp lệ.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [result] = await connection.execute('UPDATE outbound SET jobno = ?, container = ?, seal = ?, datestuff = ?, plan_date = ? WHERE jobno = ?', [newJobno, container, seal, datestuff || null, plan_date || null, jobno]);
    if (!result.affectedRows) return res.status(404).json({ ok: false, message: 'Không tìm thấy Job No.' });
    return res.json({ ok: true, affectedRows: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể cập nhật outbound.' });
  } finally { if (connection) await connection.end(); }
});
app.delete('/api/updateclp/delete-jobno-shp', async (req, res) => {
  let connection;

  try {
    const{connectionString, jobno_shp} = req.query;
    if(!connectionString) {
      return res.status(400).json({ ok: false, message: 'Cần nhập Connection String.' });
    }
    if(!jobno_shp) {
      return res.status(400).json({ ok: false, message: 'Thiếu Job No Shp.' });
    }
  connection = await mysql.createConnection(connectionString);
   // Kiểm tra JobNo SHP trước khi xóa
   const [checkRows] = await connection.execute(
    `SELECT DISTINCT jobno_shp FROM importshipment WHERE jobno_shp = ? AND TRIM(COALESCE(jobno_shp, '')) <> ''`,
    [jobno_shp]
  );
  if(!checkRows.length){
    return res.status(404).json({ ok: false, message: 'Không tìm thấy Job No Shp.' });
  }
  const jobnoShpList = checkRows.map(row => String(row.jobno_shp||'').trim())
                       .filter(Boolean);
  
  // Thực hiện xóa JobNo SHP
  const [deleteResult] = await connection.execute(
    `DELETE FROM importshipment WHERE jobno_shp = ?`,
    [jobno_shp]
  );
  return res.json({ ok: true,deleted:deleteResult.affectedRows,jobno_shp:jobnoShpList });
} catch (error) {
  return res.status(500).json({ ok: false, message: error.message || 'Không thể xóa Job No Shp.' });
} finally { if (connection) await connection.end(); }
});

app.get('/api/pallet/types', async (req, res) => {
  const config = getMasterdataConfig(req);
  let connection;
  try {
    if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
    connection = await getConnection(config);
    const [rows] = await connection.execute('SELECT id, pallet_size FROM pallet_type ORDER BY id');
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải loại pallet.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/pallet/in', async (req, res) => {
  const config = getMasterdataConfig(req);
  let connection;
  try {
    if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
    connection = await getConnection(config);
    const [rows] = await connection.execute("SELECT id, DATE_FORMAT(trans_date, '%Y-%m-%d') AS trans_date, pallet_type_id, quantity, ghichu FROM pallet_in ORDER BY trans_date DESC, id DESC");
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải lịch sử pallet nhập.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/pallet/out', async (req, res) => {
  const config = getMasterdataConfig(req);
  let connection;
  try {
    if (!config.host || !config.user || !config.database) return res.status(400).json({ ok: false, message: 'Thiếu thông tin kết nối database.' });
    connection = await getConnection(config);
    const [rows] = await connection.execute("SELECT id, DATE_FORMAT(trans_date, '%Y-%m-%d') AS trans_date, pallet_type_id, quantity, shipment FROM pallet_out ORDER BY trans_date DESC, id DESC");
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải lịch sử pallet xuất.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/pallet/in', async (req, res) => {
  const config = getMasterdataConfig(req);
  const transDate = String(req.body?.trans_date || '').trim();
  const palletTypeId = Number(req.body?.pallet_type_id);
  const quantity = Number(req.body?.quantity);
  const ghichu = String(req.body?.ghichu || '').trim() || null;
  if (!config.host || !config.user || !config.database || !/^\d{4}-\d{2}-\d{2}$/.test(transDate) || !palletTypeId || !Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ ok: false, message: 'Dữ liệu pallet nhập không hợp lệ.' });
  let connection;
  try {
    connection = await getConnection(config);
    await connection.execute('INSERT INTO pallet_in (trans_date, pallet_type_id, quantity, ghichu) VALUES (?, ?, ?, ?)', [transDate, palletTypeId, quantity, ghichu]);
    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể nhập pallet.' });
  } finally { if (connection) await connection.end(); }
});

app.post('/api/pallet/out', async (req, res) => {
  const config = getMasterdataConfig(req);
  const transDate = String(req.body?.trans_date || '').trim();
  const palletTypeId = Number(req.body?.pallet_type_id);
  const quantity = Number(req.body?.quantity);
  const shipment = String(req.body?.shipment || '').trim();
  if (!config.host || !config.user || !config.database || !/^\d{4}-\d{2}-\d{2}$/.test(transDate) || !palletTypeId || !Number.isInteger(quantity) || quantity <= 0 || !shipment) return res.status(400).json({ ok: false, message: 'Dữ liệu pallet xuất không hợp lệ.' });
  let connection;
  try {
    connection = await getConnection(config);
    const [balanceRows] = await connection.execute(`SELECT COALESCE((SELECT SUM(quantity) FROM pallet_in WHERE pallet_type_id = ?), 0) - COALESCE((SELECT SUM(quantity) FROM pallet_out WHERE pallet_type_id = ?), 0) AS balance`, [palletTypeId, palletTypeId]);
    if (quantity > Number(balanceRows[0]?.balance || 0)) return res.status(409).json({ ok: false, message: 'Số lượng xuất vượt quá số dư pallet hiện tại.' });
    await connection.execute('INSERT INTO pallet_out (trans_date, pallet_type_id, quantity, shipment) VALUES (?, ?, ?, ?)', [transDate, palletTypeId, quantity, shipment]);
    return res.status(201).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể xuất pallet.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/pallet/outbound-jobs', async (req, res) => {
  const config = getMasterdataConfig(req);
  const selectedDate = String(req.query?.date || '').trim();
  if (!config.host || !config.user || !config.database || !/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
    return res.status(400).json({ ok: false, message: 'Cần chọn ngày đóng hợp lệ.' });
  }
  let connection;
  try {
    connection = await getConnection(config);
    await ensureClpTable(connection);
    const [rows] = await connection.execute(`
      SELECT DISTINCT
        TRIM(o.jobno) AS jobno,
        (
          SELECT TRIM(i.shipmentorder)
          FROM importshipment i
          WHERE TRIM(i.jobno_shp) = TRIM(o.jobno)
            AND NULLIF(TRIM(i.shipmentorder), '') IS NOT NULL
          ORDER BY i.id
          LIMIT 1
        ) AS shipmentorder
      FROM outbound o
      WHERE DATE(o.datestuff) = ?
        AND NULLIF(TRIM(o.jobno), '') IS NOT NULL
      ORDER BY TRIM(o.jobno)
    `, [selectedDate]);
    return res.json({ ok: true, jobs: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể tải Job No theo ngày đóng.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/pallet/scan-quantity', async (req, res) => {
  const config = getMasterdataConfig(req);
  const jobno = String(req.query?.jobno || '').trim();
  const palletType = String(req.query?.pallet_type || '').trim();
  if (!config.host || !config.user || !config.database || !jobno || !['1.2', '1.6', '1.9'].includes(palletType)) {
    return res.status(400).json({ ok: false, message: 'Thiếu Job No hoặc loại pallet hợp lệ.' });
  }
  let connection;
  try {
    connection = await getConnection(config);
    const [rows] = await connection.execute(`
      SELECT COUNT(*) AS quantity
      FROM (
        SELECT TRIM(jobno_type), TRIM(pallet), COUNT(pallet_type) AS pallet_type_count
        FROM scanfile
        WHERE TRIM(jobno) = ?
          AND TRIM(pallet_type) = ?
          AND NULLIF(TRIM(pallet), '') IS NOT NULL
        GROUP BY TRIM(jobno_type), TRIM(pallet)
      ) AS pallet_groups
    `, [jobno, palletType]);
    return res.json({ ok: true, quantity: Number(rows[0]?.quantity || 0) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message || 'Không thể đếm pallet từ dữ liệu scan.' });
  } finally { if (connection) await connection.end(); }
});

app.get('/api/pallet/summary', async (req, res) => {
  const config = getMasterdataConfig(req);
  let connection;

  try {
   connection = await getConnection(config);
    await ensureInboundLocationColumn(connection);
    

    const [rows] = await connection.execute(`
      SELECT
        pt.id AS pallet_type_id,
        pt.pallet_size,

        COALESCE((
          SELECT SUM(pi.quantity)
          FROM pallet_in pi
          WHERE pi.pallet_type_id = pt.id
        ), 0) AS total_in,

        COALESCE((
          SELECT SUM(po.quantity)
          FROM pallet_out po
          WHERE po.pallet_type_id = pt.id
        ), 0) AS total_out

      FROM pallet_type pt
      ORDER BY pt.id
    `);

    let totalIn = 0;
    let totalOut = 0;

    const items = rows.map(row => {
      const totalInItem = Number(row.total_in || 0);
      const totalOutItem = Number(row.total_out || 0);
      const balance = totalInItem - totalOutItem;

      totalIn += totalInItem;
      totalOut += totalOutItem;

      return {
        pallet_type_id: Number(row.pallet_type_id),
        pallet_size: row.pallet_size,
        total_in: totalInItem,
        total_out: totalOutItem,
        balance
      };
    });

    res.json({
      ok: true,
      data: {
        items,
        total: {
          total_in: totalIn,
          total_out: totalOut,
          balance: totalIn - totalOut
        }
      }
    });

  } catch (error) {
    console.error('❌ /api/pallet/summary ERROR:', error, error);

    res.status(500).json({
      ok: false,
      message: 'Không thể lấy dữ liệu pallet summary.',
      error: error.message
    });

  } finally {
    if (connection) {
      await connection.end();
    }
  }
});
    

     
app.listen(PORT, () => {
  console.log(`MySQL connector API running on http://localhost:${PORT}`);
});
