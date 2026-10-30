/**
 * Look at and steer the AI setter's conversations.
 *
 *   npx tsx scripts/setter.ts list                 recent conversations
 *   npx tsx scripts/setter.ts show <usuario>       one conversation, with the
 *                                                  comparison model's answers
 *   npx tsx scripts/setter.ts resume <usuario>     hand it back to the setter
 *                                                  (answers what is pending)
 *   npx tsx scripts/setter.ts stop <usuario>       silence it with them, even
 *                                                  after you write by hand
 *   npx tsx scripts/setter.ts prep <usuario>       prompt to prepare the call in
 *                                                  Claude, with the chat so far
 *   npx tsx scripts/setter.ts rescue [--go]        conversations handed over
 *                                                  because Instagram capped the
 *                                                  sends (368), still waiting
 *                                                  for an answer: lists them, and
 *                                                  with --go the setter takes
 *                                                  them back (they go out one at
 *                                                  a time)
 *   npx tsx scripts/setter.ts cost                 today's spend and the cap
 *   npx tsx scripts/setter.ts report [YYYY-MM-DD]  the day's funnel (the one
 *                                                  sent every night)
 *   npx tsx scripts/setter.ts exclude <usuario>    never use the setter with them
 *   npx tsx scripts/setter.ts include <usuario>    undo that
 *   npx tsx scripts/setter.ts excluded             who is excluded
 *   npx tsx scripts/setter.ts context <campaña> [texto]
 *                                                  show or set a campaign's
 *                                                  notes for the setter
 */
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { setterDailyBudgetUsd, ownerTimeZone } from "@/lib/setter/config";
import { spentToday } from "@/lib/setter/budget";
import { SETTER_EXCLUDED_KEY, callPrep, resumeSetter, silenceSetter } from "@/lib/setter/engine";
import { dayReport, formatReport } from "@/lib/setter/report";

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

  if (command === "prep") {
    console.log(await callPrep(await byUsername(arg)));
    return;
  }

  if (command === "resume" || command === "stop") {
    const c = await byUsername(arg);
    if (command === "resume") await resumeSetter(c);
    else await silenceSetter(c, "Pausada a mano");
    console.log(command === "resume" ? `El setter retoma con @${c.username}.` : `El setter deja de contestarle a @${c.username}.`);
    return;
  }

  if (command === "rescue") {
    const go = arg === "--go";
    // Instagram takes an answer only within 24 h of the person's message.
    const rows = await prisma.setterConversation.findMany({
      where: {
        status: "HUMAN",
        statusReason: { contains: "code=368" },
        lastUserAt: { gte: new Date(Date.now() - 22 * 3600_000) },
      },
      orderBy: { lastUserAt: "asc" },
    });
    let count = 0;
    for (const c of rows) {
      const last = await prisma.setterMessage.findFirst({
        where: { conversationId: c.id, role: { in: ["user", "bot", "owner"] } },
        orderBy: { createdAt: "desc" },
      });
      // Already answered, by the setter or by hand.
      if (last?.role !== "user") continue;
      count++;
      console.log(`${fmt(last.createdAt)}  @${c.username ?? c.userId}: ${last.text.slice(0, 70)}`);
      if (go) await resumeSetter(c);
    }
    console.log(go ? `\n${count} charlas retomadas: salen de a una.` : `\n${count} para retomar (rescue --go para hacerlo).`);
    return;
  }

  if (command === "report") {
    console.log(formatReport(await dayReport(arg)));
    return;
  }

  if (command === "cost") {
    console.log(`Hoy: US$ ${(await spentToday()).toFixed(4)} de US$ ${setterDailyBudgetUsd().toFixed(2)}`);
    return;
  }

  if (command === "exclude" || command === "include") {
    if (!arg) throw new Error("Falta el usuario");
    const username = arg.replace(/^@/, "").toLowerCase();
    const redis = getRedisConnection();
    if (command === "include") {
      await redis.srem(SETTER_EXCLUDED_KEY, username);
      console.log(`@${username} vuelve a tener setter en su próximo comentario.`);
      return;
    }
    await redis.sadd(SETTER_EXCLUDED_KEY, username);
    const conversation = await prisma.setterConversation.findFirst({
      where: { username: { equals: username, mode: "insensitive" }, status: { not: "STOPPED" } },
    });
    if (conversation) await silenceSetter(conversation, "Excluido a mano");
    console.log(
      `@${username} excluido: sigue con el flujo de siempre.${conversation ? " Su charla con el setter quedó en tus manos." : ""}`
    );
    return;
  }

  if (command === "excluded") {
    const list = await getRedisConnection().smembers(SETTER_EXCLUDED_KEY);
    console.log(list.length ? list.sort().map((u) => `@${u}`).join("\n") : "Nadie excluido.");
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

  console.log(
    "Comandos: list, show <usuario>, prep <usuario>, resume <usuario>, stop <usuario>, rescue [--go], cost, exclude <usuario>, include <usuario>, excluded, context <campaña> [texto]"
  );
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
