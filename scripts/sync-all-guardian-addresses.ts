import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function parseMailingAddress(addressStr: string) {
  const parts = addressStr.split(',').map(p => p.trim());
  
  let country = 'PAKISTAN';
  let province = 'SINDH';
  let city = 'KARACHI';
  let area_block = 'N/A';
  let house_appt_name = addressStr;

  if (parts.length >= 3) {
    const last = parts[parts.length - 1].toUpperCase();
    let offset = 0;
    if (last.includes('PAKISTAN')) {
      country = 'PAKISTAN';
      offset++;
    }
    const provs = ['SINDH', 'PUNJAB', 'BALOCHISTAN', 'KPK', 'GILGIT'];
    const currentProvPart = parts[parts.length - 1 - offset]?.toUpperCase() || '';
    const matchedProv = provs.find(p => currentProvPart.includes(p));
    if (matchedProv) {
      province = matchedProv;
      offset++;
    }
    
    const currentCityPart = parts[parts.length - 1 - offset]?.toUpperCase() || '';
    if (currentCityPart) {
      city = currentCityPart;
      offset++;
    }

    if (parts.length - 1 - offset >= 0) {
      area_block = parts[parts.length - 1 - offset];
      offset++;
    }

    if (parts.length - 1 - offset >= 0) {
      house_appt_name = parts.slice(0, parts.length - offset + 1).join(', ');
    } else {
      house_appt_name = parts[0];
    }
  } else {
    const upper = addressStr.toUpperCase();
    if (upper.includes('KARACHI')) {
      city = 'KARACHI';
      province = 'SINDH';
    } else if (upper.includes('LAHORE')) {
      city = 'LAHORE';
      province = 'PUNJAB';
    } else if (upper.includes('ISLAMABAD')) {
      city = 'ISLAMABAD';
      province = 'PUNJAB';
    }

    const blockIndex = upper.indexOf('BLOCK');
    if (blockIndex !== -1) {
      house_appt_name = addressStr.substring(0, blockIndex).trim();
      area_block = addressStr.substring(blockIndex).replace(/KARACHI|SINDH|PAKISTAN/gi, '').trim();
    } else {
      house_appt_name = addressStr.replace(/KARACHI|SINDH|PAKISTAN/gi, '').trim();
    }
  }

  return {
    country: country.substring(0, 50).toUpperCase(),
    province: province.substring(0, 50).toUpperCase(),
    city: city.substring(0, 50).toUpperCase(),
    area_block: area_block.substring(0, 100).toUpperCase(),
    house_appt_name: house_appt_name.substring(0, 255).toUpperCase(),
  };
}

async function main() {
  console.log('Starting retroactive address sync...');
  const families = await prisma.families.findMany({
    include: {
      students: {
        where: { deleted_at: null },
        include: {
          student_guardians: {
            include: { guardians: true }
          }
        }
      }
    }
  });

  for (const family of families) {
    let activeAddress = family.primary_address;

    for (const student of family.students) {
      for (const sg of student.student_guardians) {
        if (sg.guardians?.mailing_address) {
          activeAddress = sg.guardians.mailing_address;
          break;
        }
      }
      if (activeAddress) break;
    }

    if (activeAddress) {
      console.log(`Syncing address for Family #${family.id} using: "${activeAddress}"`);
      
      await prisma.families.update({
        where: { id: family.id },
        data: { primary_address: activeAddress }
      });

      const parsed = parseMailingAddress(activeAddress);

      const guardianIds = new Set<number>();
      for (const student of family.students) {
        for (const sg of student.student_guardians) {
          if (sg.guardian_id) {
            guardianIds.add(sg.guardian_id);
          }
        }
      }

      if (guardianIds.size > 0) {
        await prisma.guardians.updateMany({
          where: { id: { in: Array.from(guardianIds) } },
          data: {
            mailing_address: activeAddress,
            ...parsed
          }
        });
      }
    }
  }

  console.log('Retroactive address sync complete!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
