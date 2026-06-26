// ---------------------------------------------------------------------------
// auth.js — Authentication
//
// Same approach as a production app: passwords are hashed with bcrypt (never
// stored in plain text), and a successful login returns a signed JWT stored in
// an httpOnly cookie so client-side JS can't read or steal it.
//
// The `requireAuth` middleware guards the write endpoints. Read endpoints stay
// public.
// ---------------------------------------------------------------------------

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// In production this comes from an environment variable, never hardcoded.
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_TTL = "7d";

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

// Express middleware. Reads the cookie, verifies the JWT, and either attaches
// the user to the request or returns 401. This is what makes "only the author
// can publish" actually true on the server — not just hidden in the UI.
export function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired or invalid" });
  }
}
