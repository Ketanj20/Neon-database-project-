# Neon + S3 Todo Backup Demo

A very small Node.js application for learning:

- Node.js + Express
- Neon PostgreSQL
- AWS S3
- Docker
- EC2
- PostgreSQL `pg_dump`
- Daily automated database backups

## Architecture

Client
  |
  v
Node.js / Express
  |
  +----> Neon PostgreSQL
  |       `todos` table
  |
  +----> pg_dump
          |
          v
       AWS S3
       neon-backups/*.dump

The application stores todo records in Neon.

Every 24 hours, the application runs `pg_dump` against Neon and uploads the dump file to S3.

## 1. Create the project

```bash
npm install
```

Copy `.env.example` to `.env` and add your values.

Never commit `.env`.

## 2. Neon

Create a Neon PostgreSQL database.

Set:

```env
DATABASE_URL=your-neon-connection-string
```

The application automatically creates:

```text
todos
-----
id
title
completed
created_at
```

## 3. S3

Create an S3 bucket.

Example:

```env
AWS_REGION=us-east-2
S3_BUCKET=my-neon-backup-bucket
```

For local development, AWS SDK credentials can come from your AWS CLI configuration or environment variables.

For EC2, preferably use an IAM Instance Role instead of hardcoding AWS access keys.

## 4. Run locally

```bash
npm install
npm start
```

Test:

```bash
curl http://localhost:3000/health
```

Create a todo:

```bash
curl -X POST http://localhost:3000/todos \
  -H "Content-Type: application/json" \
  -d '{"title":"Learn Neon PostgreSQL"}'
```

List todos:

```bash
curl http://localhost:3000/todos
```

Test a backup manually:

```bash
curl -X POST http://localhost:3000/backup
```

Then check your S3 bucket:

```text
neon-backups/
  neondb-2026-....dump
```

## 5. Build Docker image

```bash
docker build -t yourdockerhubusername/neon-s3-todo:1.0 .
```

Test:

```bash
docker run --rm \
  -p 3000:3000 \
  --env-file .env \
  yourdockerhubusername/neon-s3-todo:1.0
```

## 6. Push to Docker Hub

Login:

```bash
docker login
```

Push:

```bash
docker push yourdockerhubusername/neon-s3-todo:1.0
```

## 7. EC2

Install Docker on the EC2 instance.

Pull:

```bash
docker pull yourdockerhubusername/neon-s3-todo:1.0
```

Run:

```bash
docker run -d \
  --name neon-s3-todo \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  yourdockerhubusername/neon-s3-todo:1.0
```

Check:

```bash
docker logs -f neon-s3-todo
```

## 8. Recommended EC2 IAM permissions

Attach an IAM role to the EC2 instance.

Give the role only the S3 permissions needed for the backup bucket.

Conceptually:

```text
s3:PutObject
s3:GetObject
s3:ListBucket
```

Prefer restricting them to your specific backup bucket/prefix.

Then you do not need AWS access keys inside `.env`.

## 9. Important backup behavior

The application does NOT put PostgreSQL rows directly into S3.

Instead:

1. Todo is inserted into Neon.
2. Neon stores the record in PostgreSQL.
3. Every 24 hours, `pg_dump` creates a PostgreSQL backup.
4. The `.dump` file is uploaded to S3.
5. The temporary local dump is deleted.

This gives you:

```text
Application
    |
    v
Neon PostgreSQL
    |
    | pg_dump every 24h
    v
S3 backup
```

## 10. GitHub

Before pushing:

```bash
git init
git add .
git commit -m "Initial Neon S3 todo app"
```

Make sure `.env` is NOT included.

Then push your repository to GitHub.

## Important

The database connection string contains a password/credential. If you have already exposed a real Neon password publicly, rotate/reset that Neon credential before using the repository or Docker image.
