-- WP-2H.1: Server-Issued Challenge Persistence for Installation Public-Key Enrollment
-- Creates the InstallationEnrollmentChallenge table to enforce atomic, single-use,
-- server-generated challenge-response replay resistance.

CREATE TABLE IF NOT EXISTS "InstallationEnrollmentChallenge" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'INSTALLATION_KEY_ENROLLMENT',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedByIp" TEXT,

    CONSTRAINT "InstallationEnrollmentChallenge_pkey" PRIMARY KEY ("id")
);

-- Unique constraint on challengeId
CREATE UNIQUE INDEX IF NOT EXISTS "InstallationEnrollmentChallenge_challengeId_key" ON "InstallationEnrollmentChallenge"("challengeId");

-- Query indexes
CREATE INDEX IF NOT EXISTS "InstallationEnrollmentChallenge_machineId_status_idx" ON "InstallationEnrollmentChallenge"("machineId", "status");
CREATE INDEX IF NOT EXISTS "InstallationEnrollmentChallenge_expiresAt_idx" ON "InstallationEnrollmentChallenge"("expiresAt");

-- Foreign key relation
ALTER TABLE "InstallationEnrollmentChallenge"
    ADD CONSTRAINT "InstallationEnrollmentChallenge_machineId_fkey"
    FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
