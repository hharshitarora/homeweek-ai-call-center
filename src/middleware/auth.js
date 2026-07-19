import { verifySession, parseCookies } from "../modules/auth/session.js";
import "dotenv/config";

const LOGIN_USERNAME = (process.env.LOGIN_USERNAME || "").trim();
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD;
const LOGIN_EMAIL_RAW = (process.env.LOGIN_EMAIL || "").trim();
const LOGIN_EMAILS = LOGIN_EMAIL_RAW ? LOGIN_EMAIL_RAW.split(",").map((e) => e.trim()).filter(Boolean) : [];
const SESSION_SECRET = process.env.SESSION_SECRET;
const API_KEY = process.env.TRIGGER_API_KEY || process.env.API_KEY || "";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const GMAIL_USER = (process.env.GMAIL_USER || "").trim();
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SENDGRID_FROM = (process.env.SENDGRID_FROM || "").trim();

const EMAIL_SENDER_OK = !!(RESEND_API_KEY || (GMAIL_USER && GMAIL_APP_PASSWORD) || (SENDGRID_API_KEY && SENDGRID_FROM));
const AUTH_ENABLED = !!(LOGIN_USERNAME && SESSION_SECRET && (LOGIN_PASSWORD || (LOGIN_EMAILS.length > 0 && EMAIL_SENDER_OK)));

const SESSION_COOKIE_NAME = "session";

export function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  
  // 1) Session cookie
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  const session = verifySession(token);
  if (session && session.user) {
    req.user = session.user;
    return next();
  }
  
  // 2) API key
  if (API_KEY && typeof API_KEY === "string" && API_KEY.length > 0) {
    const authHeader = req.headers.authorization;
    const bearer = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const xApiKey = (req.headers["x-api-key"] || "").trim();
    if ((bearer && bearer === API_KEY) || (xApiKey && xApiKey === API_KEY)) {
      req.user = "api-key";
      return next();
    }
  }
  
  return res.status(401).json({ ok: false, error: "Login required" });
}
