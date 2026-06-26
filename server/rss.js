// ---------------------------------------------------------------------------
// rss.js — RSS 2.0 feed generation.
//
// One function: take the list of published posts and the site's public
// origin (so links in the feed are absolute, as RSS requires), return an
// XML string. No external dependency — RSS 2.0 is simple enough to template
// directly, and that keeps this auditable in one glance.
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildRssFeed(posts, origin) {
  const items = posts
    .map((p) => {
      const url = `${origin}/p/${p.slug}`;
      const pubDate = new Date(p.publishAt || p.createdAt).toUTCString();
      return `    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(p.excerpt || "")}</description>
      ${p.tags.map((t) => `<category>${escapeXml(t)}</category>`).join("\n      ")}
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>ThoughtLog — Rafi Arsya</title>
    <link>${escapeXml(origin)}</link>
    <atom:link href="${escapeXml(origin)}/rss.xml" rel="self" type="application/rss+xml" />
    <description>Notes on what I build and why.</description>
    <language>en</language>
${items}
  </channel>
</rss>`;
}
