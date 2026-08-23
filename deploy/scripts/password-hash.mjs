import crypto from "node:crypto";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");

if (Buffer.byteLength(password, "utf8") < 12) {
  console.error("Password must be at least 12 bytes.");
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.scryptSync(password, salt, 64).toString("hex");
process.stdout.write(`${salt}:${hash}`);
