import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.contractor.count();
  if (existing > 0) {
    console.log(`Skipping seed — ${existing} contractors already exist.`);
    return;
  }

  await prisma.contractor.createMany({
    data: [
      {
        firstName: "Maria",
        lastName: "Lopez",
        email: "maria.lopez@example.com",
        physicalAddress: {
          address1: "Av. Reforma 123",
          country: "MX",
          state: "CMX",
          city: "Mexico City",
          zip: "06600",
        },
        bankAccount: {
          type: "mxnDomestic",
          symbol: "MXN",
          bankAccountNumber: "012180001234567899",
          bankId: "bank_mxn_001",
        },
        currency: "MXN",
      },
      {
        firstName: "Carlos",
        lastName: "Ramirez",
        email: "carlos.ramirez@example.com",
        physicalAddress: {
          address1: "Av. Insurgentes Sur 1602",
          country: "MX",
          state: "CMX",
          city: "Mexico City",
          zip: "03940",
        },
        bankAccount: {
          type: "mxnDomestic",
          symbol: "MXN",
          bankAccountNumber: "012180009876543215",
          bankId: "bank_mxn_001",
        },
        currency: "MXN",
      },
      {
        firstName: "Diego",
        lastName: "Hernandez",
        email: "diego.hernandez@example.com",
        physicalAddress: {
          address1: "Calle 72 #10-20",
          country: "CO",
          state: "DC",
          city: "Bogota",
          zip: "110111",
        },
        bankAccount: {
          type: "copDomestic",
          symbol: "COP",
          phoneNumber: "+573001234567",
          accountType: "SAVINGS",
          bankAccountNumber: "1234567890",
          documentNumber: "1234567890",
          documentType: "NATIONAL_ID",
          bankId: "bank_cop_001",
        },
        currency: "COP",
      },
      {
        firstName: "Valentina",
        lastName: "Castro",
        email: "valentina.castro@example.com",
        physicalAddress: {
          address1: "Carrera 7 #71-21",
          country: "CO",
          state: "DC",
          city: "Bogota",
          zip: "110231",
        },
        bankAccount: {
          type: "copDomestic",
          symbol: "COP",
          phoneNumber: "+573109876543",
          accountType: "CHECKING",
          bankAccountNumber: "9876543210",
          documentNumber: "9876543210",
          documentType: "NATIONAL_ID",
          bankId: "bank_cop_001",
        },
        currency: "COP",
      },
      {
        firstName: "Sofia",
        lastName: "Garcia",
        email: "sofia.garcia@example.com",
        physicalAddress: {
          address1: "Paseo de la Reforma 222",
          country: "MX",
          state: "CMX",
          city: "Mexico City",
          zip: "06600",
        },
        bankAccount: {
          type: "mxnDomestic",
          symbol: "MXN",
          bankAccountNumber: "012180000555123450",
          bankId: "bank_mxn_001",
        },
        currency: "MXN",
      },
    ],
  });

  const count = await prisma.contractor.count();
  console.log(`Seeded ${count} contractors.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
