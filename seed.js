import fs from "fs";
import bcrypt from "bcryptjs";
import { getDb } from "./db.js";

const DB_FILE = process.env.DB_FILE || "./nfms.db";

async function run() {
  const db = await getDb(DB_FILE);

  const schema = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf-8");
  await db.exec(schema);

  // Default admin
  const email = "admin@namasenene.local";
  const exists = await db.get("SELECT id FROM users WHERE email = ?", [email]);
  if (!exists) {
    const hash = await bcrypt.hash("Admin123!", 10);
    await db.run(
      "INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)",
      ["NFMS Admin", email, hash, "admin"]
    );
    console.log("✅ Created default admin:");
    console.log("   email:", email);
    console.log("   pass : Admin123!");
  } else {
    console.log("ℹ️ Admin already exists.");
  }

  console.log("✅ DB ready:", DB_FILE);
  await db.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});