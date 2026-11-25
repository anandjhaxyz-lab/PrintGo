-- WP-2H: Asymmetric Installation Identity Key Lifecycle & Enrollment
-- Non-destructive additive migration: Adds installation public-key enrollment fields to Machine table.
-- Existing machines retain NULL for all fields, ensuring legacy records are preserved and not automatically marked as enrolled.

ALTER TABLE "Machine"
    ADD COLUMN "activeInstallationId" TEXT,
    ADD COLUMN "installationPublicKey" TEXT,
    ADD COLUMN "installationKeyAlgorithm" TEXT,
    ADD COLUMN "installationKeyFormat" TEXT,
    ADD COLUMN "installationKeyFingerprint" TEXT,
    ADD COLUMN "installationEnrolledAt" TIMESTAMP(3),
    ADD COLUMN "installationKeyStatus" TEXT;

-- CreateIndex on activeInstallationId for installation lookup
CREATE INDEX IF NOT EXISTS "Machine_activeInstallationId_idx" ON "Machine"("activeInstallationId");
