/**
 * Publish the next trial reel from the OpenCloud queue right away, without
 * waiting for the schedule or TRIAL_PUBLISH_ENABLED. With DRY=1 it only shows
 * what would go out (file, caption, campaign name) and the day's slots.
 *
 *   DRY=1 npx tsx scripts/trial-publish.ts
 *   npx tsx scripts/trial-publish.ts
 */
import { runTrialPublisher } from "@/lib/trials/publisher";
import { getRedisConnection } from "@/lib/queue/client";
import { prisma } from "@/lib/db/client";

async function main() {
  const result = await runTrialPublisher({ force: true, dryRun: process.env.DRY === "1" });
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
