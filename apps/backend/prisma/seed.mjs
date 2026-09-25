import { config as loadDotEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";
import { hash as argon2Hash } from "@node-rs/argon2";

// prisma db seed runs with cwd = apps/backend, so load the repo-root .env
// explicitly to pick up SEED_* and DATABASE_URL.
loadDotEnv({
  path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
});

/**
 * Seeds a development database with a default admin + demo user.
 * Credentials come from the environment; never hardcode production passwords.
 */
const DB_URL = process.env["DATABASE_URL"];
const ADMIN_EMAIL = process.env["SEED_ADMIN_EMAIL"] ?? "admin@callnotes.local";
const ADMIN_PASSWORD = process.env["SEED_ADMIN_PASSWORD"];
const DEMO_EMAIL = process.env["SEED_DEMO_EMAIL"] ?? "demo@callnotes.local";
const DEMO_PASSWORD = process.env["SEED_DEMO_PASSWORD"];

if (!DB_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
if (!ADMIN_PASSWORD || !DEMO_PASSWORD) {
  console.error("SEED_ADMIN_PASSWORD and SEED_DEMO_PASSWORD must be set (development only)");
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: DB_URL });
const prisma = new PrismaClient({ adapter });

// Seeded credentials are hashed with Argon2id so these accounts can sign in.
const PLACEHOLDER_HASH = "[seeded-development-user]";

async function upsertUser(email, name, role, password) {
  const passwordHash = await argon2Hash(password);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, name, role, passwordHash },
  });
  console.log(`Seeded ${role.toLowerCase()} user: ${email}`);
  return user;
}

const admin = await upsertUser(ADMIN_EMAIL, "Admin", "ADMIN", ADMIN_PASSWORD);
await upsertUser(DEMO_EMAIL, "Demo User", "USER", DEMO_PASSWORD);

await prisma.auditLog.create({
  data: {
    userId: admin.id,
    action: "DB_SEEDED",
    resource: "User",
    metadata: { message: "Development database seeded" },
  },
});

await prisma.$disconnect();
console.log("Seeding complete");