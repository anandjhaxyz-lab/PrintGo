/**
 * S3K PrintGo — Phase 1C: Queue Cleanup Safety Test Suite
 * Strictly isolated to printgo_disposable_target on port 5433.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const crypto = require('crypto');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured for disposable target testing.');
}

const parsedDb = new URL(process.env.DATABASE_URL);
if (parsedDb.pathname !== '/printgo_disposable_target' || String(parsedDb.port || 5433) !== '5433') {
  throw new Error(`SAFETY ABORT: Expected printgo_disposable_target on 5433, got ${parsedDb.pathname}:${parsedDb.port}`);
}

const tempUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3k-phase1c-cleanup-'));
process.env.UPLOADS_DIR = tempUploadDir;

const prisma = require('../src/utils/prisma');
const { deleteFile } = require('../src/utils/storage');
const { cleanupAbandonedJobs } = require('../src/services/queueService');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}\n   ${err.stack || err.message}`);
    failed++;
  }
}

function makeShortId(prefix) {
  return `${prefix}${crypto.randomBytes(3).toString('hex')}`.slice(0, 8);
}

async function createDocAndFile(tag, createdResources) {
  const filename = `phase1c_${tag}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.pdf`;
  const fullPath = path.join(tempUploadDir, filename);
  fs.writeFileSync(fullPath, '%PDF-1.4\n% Phase 1C safety fixture\n');
  createdResources.files.push(fullPath);

  const doc = await prisma.document.create({
    data: {
      originalName: `fixture_${tag}.pdf`,
      filename,
      mimetype: 'application/pdf',
      size: 64,
      pages: 1
    }
  });
  createdResources.docIds.push(doc.id);
  return { doc, filename, fullPath };
}

async function main() {
  console.log('======================================================================');
  console.log('S3K PRINTGO — PHASE 1C QUEUE CLEANUP SAFETY TESTS');
  console.log('======================================================================');

  const meta = await prisma.$queryRawUnsafe('SELECT current_database(), inet_server_port();');
  const activeDb = meta[0]?.current_database;
  const activePort = Number(meta[0]?.inet_server_port);
  assert.strictEqual(activeDb, 'printgo_disposable_target', `Unauthorized DB: ${activeDb}`);
  assert.strictEqual(activePort, 5433, `Unauthorized Port: ${activePort}`);

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);

  const createdResources = {
    jobIds: [],
    docIds: [],
    paymentIds: [],
    invoiceIds: [],
    files: []
  };

  try {
    // Shared eligibility fixtures for tests 1..6 + 9
    const docEligible1 = await createDocAndFile('elig1', createdResources);
    const jobEligible1 = await prisma.printJob.create({
      data: {
        shortId: makeShortId('e1'),
        status: 'PENDING_PAYMENT',
        cost: 4,
        documentId: docEligible1.doc.id,
        isTest: false,
        createdAt: twoHoursAgo
      }
    });
    createdResources.jobIds.push(jobEligible1.id);

    const docInv = await createDocAndFile('inv', createdResources);
    const jobWithInvoice = await prisma.printJob.create({
      data: {
        shortId: makeShortId('iv'),
        status: 'PENDING_PAYMENT',
        cost: 10,
        documentId: docInv.doc.id,
        isTest: false,
        createdAt: twoHoursAgo
      }
    });
    createdResources.jobIds.push(jobWithInvoice.id);
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `INV-P1C-${Date.now()}`,
        printJobId: jobWithInvoice.id,
        subtotal: 10,
        taxableAmount: 10,
        totalAmount: 10,
        sellerName: 'S3K Staging Test',
        pricingSnapshot: '{}',
        lineItems: '[]'
      }
    });
    createdResources.invoiceIds.push(inv.id);

    const docHist = await createDocAndFile('hist', createdResources);
    const jobWithHistory = await prisma.printJob.create({
      data: {
        shortId: makeShortId('ph'),
        status: 'PENDING_PAYMENT',
        cost: 6,
        documentId: docHist.doc.id,
        isTest: false,
        createdAt: twoHoursAgo
      }
    });
    createdResources.jobIds.push(jobWithHistory.id);
    await prisma.printHistory.create({
      data: {
        printJobId: jobWithHistory.id,
        success: false,
        errorDetails: 'Synthetic history link test'
      }
    });

    const docPaid = await createDocAndFile('paid', createdResources);
    const paymentSuccess = await prisma.payment.create({
      data: {
        amount: 8,
        status: 'SUCCESS',
        type: 'PRINT_JOB',
        gatewayOrderId: `order_p1c_paid_${Date.now()}`
      }
    });
    createdResources.paymentIds.push(paymentSuccess.id);
    const jobPaid = await prisma.printJob.create({
      data: {
        shortId: makeShortId('pd'),
        status: 'PENDING_PAYMENT', // intentionally anomalous PENDING_PAYMENT + paymentId to test guard
        cost: 8,
        documentId: docPaid.doc.id,
        paymentId: paymentSuccess.id,
        isTest: false,
        createdAt: twoHoursAgo
      }
    });
    createdResources.jobIds.push(jobPaid.id);

    const docActiveTx = await createDocAndFile('acttx', createdResources);
    const shortActiveTx = makeShortId('tx');
    const jobActiveOrderNoFk = await prisma.printJob.create({
      data: {
        shortId: shortActiveTx,
        status: 'PENDING_PAYMENT',
        cost: 8,
        documentId: docActiveTx.doc.id,
        paymentId: null,
        isTest: false,
        createdAt: twoHoursAgo
      }
    });
    createdResources.jobIds.push(jobActiveOrderNoFk.id);
    const pendingOrderPayment = await prisma.payment.create({
      data: {
        amount: 8,
        status: 'PENDING',
        type: 'PRINT_JOB',
        gatewayOrderId: `order_${shortActiveTx}_${Date.now()}`
      }
    });
    createdResources.paymentIds.push(pendingOrderPayment.id);

    const docTest = await createDocAndFile('test', createdResources);
    const jobTestFlag = await prisma.printJob.create({
      data: {
        shortId: makeShortId('ts'),
        status: 'PENDING_PAYMENT',
        cost: 2,
        documentId: docTest.doc.id,
        isTest: true,
        createdAt: twoHoursAgo
      }
    });
    createdResources.jobIds.push(jobTestFlag.id);

    const docRecent = await createDocAndFile('recent', createdResources);
    const jobRecent = await prisma.printJob.create({
      data: {
        shortId: makeShortId('rc'),
        status: 'PENDING_PAYMENT',
        cost: 2,
        documentId: docRecent.doc.id,
        isTest: false,
        createdAt: tenMinsAgo
      }
    });
    createdResources.jobIds.push(jobRecent.id);

    const summaryBatch1 = await cleanupAbandonedJobs({
      jobIds: [
        jobEligible1.id,
        jobWithInvoice.id,
        jobWithHistory.id,
        jobPaid.id,
        jobActiveOrderNoFk.id,
        jobTestFlag.id,
        jobRecent.id
      ],
      deleteFileFn: deleteFile
    });

    await runTest('1. Old unlinked PENDING_PAYMENT job is deleted cleanly with its document file', async () => {
      const check = await prisma.printJob.findUnique({ where: { id: jobEligible1.id } });
      assert.strictEqual(check, null, 'Eligible abandoned job must be deleted');
      assert.strictEqual(fs.existsSync(docEligible1.fullPath), false, 'Eligible document file must be removed after commit');
      assert.strictEqual(summaryBatch1.errors.length, 0, 'No P2003 or DB error should occur');
    });

    await runTest('2. Invoice-linked PENDING_PAYMENT job is preserved without P2003 failure', async () => {
      const check = await prisma.printJob.findUnique({ where: { id: jobWithInvoice.id }, include: { invoice: true } });
      assert.ok(check && check.invoice, 'Invoice-linked PrintJob and Invoice must stay intact');
      assert.strictEqual(fs.existsSync(docInv.fullPath), true, 'Document file of invoice-linked job must stay intact');
    });

    await runTest('3. PrintHistory-linked job is preserved', async () => {
      const check = await prisma.printJob.findUnique({ where: { id: jobWithHistory.id }, include: { printHistory: true } });
      assert.ok(check && check.printHistory.length === 1, 'PrintHistory-linked job must stay intact');
      assert.strictEqual(fs.existsSync(docHist.fullPath), true);
    });

    await runTest('4. Paid and active-transaction PENDING_PAYMENT jobs are preserved', async () => {
      const checkPaid = await prisma.printJob.findUnique({ where: { id: jobPaid.id } });
      const checkActiveOrder = await prisma.printJob.findUnique({ where: { id: jobActiveOrderNoFk.id } });
      assert.ok(checkPaid, 'Payment-FK-linked job must be preserved');
      assert.ok(checkActiveOrder, 'Job with active gatewayOrderId transaction must be preserved');
      assert.strictEqual(fs.existsSync(docPaid.fullPath), true);
      assert.strictEqual(fs.existsSync(docActiveTx.fullPath), true);
    });

    await runTest('5. Test job (isTest=true) is preserved', async () => {
      const check = await prisma.printJob.findUnique({ where: { id: jobTestFlag.id } });
      assert.ok(check, 'Test job must be protected from cleanup');
      assert.strictEqual(fs.existsSync(docTest.fullPath), true);
    });

    await runTest('6. Recent (<1 hour) PENDING_PAYMENT job is preserved', async () => {
      const check = await prisma.printJob.findUnique({ where: { id: jobRecent.id } });
      assert.ok(check, 'Recent job must be preserved');
      assert.strictEqual(fs.existsSync(docRecent.fullPath), true);
    });

    await runTest('7. Database deletion failure does NOT delete the document file', async () => {
      const docFail = await createDocAndFile('dbfail', createdResources);
      const jobDbFail = await prisma.printJob.create({
        data: {
          shortId: makeShortId('df'),
          status: 'PENDING_PAYMENT',
          cost: 4,
          documentId: docFail.doc.id,
          isTest: false,
          createdAt: twoHoursAgo
        }
      });
      createdResources.jobIds.push(jobDbFail.id);

      let deleteFileCalls = 0;
      // Inject a Prisma transaction proxy that commits/fails DB delete with P2003 simulation
      const failingPrismaProxy = {
        printJob: {
          findMany: (args) => prisma.printJob.findMany(args)
        },
        $transaction: async () => {
          const err = new Error('Foreign key constraint violated: Invoice_printJobId_fkey');
          err.code = 'P2003';
          throw err;
        }
      };

      const res = await cleanupAbandonedJobs({
        prismaClient: failingPrismaProxy,
        jobIds: [jobDbFail.id],
        deleteFileFn: async () => {
          deleteFileCalls++;
          return true;
        }
      });

      assert.strictEqual(deleteFileCalls, 0, 'deleteFileFn must NEVER run when DB deletion fails');
      assert.strictEqual(res.deletedCount, 0);
      assert.strictEqual(res.errors.length, 1);
      assert.strictEqual(fs.existsSync(docFail.fullPath), true, 'Document file must remain intact on disk');
      const stillInDb = await prisma.printJob.findUnique({ where: { id: jobDbFail.id } });
      assert.ok(stillInDb, 'PrintJob row remains in DB after failed transaction');
    });

    await runTest('8. File deletion executes strictly AFTER successful database commit & logs orphan failure safely', async () => {
      const docOrder = await createDocAndFile('order', createdResources);
      const jobOrder = await prisma.printJob.create({
        data: {
          shortId: makeShortId('od'),
          status: 'PENDING_PAYMENT',
          cost: 4,
          documentId: docOrder.doc.id,
          isTest: false,
          createdAt: twoHoursAgo
        }
      });
      createdResources.jobIds.push(jobOrder.id);

      let dbRowExistedDuringDeleteCall = null;
      const resOk = await cleanupAbandonedJobs({
        jobIds: [jobOrder.id],
        deleteFileFn: async (fn) => {
          // Query fresh via root prisma (outside any transaction): DB deletion MUST already be committed!
          const row = await prisma.printJob.findUnique({ where: { id: jobOrder.id } });
          dbRowExistedDuringDeleteCall = row !== null;
          return deleteFile(fn);
        }
      });

      assert.strictEqual(dbRowExistedDuringDeleteCall, false, 'DB PrintJob must already be committed/deleted BEFORE file deletion starts');
      assert.strictEqual(resOk.deletedCount, 1);
      assert.strictEqual(resOk.filesDeleted, 1);
      assert.strictEqual(fs.existsSync(docOrder.fullPath), false);

      // Verify post-DB file failure does not roll back or crash batch, and records orphanedFile
      const docOrphan = await createDocAndFile('orphan', createdResources);
      const jobOrphan = await prisma.printJob.create({
        data: {
          shortId: makeShortId('or'),
          status: 'PENDING_PAYMENT',
          cost: 4,
          documentId: docOrphan.doc.id,
          isTest: false,
          createdAt: twoHoursAgo
        }
      });
      createdResources.jobIds.push(jobOrphan.id);

      const resOrphan = await cleanupAbandonedJobs({
        jobIds: [jobOrphan.id],
        deleteFileFn: async () => {
          throw new Error('Simulated EACCES unlink failure');
        }
      });
      assert.strictEqual(resOrphan.deletedCount, 1);
      assert.strictEqual(resOrphan.orphanedFiles.length, 1);
      assert.strictEqual(resOrphan.orphanedFiles[0].filename, docOrphan.filename);
      assert.strictEqual(fs.existsSync(docOrphan.fullPath), true);
    });

    await runTest('9. One failing/referenced record does NOT block cleanup of other eligible records', async () => {
      const docBlocked = await createDocAndFile('blocked9', createdResources);
      const jobBlocked = await prisma.printJob.create({
        data: {
          shortId: makeShortId('b9'),
          status: 'PENDING_PAYMENT',
          cost: 4,
          documentId: docBlocked.doc.id,
          isTest: false,
          createdAt: new Date(twoHoursAgo.getTime() - 60000)
        }
      });
      createdResources.jobIds.push(jobBlocked.id);

      const docValid = await createDocAndFile('valid9', createdResources);
      const jobValid = await prisma.printJob.create({
        data: {
          shortId: makeShortId('v9'),
          status: 'PENDING_PAYMENT',
          cost: 4,
          documentId: docValid.doc.id,
          isTest: false,
          createdAt: twoHoursAgo
        }
      });
      createdResources.jobIds.push(jobValid.id);

      let callNum = 0;
      const mixedPrismaProxy = {
        printJob: {
          findMany: (args) => prisma.printJob.findMany(args)
        },
        $transaction: async (cb) => {
          callNum++;
          if (callNum === 1) {
            throw new Error('Simulated per-job P2003 on first candidate');
          }
          return prisma.$transaction(cb);
        }
      };

      const res = await cleanupAbandonedJobs({
        prismaClient: mixedPrismaProxy,
        jobIds: [jobBlocked.id, jobValid.id],
        deleteFileFn: deleteFile
      });

      assert.strictEqual(res.errors.length, 1, 'Exactly one candidate errored cleanly');
      assert.strictEqual(res.deletedCount, 1, 'Second eligible candidate MUST still be cleaned up');
      assert.deepStrictEqual(res.deletedJobIds, [jobValid.id]);
      assert.strictEqual(fs.existsSync(docBlocked.fullPath), true, 'Blocked job file preserved');
      assert.strictEqual(fs.existsSync(docValid.fullPath), false, 'Valid job file deleted');
    });

    await runTest('10. Concurrent Invoice creation or payment transition prevents deletion of referenced record', async () => {
      const docRaceInv = await createDocAndFile('raceinv', createdResources);
      const jobRaceInv = await prisma.printJob.create({
        data: {
          shortId: makeShortId('ri'),
          status: 'PENDING_PAYMENT',
          cost: 12,
          documentId: docRaceInv.doc.id,
          isTest: false,
          createdAt: twoHoursAgo
        }
      });
      createdResources.jobIds.push(jobRaceInv.id);

      const docRacePaid = await createDocAndFile('racepaid', createdResources);
      const jobRacePaid = await prisma.printJob.create({
        data: {
          shortId: makeShortId('rp'),
          status: 'PENDING_PAYMENT',
          cost: 12,
          documentId: docRacePaid.doc.id,
          isTest: false,
          createdAt: twoHoursAgo
        }
      });
      createdResources.jobIds.push(jobRacePaid.id);

      let raceTriggered = false;
      const racingPrismaProxy = {
        printJob: {
          findMany: async (args) => {
            const list = await prisma.printJob.findMany(args);
            if (!raceTriggered) {
              raceTriggered = true;
              // Simulate concurrent request committing an Invoice on jobRaceInv AND paying jobRacePaid
              // right AFTER candidate selection but BEFORE cleanup $transaction starts!
              const rInv = await prisma.invoice.create({
                data: {
                  invoiceNumber: `INV-RACE-${Date.now()}`,
                  printJobId: jobRaceInv.id,
                  subtotal: 12,
                  taxableAmount: 12,
                  totalAmount: 12,
                  sellerName: 'Race Co',
                  pricingSnapshot: '{}',
                  lineItems: '[]'
                }
              });
              createdResources.invoiceIds.push(rInv.id);

              await prisma.printJob.update({
                where: { id: jobRacePaid.id },
                data: { status: 'WAITING' }
              });
            }
            return list;
          }
        },
        $transaction: (cb) => prisma.$transaction(cb)
      };

      const res = await cleanupAbandonedJobs({
        prismaClient: racingPrismaProxy,
        jobIds: [jobRaceInv.id, jobRacePaid.id],
        deleteFileFn: deleteFile
      });

      assert.strictEqual(res.deletedCount, 0, 'Concurrently linked/paid jobs MUST NOT be deleted');
      assert.strictEqual(res.skippedCount, 2);
      assert.strictEqual(res.errors.length, 0);

      const checkInvJob = await prisma.printJob.findUnique({ where: { id: jobRaceInv.id }, include: { invoice: true } });
      const checkPaidJob = await prisma.printJob.findUnique({ where: { id: jobRacePaid.id } });
      assert.ok(checkInvJob && checkInvJob.invoice, 'Concurrently invoiced job must remain intact');
      assert.strictEqual(checkPaidJob.status, 'WAITING', 'Concurrently paid job must remain WAITING');
      assert.strictEqual(fs.existsSync(docRaceInv.fullPath), true);
      assert.strictEqual(fs.existsSync(docRacePaid.fullPath), true);
    });
  } finally {
    // Remove ONLY synthetic test records created by this test suite
    if (createdResources.invoiceIds.length > 0) {
      await prisma.invoice.deleteMany({ where: { id: { in: createdResources.invoiceIds } } }).catch(() => {});
    }
    if (createdResources.jobIds.length > 0) {
      await prisma.printHistory.deleteMany({ where: { printJobId: { in: createdResources.jobIds } } }).catch(() => {});
      await prisma.printJob.deleteMany({ where: { id: { in: createdResources.jobIds } } }).catch(() => {});
    }
    if (createdResources.paymentIds.length > 0) {
      await prisma.payment.deleteMany({ where: { id: { in: createdResources.paymentIds } } }).catch(() => {});
    }
    if (createdResources.docIds.length > 0) {
      await prisma.document.deleteMany({ where: { id: { in: createdResources.docIds } } }).catch(() => {});
    }
    for (const f of createdResources.files) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
    try { fs.rmdirSync(tempUploadDir); } catch (_) {}
    await prisma.$disconnect();
  }

  console.log('======================================================================');
  console.log(`PHASE 1C CLEANUP SAFETY RESULTS: ${passed} PASSED, ${failed} FAILED (Total: ${passed + failed})`);
  console.log('======================================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Unhandled error in Phase 1C test suite:', err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
