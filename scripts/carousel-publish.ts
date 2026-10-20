/**
 * Publish the next carousel from the OpenCloud queue right away, without
 * waiting for the schedule or CAROUSEL_PUBLISH_ENABLED. With DRY=1 it only
 * shows what would go out (folder, slides, caption, campaign) and when the
 * next one is due.
 *
 *   DRY=1 npx tsx scripts/carousel-publish.ts
 *   npx tsx scripts/carousel-publish.ts
 */
import { runCarouselPublisher } from "@/lib/carousels/publisher";
import { getRedisConnection } from "@/lib/queue/client";
import { prisma } from "@/lib/db/client";

async function main() {
  const result = await runCarouselPublisher({ force: true, dryRun: process.env.DRY === "1" });
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
