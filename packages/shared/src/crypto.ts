import crypto from "node:crypto";

function keyFromSecret(secret: string): Buffer {
  return /^[a-f0-9]{64}$/i.test(secret) ? Buffer.from(secret, "hex") : crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plainText: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(cipherText: string, secret: string): string {
  const [ivValue, tagValue, encryptedValue] = cipherText.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Invalid encrypted secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromSecret(secret), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomCode(length = 6): string {
  return crypto.randomInt(0, 10 ** length).toString().padStart(length, "0");
}

export function hashOtp(code: string, pepper: string): string {
  return crypto.pbkdf2Sync(code, pepper, 120000, 32, "sha256").toString("hex");
}

export function timingSafeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
