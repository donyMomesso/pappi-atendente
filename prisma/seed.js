// prisma/seed.js
// Popula o banco com dados de teste para desenvolvimento.
// Uso: npm run db:seed

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const TENANT_ID = "tenant-pappi-001";

async function main() {
  console.log("🌱 Iniciando seed...\n");

  // Tenant de teste
  const tenant = await prisma.tenant.upsert({
    where: { waPhoneNumberId: "dev-phone-001" },
    update: {},
    create: {
      id: TENANT_ID,
      name: "Pizzaria Pappi (Dev)",
      waToken: "dev-token-placeholder",
      waPhoneNumberId: "dev-phone-001",
      waWabaId: "dev-waba-001",
      cwApiKey: "dev-cw-api-key",
      cwPartnerKey: "dev-cw-partner-key",
      cwStoreId: "dev-store-001",
      city: "Campinas",
      active: true,
    },
  });
  const tenantId = tenant.id;
  console.log(`✅ Tenant: ${tenant.name} (${tenantId})`);

  // Clientes de teste
  const customers = [
    { phone: "5519999001001", name: "João Silva" },
    { phone: "5519999002002", name: "Maria Oliveira" },
    { phone: "5519999003003", name: "Carlos Santos" },
  ];

  for (const c of customers) {
    const customer = await prisma.customer.upsert({
      where: { tenantId_phone: { tenantId: tenantId, phone: c.phone } },
      update: {},
      create: {
        tenantId: tenantId,
        phone: c.phone,
        name: c.name,
        lastAddress: "Rua das Flores, 123, Centro, Campinas - SP",
        lastStreet: "Rua das Flores",
        lastNumber: "123",
        lastNeighborhood: "Centro",
        lastCity: "Campinas",
        visitCount: Math.floor(Math.random() * 10) + 1,
      },
    });
    console.log(`✅ Cliente: ${customer.name} (${customer.phone})`);
  }

  // Pedido de exemplo
  const customer1 = await prisma.customer.findUnique({
    where: { tenantId_phone: { tenantId: tenantId, phone: "5519999001001" } },
  });

  if (customer1) {
    const order = await prisma.order.upsert({
      where: { tenantId_idempotencyKey: { tenantId: tenantId, idempotencyKey: "seed-order-001" } },
      update: {},
      create: {
        tenantId: tenantId,
        customerId: customer1.id,
        idempotencyKey: "seed-order-001",
        status: "confirmed",
        total: 68.0,
        deliveryFee: 8.0,
        discount: 0,
        totalValidated: true,
        totalExpected: 68.0,
        fulfillment: "delivery",
        paymentMethodId: "pix",
        paymentMethodName: "PIX",
        itemsSnapshot: JSON.stringify([
          { id: "1", name: "Pizza Calabresa Grande", quantity: 2, unit_price: 30.0 },
          { id: "2", name: "Guaraná 2L", quantity: 1, unit_price: 5.0 },
          { id: "3", name: "Borda Cheddar", quantity: 2, unit_price: 5.0 },
        ]),
        addressSnapshot: "Rua das Flores, 123, Centro, Campinas - SP",
      },
    });
    console.log(`✅ Pedido: ${order.id.slice(-6).toUpperCase()} — R$ ${order.total}`);
  }

  // Configuração de exemplo
  await prisma.config.upsert({
    where: { key: `${tenantId}:attendants` },
    update: {},
    create: {
      key: `${tenantId}:attendants`,
      value: JSON.stringify([
        { name: "Admin", key: "pappi-atendente-2026", role: "admin" },
        { name: "Operador 1", key: "op1-key-dev", role: "attendant" },
      ]),
    },
  });
  console.log("✅ Config: attendants configurados");

  console.log("\n🎉 Seed concluído com sucesso!");
}

main()
  .catch((e) => {
    console.error("❌ Erro no seed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
