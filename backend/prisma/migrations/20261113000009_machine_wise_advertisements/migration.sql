-- CreateEnum
CREATE TYPE "AdSuppressionMode" AS ENUM ('ENABLED', 'PERMANENT', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "AdvertisementScope" AS ENUM ('GLOBAL', 'MACHINE_SPECIFIC');

-- CreateEnum
CREATE TYPE "AdvertisementPlacement" AS ENUM ('ALL', 'KIOSK_ONLY', 'MOBILE_ONLY');

-- AlterTable: Machine
ALTER TABLE "Machine" ADD COLUMN "adSuppressionMode" "AdSuppressionMode" NOT NULL DEFAULT 'ENABLED';
ALTER TABLE "Machine" ADD COLUMN "adSuppressionUntil" TIMESTAMP(3);
ALTER TABLE "Machine" ADD COLUMN "adSuppressionReason" TEXT;
ALTER TABLE "Machine" ADD COLUMN "adSuppressedBy" TEXT;
ALTER TABLE "Machine" ADD COLUMN "adSuppressedAt" TIMESTAMP(3);

-- AlterTable: Advertisement
ALTER TABLE "Advertisement" ADD COLUMN "scope" "AdvertisementScope" NOT NULL DEFAULT 'GLOBAL';
ALTER TABLE "Advertisement" ADD COLUMN "placement" "AdvertisementPlacement" NOT NULL DEFAULT 'ALL';
ALTER TABLE "Advertisement" ADD COLUMN "machineId" TEXT;

-- CreateIndex
CREATE INDEX "Machine_adSuppressionMode_adSuppressionUntil_idx" ON "Machine"("adSuppressionMode", "adSuppressionUntil");

-- CreateIndex
CREATE INDEX "Advertisement_scope_machineId_idx" ON "Advertisement"("scope", "machineId");

-- CreateIndex
CREATE INDEX "Advertisement_placement_idx" ON "Advertisement"("placement");

-- AddForeignKey
ALTER TABLE "Advertisement" ADD CONSTRAINT "Advertisement_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
