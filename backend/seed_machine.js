require('dotenv').config();
const prisma = require('./src/utils/prisma');

async function seed() {
  const key = process.env.MACHINE_KEY;
  if (!key) {
    throw new Error('MACHINE_KEY environment variable is not defined.');
  }

  try {
    const existing = await prisma.machine.findUnique({ where: { machineKey: key }});
    if (!existing) {
      await prisma.machine.create({
        data: {
          name: 'Main Shop Printer',
          location: 'Front Desk',
          machineKey: key,
          status: 'ACTIVE',
        }
      });
      console.log('Seeded machine successfully with configured MACHINE_KEY.');
    } else {
      console.log('Machine already exists.');
    }
  } catch(e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}
seed();
