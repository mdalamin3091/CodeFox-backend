ALTER TABLE "pull_request" ALTER COLUMN "githubPrId" TYPE BIGINT;
DROP INDEX IF EXISTS "pull_request_repositoryId_githubPrId_key";
ALTER TABLE "pull_request" ADD CONSTRAINT "pull_request_repositoryId_number_key" UNIQUE ("repositoryId", "number");
