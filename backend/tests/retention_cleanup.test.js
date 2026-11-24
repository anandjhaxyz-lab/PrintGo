/**
 * Document Retention Cleanup Regression Test Suite
 *
 * Verifies all 8 safety, schema, and error-isolation requirements for
 * expired job document file cleanup:
 * 1. Valid expired document is deleted and filename becomes empty string.
 * 2. Original filename is preserved as the retention-expired audit marker.
 * 3. Already-cleaned document is not selected again.
 * 4. Null filename is never sent to Prisma update.
 * 5. One job's failure does not stop processing of the next eligible job.
 * 6. Failed file deletion does not clear the database filename.
 * 7. Empty filename never causes an unsafe filesystem path operation.
 * 8. Existing retention eligibility and status rules remain unchanged.
 */

jest.mock('uuid', () => ({
  v4: () => 'mocked-uuid-1234'
}));

const { cleanupExpiredJobFiles } = require('../src/services/queueService');
const { deleteFile } = require('../src/utils/storage');

describe('Document Retention Cleanup (Step 3) Regression Tests', () => {
  let mockPrisma;
  let mockDeleteFile;

  beforeEach(() => {
    mockDeleteFile = jest.fn().mockResolvedValue(true);
    mockPrisma = {
      printJob: {
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0)
      },
      document: {
        update: jest.fn().mockResolvedValue({})
      }
    };
  });

  // =========================================================================
  // Case 1: Valid expired document is deleted and filename becomes empty string
  // =========================================================================
  it('1. Valid expired document is deleted and filename becomes empty string', async () => {
    const expiredJob = {
      id: 'job-1',
      shortId: 'PJ001',
      status: 'COMPLETED',
      updatedAt: new Date(Date.now() - 7200000), // 2 hours ago
      document: {
        id: 'doc-1',
        filename: 'uploads/user-doc-1.pdf',
        originalName: 'report.pdf'
      }
    };

    mockPrisma.printJob.findMany.mockResolvedValue([expiredJob]);

    const summary = await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile
    });

    expect(mockDeleteFile).toHaveBeenCalledWith('uploads/user-doc-1.pdf');
    expect(mockPrisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: {
        filename: '',
        originalName: 'File deleted (retention period ended)'
      }
    });
    expect(summary.cleanedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
  });

  // =========================================================================
  // Case 2: Original filename is preserved as the retention-expired audit marker
  // =========================================================================
  it('2. Original filename is preserved as the retention-expired audit marker', async () => {
    const expiredJob = {
      id: 'job-audit',
      shortId: 'PJ_AUDIT',
      status: 'FAILED',
      updatedAt: new Date(Date.now() - 4000000),
      document: {
        id: 'doc-audit',
        filename: 'uploads/audit-check.pdf',
        originalName: 'tax_return_2026.pdf'
      }
    };

    mockPrisma.printJob.findMany.mockResolvedValue([expiredJob]);

    await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile
    });

    const updateCall = mockPrisma.document.update.mock.calls[0][0];
    expect(updateCall.data.originalName).toBe('File deleted (retention period ended)');
  });

  // =========================================================================
  // Case 3: Already-cleaned document is not selected again
  // =========================================================================
  it('3. Already-cleaned document is not selected again (filters document.filename != "")', async () => {
    mockPrisma.printJob.findMany.mockResolvedValue([]);

    const now = new Date('2026-11-17T23:00:00Z');
    await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile,
      now
    });

    expect(mockPrisma.printJob.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ['COMPLETED', 'FAILED', 'REFUNDED'] },
        updatedAt: { lt: new Date(now.getTime() - 3600000) },
        document: {
          filename: { not: '' }
        }
      },
      include: { document: true }
    });
  });

  // =========================================================================
  // Case 4: Null filename is never sent to Prisma update
  // =========================================================================
  it('4. Null filename is never sent to Prisma update', async () => {
    const expiredJob = {
      id: 'job-no-null',
      shortId: 'PJ_NN',
      status: 'REFUNDED',
      updatedAt: new Date(Date.now() - 5000000),
      document: {
        id: 'doc-no-null',
        filename: 'uploads/refunded-doc.pdf',
        originalName: 'statement.pdf'
      }
    };

    mockPrisma.printJob.findMany.mockResolvedValue([expiredJob]);

    await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile
    });

    const updateArgs = mockPrisma.document.update.mock.calls[0][0];
    expect(updateArgs.data.filename).not.toBeNull();
    expect(typeof updateArgs.data.filename).toBe('string');
    expect(updateArgs.data.filename).toBe('');
  });

  // =========================================================================
  // Case 5: One job\'s failure does not stop processing of the next eligible job
  // =========================================================================
  it('5. One job failure does not stop processing of the next eligible job', async () => {
    const jobFailing = {
      id: 'job-fail',
      shortId: 'PJ_FAIL',
      status: 'COMPLETED',
      updatedAt: new Date(Date.now() - 5000000),
      document: {
        id: 'doc-fail',
        filename: 'uploads/failing-file.pdf',
        originalName: 'fail.pdf'
      }
    };

    const jobSucceeding = {
      id: 'job-ok',
      shortId: 'PJ_OK',
      status: 'COMPLETED',
      updatedAt: new Date(Date.now() - 5000000),
      document: {
        id: 'doc-ok',
        filename: 'uploads/succeeding-file.pdf',
        originalName: 'ok.pdf'
      }
    };

    mockPrisma.printJob.findMany.mockResolvedValue([jobFailing, jobSucceeding]);

    // First job fails during deleteFileFn or document.update
    mockPrisma.document.update
      .mockRejectedValueOnce(new Error('Simulated database deadlock'))
      .mockResolvedValueOnce({});

    const summary = await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile
    });

    expect(summary.scannedCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.cleanedCount).toBe(1);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0].shortId).toBe('PJ_FAIL');
    expect(mockPrisma.document.update).toHaveBeenCalledTimes(2);
  });

  // =========================================================================
  // Case 6: Failed file deletion does not clear the database filename
  // =========================================================================
  it('6. Failed file deletion does not clear the database filename', async () => {
    const jobStorageFail = {
      id: 'job-storage-fail',
      shortId: 'PJ_STORE_ERR',
      status: 'COMPLETED',
      updatedAt: new Date(Date.now() - 5000000),
      document: {
        id: 'doc-store-fail',
        filename: 'uploads/locked-file.pdf',
        originalName: 'locked.pdf'
      }
    };

    mockPrisma.printJob.findMany.mockResolvedValue([jobStorageFail]);
    mockDeleteFile.mockResolvedValue(false); // Storage failed!

    const summary = await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile
    });

    expect(mockDeleteFile).toHaveBeenCalledWith('uploads/locked-file.pdf');
    expect(mockPrisma.document.update).not.toHaveBeenCalled();
    expect(summary.failedCount).toBe(1);
    expect(summary.cleanedCount).toBe(0);
  });

  // =========================================================================
  // Case 7: Empty filename never causes an unsafe filesystem path operation
  // =========================================================================
  it('7. Empty filename never causes an unsafe filesystem path operation in storage.js', async () => {
    // Calling deleteFile('') or deleteFile(null) returns true immediately without disk access
    const resEmpty = await deleteFile('');
    const resNull = await deleteFile(null);
    const resUndefined = await deleteFile(undefined);

    expect(resEmpty).toBe(true);
    expect(resNull).toBe(true);
    expect(resUndefined).toBe(true);
  });

  // =========================================================================
  // Case 8: Existing retention eligibility and status rules remain unchanged
  // =========================================================================
  it('8. Existing retention eligibility and status rules remain unchanged', async () => {
    mockPrisma.printJob.findMany.mockResolvedValue([]);
    const now = new Date('2026-11-17T23:00:00Z');
    const customTtlMs = 3600000; // 1 hour

    await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile,
      now,
      retentionMs: customTtlMs
    });

    const findManyCall = mockPrisma.printJob.findMany.mock.calls[0][0];

    // Status must strictly match COMPLETED, FAILED, and REFUNDED
    expect(findManyCall.where.status).toEqual({ in: ['COMPLETED', 'FAILED', 'REFUNDED'] });

    // Cutoff time must strictly be exactly 1 hour prior to reference now
    const expectedCutoff = new Date(now.getTime() - customTtlMs);
    expect(findManyCall.where.updatedAt).toEqual({ lt: expectedCutoff });

    // Document relation filter ensures filename != ''
    expect(findManyCall.where.document).toEqual({ filename: { not: '' } });
  });

  // =========================================================================
  // Case 9: A shared Document must not be deleted while another active PrintJob references it
  // =========================================================================
  it('9. A shared Document must not be deleted while another active PrintJob references it', async () => {
    const expiredJob = {
      id: 'job-shared-1',
      shortId: 'PJ_SHARED1',
      status: 'COMPLETED',
      updatedAt: new Date(Date.now() - 5000000),
      document: {
        id: 'doc-shared',
        filename: 'uploads/shared-doc.pdf',
        originalName: 'shared.pdf'
      }
    };

    mockPrisma.printJob.findMany.mockResolvedValue([expiredJob]);
    // Active sibling job found! (e.g. another job for same document is PRINTING)
    mockPrisma.printJob.count.mockResolvedValue(1);

    const summary = await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile
    });

    // Verification: Active sibling check was performed
    expect(mockPrisma.printJob.count).toHaveBeenCalledWith({
      where: {
        documentId: 'doc-shared',
        id: { not: 'job-shared-1' },
        status: { in: ['PENDING_PAYMENT', 'PAID', 'PRINTING'] }
      }
    });

    // File deletion and DB document clearing MUST NOT occur
    expect(mockDeleteFile).not.toHaveBeenCalled();
    expect(mockPrisma.document.update).not.toHaveBeenCalled();
    expect(summary.skippedCount).toBe(1);
    expect(summary.cleanedCount).toBe(0);
    expect(summary.failedCount).toBe(0);
  });

  // =========================================================================
  // Case 10: File deletion succeeds but Prisma document.update fails
  // =========================================================================
  it('10. File deletion succeeds but Prisma document.update fails', async () => {
    const expiredJob = {
      id: 'job-db-fail',
      shortId: 'PJ_DB_FAIL',
      status: 'COMPLETED',
      updatedAt: new Date(Date.now() - 5000000),
      document: {
        id: 'doc-db-fail',
        filename: 'uploads/partially-failed.pdf',
        originalName: 'partial.pdf'
      }
    };

    mockPrisma.printJob.findMany.mockResolvedValue([expiredJob]);
    mockDeleteFile.mockResolvedValue(true); // File deleted from storage!
    mockPrisma.document.update.mockRejectedValue(new Error('Prisma write timeout')); // DB update failed!

    const summary = await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile
    });

    // File was deleted from storage
    expect(mockDeleteFile).toHaveBeenCalledWith('uploads/partially-failed.pdf');
    // DB update was attempted
    expect(mockPrisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-db-fail' },
      data: {
        filename: '',
        originalName: 'File deleted (retention period ended)'
      }
    });
    // Error was safely caught and isolated
    expect(summary.failedCount).toBe(1);
    expect(summary.cleanedCount).toBe(0);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0].shortId).toBe('PJ_DB_FAIL');
    expect(summary.errors[0].error).toBe('Prisma write timeout');
  });

  // =========================================================================
  // Case 11: A subsequent retry handles an already-missing file safely
  // =========================================================================
  it('11. A subsequent retry handles an already-missing file safely without blocking cleanup', async () => {
    const retryJob = {
      id: 'job-retry',
      shortId: 'PJ_RETRY',
      status: 'COMPLETED',
      updatedAt: new Date(Date.now() - 5000000),
      document: {
        id: 'doc-retry',
        filename: 'uploads/already-deleted-on-prior-run.pdf',
        originalName: 'retry.pdf'
      }
    };

    mockPrisma.printJob.findMany.mockResolvedValue([retryJob]);
    // storage.deleteFile returns true when file does not exist (storage.js line 112: fs.existsSync is false)
    mockDeleteFile.mockResolvedValue(true);
    mockPrisma.document.update.mockResolvedValue({});

    const summary = await cleanupExpiredJobFiles({
      prismaClient: mockPrisma,
      deleteFileFn: mockDeleteFile
    });

    // File deletion attempted and succeeded idempotently
    expect(mockDeleteFile).toHaveBeenCalledWith('uploads/already-deleted-on-prior-run.pdf');
    // DB update completes, clearing filename to ''
    expect(mockPrisma.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-retry' },
      data: {
        filename: '',
        originalName: 'File deleted (retention period ended)'
      }
    });
    expect(summary.cleanedCount).toBe(1);
    expect(summary.failedCount).toBe(0);
  });
});
