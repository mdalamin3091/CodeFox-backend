-- CreateTable
CREATE TABLE "repository" (
    "id" TEXT NOT NULL,
    "githubId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "description" TEXT,
    "htmlUrl" TEXT NOT NULL,
    "cloneUrl" TEXT NOT NULL,
    "sshUrl" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "fork" BOOLEAN NOT NULL DEFAULT false,
    "language" TEXT,
    "starCount" INTEGER NOT NULL DEFAULT 0,
    "forkCount" INTEGER NOT NULL DEFAULT 0,
    "openIssues" INTEGER NOT NULL DEFAULT 0,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "topics" TEXT[],
    "pushedAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repository_userId_idx" ON "repository"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "repository_userId_githubId_key" ON "repository"("userId", "githubId");

-- AddForeignKey
ALTER TABLE "repository" ADD CONSTRAINT "repository_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
