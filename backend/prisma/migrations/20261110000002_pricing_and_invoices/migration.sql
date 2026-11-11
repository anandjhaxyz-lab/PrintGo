-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "paperSize" TEXT NOT NULL DEFAULT 'A4',
ADD COLUMN     "paperType" TEXT NOT NULL DEFAULT 'plain',
ADD COLUMN     "pricingSnapshot" TEXT;

-- CreateTable
CREATE TABLE "PrintPricingProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Standard Kiosk Pricing',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "machineId" TEXT,
    "companyId" TEXT,
    "bwSingleRate" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "bwDuplexRate" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "colorSingleRate" DOUBLE PRECISION NOT NULL DEFAULT 10.0,
    "colorDuplexRate" DOUBLE PRECISION NOT NULL DEFAULT 18.0,
    "a4Multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "a3Multiplier" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "legalMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.2,
    "glossySurcharge" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "minOrderAmount" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "convenienceFee" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "gstEnabled" BOOLEAN NOT NULL DEFAULT false,
    "gstRatePercent" DOUBLE PRECISION NOT NULL DEFAULT 18.0,
    "isTaxInclusive" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintPricingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "legalName" TEXT NOT NULL DEFAULT 'PrintGo Self-Service Kiosks',
    "tradeName" TEXT DEFAULT 'PrintGo',
    "gstin" TEXT,
    "panNumber" TEXT,
    "sacCode" TEXT NOT NULL DEFAULT '9989',
    "supportEmail" TEXT DEFAULT 'support@printgo.local',
    "supportPhone" TEXT DEFAULT '+91 9999999999',
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT DEFAULT 'Hyderabad',
    "state" TEXT DEFAULT 'Telangana',
    "stateCode" TEXT DEFAULT '36',
    "pincode" TEXT,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV-PG-',
    "nextInvoiceNumber" INTEGER NOT NULL DEFAULT 1001,
    "termsAndConditions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "printJobId" TEXT NOT NULL,
    "paymentId" TEXT,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "taxableAmount" DOUBLE PRECISION NOT NULL,
    "cgstRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "cgstAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "sgstRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "sgstAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "igstRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "igstAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "totalTax" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "convenienceFee" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "sellerName" TEXT NOT NULL,
    "sellerGstin" TEXT,
    "sellerState" TEXT,
    "buyerName" TEXT,
    "buyerPhone" TEXT,
    "buyerEmail" TEXT,
    "sacCode" TEXT NOT NULL DEFAULT '9989',
    "pricingSnapshot" TEXT NOT NULL,
    "lineItems" TEXT NOT NULL,
    "pdfPath" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrintPricingProfile_machineId_key" ON "PrintPricingProfile"("machineId");

-- CreateIndex
CREATE INDEX "PrintPricingProfile_companyId_idx" ON "PrintPricingProfile"("companyId");

-- CreateIndex
CREATE INDEX "PrintPricingProfile_isDefault_idx" ON "PrintPricingProfile"("isDefault");

-- CreateIndex
CREATE INDEX "PrintPricingProfile_isActive_idx" ON "PrintPricingProfile"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_companyId_key" ON "BusinessProfile"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_printJobId_key" ON "Invoice"("printJobId");

-- CreateIndex
CREATE INDEX "Invoice_invoiceNumber_idx" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE INDEX "Invoice_issuedAt_idx" ON "Invoice"("issuedAt");

-- AddForeignKey
ALTER TABLE "PrintPricingProfile" ADD CONSTRAINT "PrintPricingProfile_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintPricingProfile" ADD CONSTRAINT "PrintPricingProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_printJobId_fkey" FOREIGN KEY ("printJobId") REFERENCES "PrintJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
