import mysql from 'mysql2/promise';
import 'dotenv/config';

const dbName = (process.env.MYSQL_DATABASE || 'siteguard').replace(/[^a-zA-Z0-9_]/g, '');
const connection = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || ''
};

export const pool = mysql.createPool({ ...connection, database: dbName, waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4', dateStrings: false, timezone: 'Z' });
// Store and read every time in UTC. Without this, columns MySQL fills itself (created_at)
// use the server's local zone (e.g. IST) and come back hours off.
pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

const TABLES = [
  `CREATE TABLE IF NOT EXISTS sites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(160) NOT NULL,
    url VARCHAR(500) NOT NULL,
    client_name VARCHAR(160) NULL,
    client_email VARCHAR(255) NULL,
    client_whatsapp VARCHAR(32) NULL,
    alert_client TINYINT(1) NOT NULL DEFAULT 0,
    paused TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'unknown',
    consecutive_failures INT NOT NULL DEFAULT 0,
    last_checked_at DATETIME NULL,
    last_status_code INT NULL,
    last_response_ms INT NULL,
    last_error VARCHAR(500) NULL,
    ssl_expires_at DATETIME NULL,
    ssl_issuer VARCHAR(255) NULL,
    ssl_checked_at DATETIME NULL,
    domain_expires_at DATETIME NULL,
    domain_checked_at DATETIME NULL,
    last_scan_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS checks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    site_id INT NOT NULL,
    checked_at DATETIME NOT NULL,
    ok TINYINT(1) NOT NULL,
    status_code INT NULL,
    response_ms INT NULL,
    error VARCHAR(500) NULL,
    INDEX (site_id, checked_at),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS incidents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    site_id INT NOT NULL,
    started_at DATETIME NOT NULL,
    resolved_at DATETIME NULL,
    cause VARCHAR(500) NULL,
    INDEX (site_id, started_at),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS alerts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    site_id INT NULL,
    kind VARCHAR(40) NOT NULL,
    dedupe_key VARCHAR(191) NULL UNIQUE,
    subject VARCHAR(300) NOT NULL,
    message TEXT NOT NULL,
    channels VARCHAR(200) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX (site_id, created_at),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS scans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    site_id INT NOT NULL,
    started_at DATETIME NOT NULL,
    finished_at DATETIME NULL,
    pages_checked INT DEFAULT 0,
    links_checked INT DEFAULT 0,
    issue_count INT DEFAULT 0,
    ai_used TINYINT(1) DEFAULT 0,
    summary TEXT NULL,
    error VARCHAR(500) NULL,
    INDEX (site_id, started_at),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS scan_issues (
    id INT AUTO_INCREMENT PRIMARY KEY,
    scan_id INT NOT NULL,
    site_id INT NOT NULL,
    type VARCHAR(40) NOT NULL,
    severity VARCHAR(16) NOT NULL DEFAULT 'medium',
    page_url VARCHAR(1000) NOT NULL,
    detail TEXT NOT NULL,
    evidence VARCHAR(1000) NULL,
    INDEX (site_id),
    FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  )`,
  // App settings edited on the Settings page (branding, alert contacts).
  `CREATE TABLE IF NOT EXISTS settings (
    name VARCHAR(64) PRIMARY KEY,
    value TEXT NULL
  )`,
  // Issues the team marked "fixed" or "ignored", remembered across daily scans by fingerprint.
  `CREATE TABLE IF NOT EXISTS issue_status (
    site_id INT NOT NULL,
    fingerprint VARCHAR(191) NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (site_id, fingerprint),
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  )`
];

async function addColumns(table, columns) {
  const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
  const have = new Set(cols.map((c) => c.Field));
  for (const [name, type] of Object.entries(columns)) {
    if (!have.has(name)) await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${type}`);
  }
}

export async function initializeDatabase() {
  const conn = await mysql.createConnection(connection);
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();
  // Some MySQL installs (e.g. XAMPP, MySQL 5.7) default to MyISAM, which ignores foreign keys and
  // transactions. Force InnoDB on create, and convert tables created earlier.
  for (const sql of TABLES) await pool.query(`${sql} ENGINE=InnoDB`);
  const [engines] = await pool.query("SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  for (const name of ['sites', 'checks', 'incidents', 'alerts', 'scans', 'scan_issues', 'settings', 'issue_status']) {
    if (engines.find((t) => t.name === name)?.engine !== 'InnoDB') await pool.query(`ALTER TABLE \`${name}\` ENGINE=InnoDB`);
  }
  await removeOrphans();
  await addColumns('scans', { progress: 'VARCHAR(200) NULL' });
  await addColumns('scan_issues', { fingerprint: 'VARCHAR(191) NULL', is_new: 'TINYINT(1) NOT NULL DEFAULT 0', link_text: 'VARCHAR(300) NULL', location: 'VARCHAR(300) NULL', found_on: 'TEXT NULL' });
  await addColumns('sites', {
    backup_token: 'VARCHAR(64) NULL',
    backup_expected_hours: 'INT NULL',
    backup_since: 'DATETIME NULL',
    last_backup_at: 'DATETIME NULL',
    last_backup_status: 'VARCHAR(16) NULL',
    last_backup_message: 'VARCHAR(500) NULL'
  });
  // A server restart mid-scan leaves it "running" forever; close those out.
  await pool.query("UPDATE scans SET finished_at = UTC_TIMESTAMP(), error = 'Stopped: the server restarted during the scan. Run it again.' WHERE finished_at IS NULL");
}

// Rows whose site was deleted (left behind where foreign keys were not enforced).
export async function removeOrphans() {
  for (const table of ['checks', 'incidents', 'alerts', 'scan_issues', 'scans', 'issue_status']) {
    await pool.query(`DELETE t FROM \`${table}\` t LEFT JOIN sites s ON s.id = t.site_id WHERE t.site_id IS NOT NULL AND s.id IS NULL`);
  }
}

/** Delete a site and everything recorded for it (does not rely on foreign keys). */
export async function deleteSite(id) {
  for (const table of ['scan_issues', 'scans', 'checks', 'incidents', 'alerts', 'issue_status']) await pool.query(`DELETE FROM \`${table}\` WHERE site_id = ?`, [id]);
  await pool.query('DELETE FROM sites WHERE id = ?', [id]);
}

// Store and read all DATETIMEs as UTC.
export const toSql = (date) => (date ? new Date(date).toISOString().slice(0, 19).replace('T', ' ') : null);
