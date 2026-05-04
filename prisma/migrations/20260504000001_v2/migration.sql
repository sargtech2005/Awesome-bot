-- V2 Migration
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isWhitelisted" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'chat';

CREATE TABLE IF NOT EXISTS "memories" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "memories_userId_key_key" ON "memories"("userId", "key");
CREATE INDEX IF NOT EXISTS "memories_userId_idx" ON "memories"("userId");
ALTER TABLE "memories" ADD CONSTRAINT "memories_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "projects" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "extractDir" TEXT NOT NULL,
    "originalZip" TEXT,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "sourceUrl" TEXT,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "projects_userId_idx" ON "projects"("userId");
ALTER TABLE "projects" ADD CONSTRAINT "projects_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "user_stats" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "totalZips" INTEGER NOT NULL DEFAULT 0,
    "totalEdits" INTEGER NOT NULL DEFAULT 0,
    "totalCodeGens" INTEGER NOT NULL DEFAULT 0,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_stats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_stats_userId_key" ON "user_stats"("userId");
ALTER TABLE "user_stats" ADD CONSTRAINT "user_stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "broadcast_logs" (
    "id" SERIAL NOT NULL,
    "message" TEXT NOT NULL,
    "sentTo" INTEGER NOT NULL,
    "sentBy" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "broadcast_logs_pkey" PRIMARY KEY ("id")
);
