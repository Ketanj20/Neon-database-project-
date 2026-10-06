require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const cron = require("node-cron");


const {
  S3Client,
  PutObjectCommand
} = require("@aws-sdk/client-s3");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const S3_BUCKET = process.env.S3_BUCKET;
const AWS_REGION = process.env.AWS_REGION || "us-east-2";
const BACKUP_CRON = process.env.BACKUP_CRON || "0 0 * * *";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

if (!S3_BUCKET) {
  throw new Error("S3_BUCKET is required");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const s3 = new S3Client({
  region: AWS_REGION
});

// ---------- Database ----------

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("Neon database connected and table is ready.");
}

// ---------- Todo APIs ----------

app.get("/", (req, res) => {
  res.json({
    message: "Neon + S3 Todo API is running",
    endpoints: {
      create: "POST /todos",
      list: "GET /todos",
      update: "PATCH /todos/:id",
      delete: "DELETE /todos/:id",
      health: "GET /health",
      manualBackup: "POST /backup"
    }
  });
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      database: "connected",
      s3Bucket: S3_BUCKET
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.post("/todos", async (req, res) => {
  try {
    const { title } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const result = await pool.query(
      `INSERT INTO todos (title)
       VALUES ($1)
       RETURNING *`,
      [title.trim()]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to create todo" });
  }
});

app.get("/todos", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM todos ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch todos" });
  }
});

app.patch("/todos/:id", async (req, res) => {
  try {
    const { completed } = req.body;

    const result = await pool.query(
      `UPDATE todos
       SET completed = $1
       WHERE id = $2
       RETURNING *`,
      [Boolean(completed), req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Todo not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to update todo" });
  }
});

app.delete("/todos/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM todos WHERE id = $1 RETURNING *",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Todo not found" });
    }

    res.json({
      message: "Todo deleted",
      todo: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to delete todo" });
  }
});

// ---------- Neon PostgreSQL -> JSON -> S3 backup ----------

async function createJsonBackup() {
  const result = await pool.query(`
    SELECT *
    FROM todos
    ORDER BY id ASC
  `);

  const backup = {
    database: "neondb",
    table: "todos",
    backup_time: new Date().toISOString(),
    record_count: result.rows.length,
    records: result.rows
  };

  return JSON.stringify(backup, null, 2);
}

async function uploadJsonBackupToS3() {
  console.log("Starting JSON backup...");

  // Get all records from Neon
  const jsonBackup = await createJsonBackup();

  // Create filename
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const fileName = `todos-${timestamp}.json`;

  // Upload JSON directly to S3
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `neon-backups/${fileName}`,
      Body: jsonBackup,
      ContentType: "application/json"
    })
  );

  const s3Path = `s3://${S3_BUCKET}/neon-backups/${fileName}`;

  console.log(`JSON backup uploaded successfully: ${s3Path}`);

  return s3Path;
}

// Manual backup endpoint
app.post("/backup", async (req, res) => {
  try {
    const location = await uploadJsonBackupToS3();

    res.json({
      message: "JSON backup completed",
      location
    });
  } catch (error) {
    console.error("JSON backup failed:", error);

    res.status(500).json({
      error: "Backup failed",
      message: error.message
    });
  }
});

// ---------- 24-hour backup scheduler ----------

cron.schedule(BACKUP_CRON, async () => {
  console.log("24-hour JSON backup job triggered.");

  try {
    await uploadJsonBackupToS3();
  } catch (error) {
    console.error("Scheduled JSON backup failed:", error);
  }
});

async function start() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Backup schedule: ${BACKUP_CRON}`);
    });
  } catch (error) {
    console.error("Startup failed:", error);
    process.exit(1);
  }
}

start();
