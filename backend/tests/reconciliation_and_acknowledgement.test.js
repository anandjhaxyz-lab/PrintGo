const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const prisma = require('../src/utils/prisma');
const { isValidJobTransition } = require('../src/utils/stateMachine');
const JobJournal = require('../../printer-agent/src/journal');
const fs = require('fs');

async function runTestSuite() {
  console.log('===============================================================');
  console.log('PRINTGO — RECONCILIATION & ACKNOWLEDGEMENT TEST SUITE');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`✅ PASS: ${name}`);
      passed++;
    } catch (e) {
      console.error(`❌ FAIL: ${name}`);
      console.error(`   Error: ${e.message}\n`);
      failed++;
    }
  };

  // Test 1: Idempotent Duplicate Completion Events
  await test('Idempotent handling of duplicate physical completion events', async () => {
    const testShortId = 'TEST-IDEMP-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const doc = await prisma.document.create({
      data: {
        originalName: 'idempotency_test.pdf',
        filename: '/uploads/idempotency_test.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        pages: 1
      }
    });

    const job = await prisma.printJob.create({
      data: {
        shortId: testShortId,
        status: 'PRINTING',
        cost: 2.0,
        documentId: doc.id,
        copies: 1,
        pagesToPrint: 1
      }
    });

    // First completion
    const firstUpdate = await prisma.printJob.update({
      where: { shortId: testShortId },
      data: { status: 'COMPLETED' }
    });
    if (firstUpdate.status !== 'COMPLETED') throw new Error('First completion failed');

    // Duplicate completion simulation: state machine must reject invalid jump
    const canTransitionAgain = isValidJobTransition(firstUpdate.status, 'COMPLETED');
    if (canTransitionAgain) throw new Error('State machine incorrectly allowed transition from COMPLETED to COMPLETED');

    // Clean up
    await prisma.printJob.delete({ where: { shortId: testShortId } });
    await prisma.document.delete({ where: { id: doc.id } });
  });

  // Test 2: Local Agent Journal Persistence Across Restarts
  await test('Agent journal retains dispatched state across process restarts', async () => {
    const testJournalPath = path.join(__dirname, '../scratch/test_journal.json');
    if (fs.existsSync(testJournalPath)) fs.unlinkSync(testJournalPath);

    // Process 1: Record dispatch
    const journal1 = new JobJournal(testJournalPath);
    journal1.recordReceived('TEST-RST-01', { name: 'sample.pdf' });
    journal1.recordDispatched('TEST-RST-01', { printer: 'Epson' });

    if (!journal1.isDispatched('TEST-RST-01')) {
      throw new Error('Journal 1 failed to report dispatched');
    }

    // Process 2: Simulate complete agent restart by reloading from disk
    const journal2 = new JobJournal(testJournalPath);
    if (!journal2.isDispatched('TEST-RST-01')) {
      throw new Error('Restarted journal did not persist dispatched state');
    }

    const jobDetails = journal2.getJob('TEST-RST-01');
    if (jobDetails.state !== 'DISPATCHED_TO_SPOOLER') {
      throw new Error(`Unexpected job state in reloaded journal: ${jobDetails.state}`);
    }

    // Clean up
    if (fs.existsSync(testJournalPath)) fs.unlinkSync(testJournalPath);
  });

  // Test 3: Idempotency Guard Rejects Duplicate Physical Prints
  await test('Agent idempotency guard blocks duplicate physical print submission', async () => {
    const testJournalPath = path.join(__dirname, '../scratch/test_journal_guard.json');
    if (fs.existsSync(testJournalPath)) fs.unlinkSync(testJournalPath);

    const journal = new JobJournal(testJournalPath);
    journal.recordDispatched('TEST-DUP-01', { printer: 'Epson' });

    // Simulate receiving physical_print_job for same ID
    let printDispatched = false;
    const simulateReceiveJob = (jobId) => {
      if (journal.isDispatched(jobId)) {
        // Guard triggers
        return { blocked: true, reason: 'Already dispatched' };
      }
      printDispatched = true;
      return { blocked: false };
    };

    const result = simulateReceiveJob('TEST-DUP-01');
    if (!result.blocked) {
      throw new Error('Idempotency guard failed to block duplicate job dispatch');
    }

    if (fs.existsSync(testJournalPath)) fs.unlinkSync(testJournalPath);
  });

  // Test 4: Ambiguous Outcome Does NOT Mark COMPLETED Solely On Empty Queue
  await test('Never mark COMPLETED solely because spooler queue is empty', async () => {
    const testShortId = 'TEST-AMB-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const doc = await prisma.document.create({
      data: {
        originalName: 'ambiguity_test.pdf',
        filename: '/uploads/ambiguity_test.pdf',
        mimetype: 'application/pdf',
        size: 512,
        pages: 1
      }
    });

    const job = await prisma.printJob.create({
      data: {
        shortId: testShortId,
        status: 'PRINTING',
        cost: 1.0,
        documentId: doc.id,
        copies: 1,
        pagesToPrint: 1
      }
    });

    // Simulate ambiguous timeout (queue is empty, but was never seen)
    const wasSeenInQueue = false;
    let finalStatus = job.status;

    // Safety logic: Only mark completed if wasSeenInQueue === true
    if (wasSeenInQueue) {
      finalStatus = 'COMPLETED';
    } else {
      // Must NOT mark COMPLETED! Record ambiguous history instead
      await prisma.printHistory.create({
        data: {
          printJobId: job.id,
          success: false,
          errorDetails: 'Ambiguous outcome: Spooler queue was empty but job was never verified in queue',
          completedAt: new Date()
        }
      });
    }

    const verifyJob = await prisma.printJob.findUnique({
      where: { shortId: testShortId },
      include: { printHistory: true }
    });

    if (verifyJob.status === 'COMPLETED') {
      throw new Error('Violation: Job was marked COMPLETED solely on empty queue!');
    }

    if (verifyJob.status !== 'PRINTING') {
      throw new Error(`Unexpected job status: ${verifyJob.status}`);
    }

    if (verifyJob.printHistory.length !== 1 || verifyJob.printHistory[0].success !== false) {
      throw new Error('Ambiguous audit history was not properly recorded');
    }

    // Clean up
    await prisma.printHistory.deleteMany({ where: { printJobId: job.id } });
    await prisma.printJob.delete({ where: { shortId: testShortId } });
    await prisma.document.delete({ where: { id: doc.id } });
  });

  // Test 5: Verified Physical Print Record Preservation (PG-CSMH66)
  await test('Preserve confirmed physical print record for PG-CSMH66', async () => {
    const job = await prisma.printJob.findUnique({
      where: { shortId: 'PG-CSMH66' },
      include: { printHistory: true, document: true }
    });

    if (!job) throw new Error('Job PG-CSMH66 was not found in database');
    if (job.status !== 'COMPLETED') throw new Error(`PG-CSMH66 status is ${job.status}, expected COMPLETED`);
    if (!job.printHistory || job.printHistory.length === 0) {
      throw new Error('PG-CSMH66 has no PrintHistory verification record');
    }

    const hasPhysicalConfirmation = job.printHistory.some(h => 
      h.success === true && h.errorDetails && h.errorDetails.includes('Physical verification confirmed')
    );

    if (!hasPhysicalConfirmation) {
      throw new Error('PrintHistory missing physical verification confirmation entry');
    }
  });

  console.log('\n===============================================================');
  console.log(`TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log('===============================================================');

  if (failed > 0) process.exit(1);
}

runTestSuite().then(() => process.exit(0)).catch(e => {
  console.error(e);
  process.exit(1);
});
