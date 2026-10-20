/**
 * Read only: the account's reels ranked by how far they went, as JSON, so the
 * owner (or Claude, with /carrusel-nuevo) can pick the next one to turn into a
 * carousel. Ranked by shares and saves first (what a carousel lives on), then
 * views.
 *
 *   npx tsx scripts/top-reels.ts            # top 15 of the last 200 posts
 *   TOP=30 MAX=500 npx tsx scripts/top-reels.ts
 */
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { decryptToken } from "@/lib/meta/oauth";
import { getAllUserMedia, getMediaInsights } from "@/lib/meta/client";

async function main() {
  const top = Number(process.env.TOP ?? 15);
  const max = Number(process.env.MAX ?? 200);
  const account = await prisma.instagramAccount.findFirst({
    where: { provider: "META" },
    orderBy: { connectedAt: "asc" },
    select: { accessToken: true },
  });
  if (!account) throw new Error("No hay cuenta de Instagram conectada");
  const token = decryptToken(account.accessToken);

  const reels = (await getAllUserMedia(token, max)).filter(
    (media) => media.media_product_type === "REELS" || media.media_type === "VIDEO"
  );
  const rows = [];
  for (const reel of reels) {
    const insights = await getMediaInsights(token, reel.id, ["views", "reach", "saved", "shares", "comments", "likes"]).catch(() => null);
    if (!insights) continue;
    rows.push({
      id: reel.id,
      fecha: reel.timestamp.slice(0, 10),
      link: reel.permalink,
      vistas: insights.views ?? 0,
      alcance: insights.reach ?? 0,
      compartidos: insights.shares ?? 0,
      guardados: insights.saved ?? 0,
      comentarios: insights.comments ?? 0,
      likes: insights.likes ?? 0,
      caption: (reel.caption ?? "").slice(0, 300),
    });
  }
  rows.sort(
    (a, b) =>
      b.compartidos + b.guardados - (a.compartidos + a.guardados) || b.vistas - a.vistas
  );
  console.log(JSON.stringify(rows.slice(0, top), null, 2));
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
