// ---------------------------------------------------------------------------
// scheduler.js — Background job for scheduled publishing.
//
// Every minute it asks the database: "any scheduled posts whose publish_at has
// passed?" and flips them to published. This is a simple, dependency-free
// in-process scheduler — fine for a single-instance blog. (At larger scale
// you'd move this to a dedicated worker or a cron service so it doesn't run
// once per app instance.)
// ---------------------------------------------------------------------------

import { publishDuePosts } from "./db.js";

const INTERVAL_MS = 60 * 1000; // check every minute

async function tick() {
  try {
    const published = await publishDuePosts();
    if (published.length > 0) {
      for (const p of published) {
        console.log(`[scheduler] published "${p.title}" (/${p.slug})`);
      }
    }
  } catch (err) {
    // Never let a transient DB error kill the loop.
    console.error("[scheduler] tick failed:", err.message);
  }
}

export function startScheduler() {
  // Run once at boot (catches anything due while the server was down),
  // then on a fixed interval.
  tick();
  setInterval(tick, INTERVAL_MS);
  console.log("[scheduler] started — checking every minute for due posts");
}
