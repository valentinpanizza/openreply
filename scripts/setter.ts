/**
 * Look at and steer the AI setter's conversations.
 *
 *   npx tsx scripts/setter.ts list                 recent conversations
 *   npx tsx scripts/setter.ts show <usuario>       one conversation, with the
 *                                                  comparison model's answers
 *   npx tsx scripts/setter.ts resume <usuario>     hand it back to the setter
 *   npx tsx scripts/setter.ts stop <usuario>       take it over (setter quiet)
 *   npx tsx scripts/setter.ts cost                 today's spend and the cap
 *   npx tsx scripts/setter.ts context <campaña> [texto]
 *                                                  show or set a campaign's
 *                                                  notes for the setter
 */
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { setterDailyBudgetUsd, ownerTimeZone } from "@/lib/setter/config";
import { spentToday } from "@/lib/setter/budget";

const fmt = (at: Date | null) =>
  at
    ? new Intl.DateTimeFormat("es-UY", {
        timeZone: ownerTimeZone(),
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(at)
    : "-";

async function byUsername(username: string | undefined) {
  if (!username) throw new Error("Falta el usuario");
  const conversation = await prisma.setterConversation.findFirst({
    where: { username: { equals: username.replace(/^@/, ""), mode: "insensitive" } },
    orderBy: { updatedAt: "desc" },
  });
  if (!conversation) throw new Error(`No hay charla del setter con ${username}`);
  return conversation;
}

async function main() {
  const [command, arg, ...rest] = process.argv.slice(2);

  if (command === "list") {
    const rows = await prisma.setterConversation.findMany({ orderBy: { updatedAt: "desc" }, take: 30 });
    for (const c of rows) {
      console.log(
        `${fmt(c.updatedAt)}  @${c.username ?? c.userId}  ${c.status}  fase=${c.phase}${c.callAt ? `  llamada=${fmt(c.callAt)}` : ""}`
      );
    }
    return;
  }

  if (command === "show") {
    const c = await byUsername(arg);
    console.log(`@${c.username}  ${c.status}${c.statusReason ? ` (${c.statusReason})` : ""}  fase=${c.phase}`);
    console.log(`zona=${c.timezone ?? "-"}  mail=${c.email ?? "-"}  llamada=${fmt(c.callAt)}  recurso=${fmt(c.resourceSentAt)}`);
    console.log(`notas: ${c.notes ?? "-"}\n`);
    const messages = await prisma.setterMessage.findMany({
      where: { conversationId: c.id },
      orderBy: { createdAt: "asc" },
    });
    const who: Record<string, string> = { user: "persona", bot: "setter", owner: "vos", shadow: "  (comparación)" };
    let cost = 0;
    for (const m of messages) {
      cost += m.costUsd ?? 0;
      const model = m.model && m.role !== "user" ? ` [${m.model.replace("claude-", "")}]` : "";
      console.log(`${fmt(m.createdAt)} ${who[m.role] ?? m.role}${model}: ${m.text}`);
    }
    console.log(`\ncosto de esta charla: US$ ${cost.toFixed(4)}`);
    return;
  }

  if (command === "resume" || command === "stop") {
    const c = await byUsername(arg);
    await prisma.setterConversation.update({
      where: { id: c.id },
      data:
        command === "resume"
          ? { status: "ACTIVE", statusReason: null }
          : { status: "HUMAN", statusReason: "Pausada a mano" },
    });
    if (command === "stop") await getRedisConnection().del(`setter:token:${c.id}`);
    console.log(command === "resume" ? `El setter retoma con @${c.username} cuando escriba.` : `El setter deja de contestarle a @${c.username}.`);
    return;
  }

  if (command === "cost") {
    console.log(`Hoy: US$ ${(await spentToday()).toFixed(4)} de US$ ${setterDailyBudgetUsd().toFixed(2)}`);
    return;
  }

  if (command === "context") {
    if (!arg) throw new Error("Falta el nombre de la campaña");
    const campaign = await prisma.automation.findFirst({
      where: { name: { contains: arg, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
    });
    if (!campaign) throw new Error(`No hay campaña que se llame ${arg}`);
    const text = rest.join(" ").trim();
    if (text) {
      await prisma.automation.update({ where: { id: campaign.id }, data: { setterContext: text } });
      await getRedisConnection().del(`setter:ctx:${campaign.id}`);
      console.log(`Notas del setter guardadas en "${campaign.name}".`);
    } else {
      console.log(`${campaign.name}: ${campaign.setterContext ?? "(sin notas)"}`);
    }
    return;
  }

  console.log("Comandos: list, show <usuario>, resume <usuario>, stop <usuario>, cost, context <campaña> [texto]");
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
