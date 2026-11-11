-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "gatewayPaymentId" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentGroup" TEXT,
ADD COLUMN     "paymentMethod" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "action" TEXT NOT NULL DEFAULT 'PAYMENT_ATTEMPT',
ADD COLUMN     "amount" DOUBLE PRECISION,
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "gatewayPaymentId" TEXT,
ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "gatewayOrderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "signature" TEXT,
    "payload" TEXT NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "printJobId" TEXT,
    "gatewayRefundId" TEXT,
    "cfRefundId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "gatewayResponse" TEXT,
    "initiatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_eventId_key" ON "PaymentEvent"("eventId");

-- CreateIndex
CREATE INDEX "PaymentEvent_gatewayOrderId_idx" ON "PaymentEvent"("gatewayOrderId");

-- CreateIndex
CREATE INDEX "PaymentEvent_eventId_idx" ON "PaymentEvent"("eventId");

-- CreateIndex
CREATE INDEX "PaymentEvent_processed_idx" ON "PaymentEvent"("processed");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_gatewayRefundId_key" ON "Refund"("gatewayRefundId");

-- CreateIndex
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");

-- CreateIndex
CREATE INDEX "Refund_gatewayRefundId_idx" ON "Refund"("gatewayRefundId");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- CreateIndex
CREATE INDEX "Payment_gatewayPaymentId_idx" ON "Payment"("gatewayPaymentId");

-- CreateIndex
CREATE INDEX "Transaction_paymentId_idx" ON "Transaction"("paymentId");

-- CreateIndex
CREATE INDEX "Transaction_action_idx" ON "Transaction"("action");

-- CreateIndex
CREATE INDEX "Transaction_createdAt_idx" ON "Transaction"("createdAt");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;