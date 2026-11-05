/**
 * Publish the next reel from the OpenCloud queue right away, without waiting
 * for the schedule or REEL_PUBLISH_ENABLED. With DRY=1 it only shows what would
 * go out (folder, video, caption, campaign) and when the next one is due.
 *
 *   DRY=1 npx tsx scripts/reel-publish.ts
 *   npx tsx scripts/reel-publish.ts
 */
import { runReelPublisher } from "@/lib/reels/publisher";
import { getRedisConnection } from "@/lib/queue/client";
import { prisma } from "@/lib/db/client";

async function main() {
  const result = await runReelPublisher({ force: true, dryRun: process.env.DRY === "1" });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    getRedisConnection().disconnect();
  });
