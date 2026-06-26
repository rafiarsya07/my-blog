import multer from "multer";
import sharp from "sharp";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = join(__dirname, "..", "public", "uploads");
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 8 * 1024 * 1024;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
  fileFilter(req, file, cb) {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only JPG, PNG, WebP, or GIF images are allowed"));
  },
});

export async function processAndSave(buffer) {
  const name = `${Date.now()}-${randomBytes(4).toString("hex")}.webp`;
  const outPath = join(UPLOAD_DIR, name);
  await sharp(buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(outPath);
  return `/uploads/${name}`;
}
