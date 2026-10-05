require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const cron = require("node-cron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
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

// ---------- PostgreSQL -> S3 backup ----------

function createDatabaseDump(outputFile) {
  return new Promise((resolve, reject) => {
    execFile(
      "pg_dump",
      [
        "--dbname",
        DATABASE_URL,
        "--format=custom",
        "--file",
        outputFile
      ],
      (error, stdout, stderr) => {
        if (error) {
          console.error("pg_dump stderr:", stderr);
          return reject(error);
        }

        resolve(outputFile);
      }
    );
  });
}

async function uploadBackupToS3(filePath) {
  const fileName = path.basename(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `neon-backups/${fileName}`,
      Body: fs.createReadStream(filePath),
      ContentType: "application/octet-stream"
    })
  );

  return `s3://${S3_BUCKET}/neon-backups/${fileName}`;
}

async function runBackup() {
  const backupDir = path.join(process.cwd(), "backups");

  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const backupFile = path.join(
    backupDir,
    `neondb-${timestamp}.dump`
  );

  try {
    console.log("Starting PostgreSQL backup...");

    await createDatabaseDump(backupFile);

    const s3Path = await uploadBackupToS3(backupFile);

    console.log(`Backup uploaded successfully: ${s3Path}`);

    fs.unlinkSync(backupFile);

    return s3Path;
  } catch (error) {
    console.error("Backup failed:", error);
    throw error;
  }
}

// Manual backup endpoint for testing.
app.post("/backup", async (req, res) => {
  try {
    const location = await runBackup();

    res.json({
      message: "Backup completed",
      location
    });
  } catch (error) {
    res.status(500).json({
      error: "Backup failed",
      message: error.message
    });
  }
});

// Every 24 hours at midnight according to the container's timezone.
cron.schedule(BACKUP_CRON, async () => {
  console.log("24-hour backup job triggered.");

  try {
    await runBackup();
  } catch (error) {
    console.error("Scheduled backup failed:", error);
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
