// ---------------------------------------------------------------------------
// index.js — HTTP server + API
//
// Serves the front-end, exposes a JSON API, renders Markdown server-side, and
// starts the background scheduler for timed publishing.
//
// Route map:
//   PUBLIC
//     GET  /api/posts                  list published posts
//     GET  /api/posts/:slug            one post (rendered) + view++ + related
//                                       + comments + reactions + rating
//     POST /api/posts/:slug/comments   add a comment (no login)
//     POST /api/posts/:slug/react      toggle an emoji reaction (no login)
//     POST /api/subscribe              add an email to the newsletter list
//     GET  /api/search?q=              full-text search
//     GET  /api/tags                   tag cloud with counts
//     GET  /api/tags/:tag              posts for one tag
//     GET  /rss.xml                    RSS 2.0 feed
//   AUTH
//     POST /api/login  /api/logout  GET /api/me
//   ADMIN (requireAuth)
//     GET    /api/admin/posts          all posts incl. drafts/scheduled
//     GET    /api/admin/posts/:id      one full post (for the editor)
//     GET    /api/admin/stats          dashboard counts
//     GET    /api/admin/top-posts      most-viewed published posts
//     GET    /api/admin/subscribers    newsletter subscriber list
//     POST   /api/admin/posts          create
//     PUT    /api/admin/posts/:id      update
//     DELETE /api/admin/posts/:id      delete
//     DELETE /api/admin/comments/:id   remove a comment
//     POST   /api/admin/preview        render Markdown -> HTML (live preview)
//     POST   /api/admin/upload         upload an image (cover or inline)
// ---------------------------------------------------------------------------

import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { marked } from "marked";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import crypto from "crypto";

import * as db from "./db.js";
import { hashPassword, verifyPassword, signToken, requireAuth } from "./auth.js";
import { startScheduler } from "./scheduler.js";
import { upload, processAndSave } from "./uploads.js";
import { buildRssFeed } from "./rss.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(join(__dirname, "..", "public")));

// Anonymous visitor ID: a long-lived random cookie, separate from the
// view-tracking cookie. This is what lets a single browser "have" a set of
// emoji reactions without any login — same idea as a shopping-cart ID.
function ensureVisitorId(req, res) {
  let vid = req.cookies?.tl_vid;
  if (!vid) {
    vid = crypto.randomBytes(16).toString("hex");
    res.cookie("tl_vid", vid, {
      httpOnly: true, sameSite: "lax", maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  return vid;
}

const ALLOWED_EMOJI = new Set(["👍", "❤️", "🔥", "😮", "😂", "🤔"]);

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

// RSS feed — standard XML, not under /api so feed readers get a clean URL.
app.get("/rss.xml", async (req, res) => {
  const posts = await db.listPublishedPosts();
  const origin = `${req.protocol}://${req.get("host")}`;
  res.set("Content-Type", "application/rss+xml; charset=utf-8");
  res.send(buildRssFeed(posts, origin));
});

app.get("/api/posts/:slug", async (req, res) => {
  const post = await db.getPostBySlug(req.params.slug);
  const isLive =
    post && post.status === "published" &&
    (!post.publishAt || post.publishAt <= Date.now());
  if (!post || !isLive) return res.status(404).json({ error: "Post not found" });

  // View counting: one view per browser per post per 24h, tracked via a
  // signed-ish cookie (a set of "slug:expiry" pairs). Refreshing or spam-
  // clicking the same post in the same browser within the window no longer
  // inflates the count — it only goes up for a genuinely new visit.
  const seenCookieName = "tl_seen";
  const raw = req.cookies?.[seenCookieName] || "";
  const now = Date.now();
  const entries = raw.split(",").filter(Boolean).map((e) => {
    const [s, exp] = e.split(":");
    return { slug: s, exp: Number(exp) };
  }).filter((e) => e.exp > now); // drop expired entries as we go

  const alreadySeen = entries.some((e) => e.slug === post.slug);
  let views = post.views;

  if (!alreadySeen) {
    await db.incrementViews(req.params.slug);
    views = post.views + 1;
    entries.push({ slug: post.slug, exp: now + 24 * 60 * 60 * 1000 });
    const nextCookie = entries.map((e) => `${e.slug}:${e.exp}`).join(",");
    res.cookie(seenCookieName, nextCookie, {
      httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  const related = await db.relatedPosts(post.id, post.tags, 3);
  const visitorId = ensureVisitorId(req, res);
  const [comments, reactions, myReactions, rating] = await Promise.all([
    db.listComments(post.id),
    db.reactionCounts(post.id),
    db.visitorReactions(post.id, visitorId),
    db.ratingSummary(post.id),
  ]);

  res.json({
    ...post,
    views,
    html: marked.parse(post.body),
    related,
    comments,
    reactions,
    myReactions,
    rating,
  });
});

// --- Comments (no login required) ------------------------------------------

app.post("/api/posts/:slug/comments", async (req, res) => {
  const post = await db.getPostBySlug(req.params.slug);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const { author, email, body, rating } = req.body || {};
  if (!author?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "Name and comment are required" });
  }
  if (body.trim().length > 2000) {
    return res.status(400).json({ error: "Comment is too long (2000 characters max)" });
  }
  if (rating !== undefined && rating !== null && (rating < 1 || rating > 5)) {
    return res.status(400).json({ error: "Rating must be between 1 and 5" });
  }

  const comment = await db.createComment({
    postId: post.id,
    author: author.trim().slice(0, 80),
    email: email?.trim().slice(0, 200) || null,
    body: body.trim(),
    rating: rating ? Number(rating) : null,
  });
  res.status(201).json(comment);
});

// --- Reactions (no login required) ------------------------------------------

app.post("/api/posts/:slug/react", async (req, res) => {
  const post = await db.getPostBySlug(req.params.slug);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const { emoji } = req.body || {};
  if (!ALLOWED_EMOJI.has(emoji)) {
    return res.status(400).json({ error: "Unsupported reaction" });
  }
  const visitorId = ensureVisitorId(req, res);
  const result = await db.toggleReaction(post.id, visitorId, emoji);
  res.json(result);
});

// --- Newsletter --------------------------------------------------------------

app.post("/api/subscribe", async (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!valid) return res.status(400).json({ error: "Enter a valid email address" });

  const ok = await db.addSubscriber(email);
  if (!ok) return res.status(500).json({ error: "Could not save your subscription" });
  res.status(201).json({ ok: true });
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

app.get("/api/admin/top-posts", requireAuth, async (req, res) => {
  res.json(await db.topPosts(5));
});

app.delete("/api/admin/comments/:id", requireAuth, async (req, res) => {
  const ok = await db.deleteComment(Number(req.params.id));
  if (!ok) return res.status(404).json({ error: "Comment not found" });
  res.json({ ok: true });
});

app.get("/api/admin/subscribers", requireAuth, async (req, res) => {
  res.json(await db.listSubscribers());
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

// Image upload — used for both the cover-image picker and inline images
// dropped into the markdown editor. multer holds the file in memory (see
// uploads.js); processAndSave() re-encodes it to WebP and writes it to
// disk, then we hand back the public URL the front-end either stores as
// coverImage or splices into the body as ![](url).
app.post("/api/admin/upload", requireAuth, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed" });
    if (!req.file) return res.status(400).json({ error: "No image received" });
    try {
      const url = await processAndSave(req.file.buffer);
      res.json({ url });
    } catch {
      res.status(500).json({ error: "Could not process image" });
    }
  });
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