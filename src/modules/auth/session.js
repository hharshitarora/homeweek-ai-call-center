import crypto from "crypto";
import "dotenv/config";

const SESSION_SECRET = process.env.SESSION_SECRET;

export function signSession(payload) {
  const data = JSON.stringify(payload);
  const b64 = Buffer.from(data, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  return \`\${b64}.\${sig}\`;
}

export function verifySession(value) {
  if (!value || typeof value !== "string") return null;
  const i = value.lastIndexOf(".");
  if (i <= 0) return null;
  const b64 = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(b64).digest("base64url");
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(";").forEach((s) => {
    const i = s.indexOf("=");
    if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  });
  return out;
}
