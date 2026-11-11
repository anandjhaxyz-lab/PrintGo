-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "PrintJob_isTest_idx" ON "PrintJob"("isTest");
