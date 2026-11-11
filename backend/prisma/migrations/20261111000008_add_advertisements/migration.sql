-- CreateTable
CREATE TABLE "Advertisement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "mediaUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "displayDuration" INTEGER NOT NULL DEFAULT 5,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "fileSize" INTEGER,
    "mimeType" TEXT,
    "createdBy" TEXT,
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Advertisement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Advertisement_isActive_idx" ON "Advertisement"("isActive");

-- CreateIndex
CREATE INDEX "Advertisement_displayOrder_idx" ON "Advertisement"("displayOrder");

-- CreateIndex
CREATE INDEX "Advertisement_startDate_endDate_idx" ON "Advertisement"("startDate", "endDate");
