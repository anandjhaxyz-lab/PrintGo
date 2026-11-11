-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "retryEligible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "processedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReconciliationRecord" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT,
    "refundId" TEXT,
    "printJobId" TEXT,
    "status" TEXT NOT NULL,
    "discrepancyType" TEXT,
    "details" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Refund_idempotencyKey_idx" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditNote_refundId_idx" ON "CreditNote"("refundId");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_paymentId_idx" ON "ReconciliationRecord"("paymentId");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_refundId_idx" ON "ReconciliationRecord"("refundId");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_status_idx" ON "ReconciliationRecord"("status");

-- CreateIndex
CREATE INDEX "ReconciliationRecord_resolved_idx" ON "ReconciliationRecord"("resolved");

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRecord" ADD CONSTRAINT "ReconciliationRecord_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
