/**
 * Publish the next reel from the OpenCloud queue right away, without waiting
 * for the schedule or REEL_PUBLISH_ENABLED. With DRY=1 it only shows what would
 * go out (folder, video, caption, campaign) and when the next one is due.
 *
 * For the agency's account (lib/publishing/profile.ts), add "agencia"; "--dry"
 * works like DRY=1 and, being an argument, always reaches the container:
 *
 *   npx tsx scripts/reel-publish.ts agencia --dry
 *   npx tsx scripts/reel-publish.ts agencia
 *
 *   DRY=1 npx tsx scripts/reel-publish.ts
 *   npx tsx scripts/reel-publish.ts
 */
import { runReelPublisher } from "@/lib/reels/publisher";
import { getRedisConnection } from "@/lib/queue/client";
import { prisma } from "@/lib/db/client";
import { withProfile } from "@/lib/publishing/profile";

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "agencia" && arg !== "--dry");
  if (unknown.length) throw new Error(`No entiendo ${unknown.join(" ")}: solo "agencia" y "--dry"`);
  const dryRun = process.env.DRY === "1" || args.includes("--dry");
  const profile = args.includes("agencia") ? "agency" : "owner";
  console.log(`${profile === "agency" ? "Cuenta de la agencia" : "Tu cuenta"}${dryRun ? " (solo mirar)" : ""}`);
  const result = await withProfile(profile, () => runReelPublisher({ force: true, dryRun }));
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
