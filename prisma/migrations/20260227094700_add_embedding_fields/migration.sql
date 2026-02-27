ALTER TABLE "repository" ADD COLUMN IF NOT EXISTS "embeddingStatus" TEXT;
ALTER TABLE "repository" ADD COLUMN IF NOT EXISTS "embeddedAt" TIMESTAMP;
ALTER TABLE "repository" ADD COLUMN IF NOT EXISTS "embeddingError" TEXT;
