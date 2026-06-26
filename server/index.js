// ---------------------------------------------------------------------------
// index.js — HTTP server + API
//
// Serves the front-end, exposes a JSON API, renders Markdown server-side, and
// starts the background scheduler for timed publishing.
//
// Route map:
//   PUBLIC
//     GET  /api/posts              list published posts
//     GET  /api/posts/:slug        one post (rendered) + view++ + related
//     GET  /api/search?q=          full-text search
//     GET  /api/tags               tag cloud with counts
//     GET  /api/tags/:tag          posts for one tag
//   AUTH
//     POST /api/login  /api/logout  GET /api/me
//   ADMIN (requireAuth)
//     GET    /api/admin/posts        all posts incl. drafts/scheduled
//     GET    /api/admin/posts/:id    one full post (for the editor)
//     GET    /api/admin/stats        dashboard counts
//     POST   /api/admin/posts        create
//     PUT    /api/admin/posts/:id    update
//     DELETE /api/admin/posts/:id    delete
//     POST   /api/admin/preview      render Markdown -> HTML (live preview)
// ---------------------------------------------------------------------------

import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { marked } from "marked";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import * as db from "./db.js";
import { hashPassword, verifyPassword, signToken, requireAuth } from "./auth.js";
import { startScheduler } from "./scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(join(__dirname, "..", "public")));

function slugify(title) {
  return title.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 80);
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string")
    return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

// Decide a post's status from the editor's intent.
// - "publish now"  -> published, no publish_at
// - "schedule"     -> scheduled + publish_at (if the time is future)
// - otherwise      -> draft
function resolveStatus({ action, publishAt }) {
  if (action === "schedule" && publishAt) {
    const when = new Date(publishAt).getTime();
    if (when > Date.now()) return { status: "scheduled", publishAt: new Date(when).toISOString() };
    // Time already passed -> just publish now.
    return { status: "published", publishAt: null };
  }
  if (action === "publish") return { status: "published", publishAt: null };
  return { status: "draft", publishAt: null };
}

// =========================== PUBLIC ========================================

app.get("/api/posts", async (req, res) => {
  res.json(await db.listPublishedPosts());
});

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString();
  if (!q.trim()) return res.json([]);
  res.json(await db.searchPosts(q));
});

app.get("/api/tags", async (req, res) => {
  res.json(await db.tagCounts());
});

app.get("/api/tags/:tag", async (req, res) => {
  res.json(await db.postsByTag(req.params.tag));
});

app.get("/api/posts/:slug", async (req, res) => {
  const post = await db.getPostBySlug(req.params.slug);
  const isLive =
    post && post.status === "published" &&
    (!post.publishAt || post.publishAt <= Date.now());
  if (!post || !isLive) return res.status(404).json({ error: "Post not found" });

  await db.incrementViews(req.params.slug);
  const related = await db.relatedPosts(post.id, post.tags, 3);
  res.json({
    ...post,
    views: post.views + 1,
    html: marked.parse(post.body),
    related,
  });
});

// =========================== AUTH ==========================================

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const user = await db.getUserByUsername(username || "");
  if (!user || !(await verifyPassword(password || "", user.passwordHash))) {
    return res.status(401).json({ error: "Wrong username or password" });
  }
  res.cookie("token", signToken(user), {
    httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ username: user.username });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

// =========================== ADMIN =========================================

app.get("/api/admin/posts", requireAuth, async (req, res) => {
  res.json(await db.listAllPosts());
});

app.get("/api/admin/stats", requireAuth, async (req, res) => {
  res.json(await db.adminStats());
});

// Full post (with body) for loading into the editor.
app.get("/api/admin/posts/:id", requireAuth, async (req, res) => {
  const post = await db.getPostById(Number(req.params.id));
  if (!post) return res.status(404).json({ error: "Post not found" });
  res.json(post);
});

// Live preview: render Markdown without saving anything.
app.post("/api/admin/preview", requireAuth, (req, res) => {
  const body = (req.body?.body || "").toString();
  res.json({ html: marked.parse(body) });
});

app.post("/api/admin/posts", requireAuth, async (req, res) => {
  const { title, body, tags, action, publishAt, coverImage } = req.body || {};
  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "Title and body are required" });
  }
  let slug = slugify(title);
  let n = 1;
  while (await db.getPostBySlug(slug)) slug = `${slugify(title)}-${++n}`;

  const { status, publishAt: pa } = resolveStatus({ action, publishAt });
  const post = await db.createPost({
    title: title.trim(), slug, body,
    tags: parseTags(tags), status, publishAt: pa, coverImage,
  });
  res.status(201).json(post);
});

app.put("/api/admin/posts/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const { title, body, tags, action, publishAt, coverImage } = req.body || {};
  const fields = {};
  if (title !== undefined) fields.title = title.trim();
  if (body !== undefined) fields.body = body;
  if (tags !== undefined) fields.tags = parseTags(tags);
  if (coverImage !== undefined) fields.coverImage = coverImage || null;
  if (action !== undefined) {
    const r = resolveStatus({ action, publishAt });
    fields.status = r.status;
    fields.publishAt = r.publishAt;
  }
  const updated = await db.updatePost(id, fields);
  if (!updated) return res.status(404).json({ error: "Post not found" });
  res.json(updated);
});

app.delete("/api/admin/posts/:id", requireAuth, async (req, res) => {
  const ok = await db.deletePost(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "Post not found" });
  res.json({ ok: true });
});

// SPA fallback.
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`ThoughtLog running on http://localhost:${PORT}`);
  startScheduler();
});
