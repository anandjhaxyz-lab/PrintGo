-- Phase 1: User security, session invalidation, and account activation fields
ALTER TABLE "User"
    ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "passwordChangedAt" TIMESTAMP(3),
    ADD COLUMN "activationTokenHash" TEXT,
    ADD COLUMN "activationExpiresAt" TIMESTAMP(3);

-- Role and company filtering index for multi-tenant queries
CREATE INDEX "User_companyId_role_idx" ON "User"("companyId", "role");

-- Single-use activation lookup index
CREATE INDEX "User_activationTokenHash_idx" ON "User"("activationTokenHash");
