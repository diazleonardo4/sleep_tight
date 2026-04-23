// One-off cleanup for events emitted by known internal/test visitor_ids
// before the /api/track ingest filter was added.
//
// Usage:
//   # Pull env from Vercel first so REDIS_URL + INTERNAL_VISITOR_IDS match prod
//   vercel env pull .env.local
//
//   # 1. Dry run — prints what would change, touches nothing
//   node --env-file=.env.local scripts/cleanup-internal-visitors.js
//
//   # 2. Apply — actually performs ZREM + DECRBY + DEL
//   DRY_RUN=0 node --env-file=.env.local scripts/cleanup-internal-visitors.js
//
// What it does (per visitor_id in INTERNAL_VISITOR_IDS):
//   1. Walks every `events:<date>` ZSET, ZREMs any member whose parsed
//      visitor_id matches.
//   2. DECRBYs the matching counter keys that api/track.js writes:
//        count:<date>:<event>
//        count:<date>:<event>:utm_content:<v>   (when present)
//        count:<date>:<event>:utm_placement:<v> (when present)
//      utm_source / utm_medium / utm_campaign are NOT decremented because
//      api/track.js does not write those counters.
//   3. DELs the per-visitor aggregates:
//        visitor:<vid>:events   (hash)
//        visitor:<vid>:dates    (set)
//
// What it intentionally does NOT touch:
//   - uniques:<date>  — HyperLogLog. Not reversible without rebuilding from
//     raw events. The dashboard's unique-visitor count will drift correct
//     as days age out of the 90-day event TTL.
//   - rl:*, rate-limit keys. They expire in 60s anyway.
//
// Safety: DRY_RUN defaults to "1". You must explicitly set DRY_RUN=0 to
// apply changes.

const Redis = require('ioredis');

const INTERNAL_VISITOR_IDS = (process.env.INTERNAL_VISITOR_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DRY_RUN = process.env.DRY_RUN !== '0';

if (INTERNAL_VISITOR_IDS.length === 0) {
  console.log('INTERNAL_VISITOR_IDS is empty. Nothing to clean.');
  process.exit(0);
}
if (!process.env.REDIS_URL) {
  console.error('REDIS_URL is not set. Run `vercel env pull .env.local` first.');
  process.exit(1);
}

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
});

const INTERNAL = new Set(INTERNAL_VISITOR_IDS);

async function cleanup() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY (writing to Redis)'}`);
  console.log(`Targets: ${INTERNAL_VISITOR_IDS.join(', ')}`);
  console.log('');

  // 1. Scan every events:<date> ZSET key.
  const eventKeys = [];
  const stream = redis.scanStream({ match: 'events:*', count: 200 });
  for await (const batch of stream) {
    for (const k of batch) eventKeys.push(k);
  }
  eventKeys.sort();
  console.log(`Scanning ${eventKeys.length} event date keys...`);

  let totalEventsRemoved = 0;
  const removalsByKey = {};        // events:<date> → number removed
  const decrements = {};           // count:... → amount to DECRBY
  const perVidEventCounts = {};    // vid → total events seen
  INTERNAL_VISITOR_IDS.forEach(v => { perVidEventCounts[v] = 0; });

  for (const key of eventKeys) {
    const date = key.replace(/^events:/, '');
    const members = await redis.zrange(key, 0, -1);
    const toRemove = [];

    for (const member of members) {
      let parsed;
      try { parsed = JSON.parse(member); } catch (_) { continue; }
      const vid = parsed && parsed.visitor_id;
      if (!vid || !INTERNAL.has(vid)) continue;

      toRemove.push(member);
      perVidEventCounts[vid]++;

      const name = parsed.event;
      if (!name) continue;

      bump(decrements, `count:${date}:${name}`);
      if (parsed.utm_content) {
        bump(decrements, `count:${date}:${name}:utm_content:${parsed.utm_content}`);
      }
      if (parsed.utm_placement) {
        bump(decrements, `count:${date}:${name}:utm_placement:${parsed.utm_placement}`);
      }
    }

    if (toRemove.length > 0) {
      removalsByKey[key] = toRemove.length;
      totalEventsRemoved += toRemove.length;
      if (!DRY_RUN) {
        // ZREM accepts variadic members; chunk to keep the command size sane.
        const CHUNK = 200;
        for (let i = 0; i < toRemove.length; i += CHUNK) {
          await redis.zrem(key, ...toRemove.slice(i, i + CHUNK));
        }
      }
    }
  }

  // 2. Per-visitor aggregates.
  const visitorKeysToDelete = [];
  for (const vid of INTERNAL_VISITOR_IDS) {
    visitorKeysToDelete.push(`visitor:${vid}:events`);
    visitorKeysToDelete.push(`visitor:${vid}:dates`);
  }

  // 3. Print plan.
  console.log('');
  console.log('--- Removal plan ---');
  const removedDates = Object.keys(removalsByKey).sort();
  if (removedDates.length === 0) {
    console.log('  (no matching events found)');
  } else {
    for (const k of removedDates) {
      console.log(`  ZREM ${k.padEnd(26)} × ${removalsByKey[k]}`);
    }
  }
  console.log('');
  console.log('--- Counter decrements ---');
  const counterKeys = Object.keys(decrements).sort();
  if (counterKeys.length === 0) {
    console.log('  (none)');
  } else {
    for (const k of counterKeys) {
      console.log(`  DECRBY ${k.padEnd(58)} -${decrements[k]}`);
    }
  }
  console.log('');
  console.log('--- Per-visitor aggregates to DEL ---');
  for (const k of visitorKeysToDelete) console.log(`  DEL ${k}`);
  console.log('');

  // 4. Apply counter decrements + visitor key deletions.
  if (!DRY_RUN && counterKeys.length > 0) {
    const pipeline = redis.pipeline();
    for (const [k, amount] of Object.entries(decrements)) {
      pipeline.decrby(k, amount);
    }
    await pipeline.exec();
  }
  if (!DRY_RUN && visitorKeysToDelete.length > 0) {
    await redis.del(...visitorKeysToDelete);
  }

  // 5. Summary.
  console.log('--- Summary ---');
  console.log(`Events ${DRY_RUN ? 'that would be' : ''} removed: ${totalEventsRemoved}`);
  console.log(`Date keys touched:                 ${Object.keys(removalsByKey).length}`);
  console.log(`Counter keys ${DRY_RUN ? 'that would be' : ''} decremented: ${counterKeys.length}`);
  console.log(`Visitor aggregates ${DRY_RUN ? 'that would be' : ''} deleted: ${visitorKeysToDelete.length}`);
  console.log('');
  for (const vid of INTERNAL_VISITOR_IDS) {
    console.log(`  ${vid}: ${perVidEventCounts[vid]} events`);
  }
  console.log('');
  if (DRY_RUN) {
    console.log('DRY RUN — nothing was written. Re-run with DRY_RUN=0 to apply.');
  } else {
    console.log('Done. Note: HyperLogLog uniques:<date> keys were left as-is (approximate, not reversible).');
  }
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

cleanup()
  .then(() => redis.quit())
  .catch(err => {
    console.error('Cleanup failed:', err);
    redis.quit().finally(() => process.exit(1));
  });
