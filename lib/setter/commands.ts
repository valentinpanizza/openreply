import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";
import { setterEnabled } from "./config";
import { resumeSetter, silenceSetter } from "./engine";
import { chatLink, commandTopic, notifyOwner, ntfyBase } from "./notify";

/**
 * Commands from the owner's phone: the buttons on the setter's pings post
 * "callar <id>" or "seguir <id>" to the command topic (notify.ts), and he can
 * type "callar @usuario" there by hand. The worker reads the topic every few
 * seconds and applies them.
 */

const LAST_KEY = "setter:commands:last";

export type SetterCommand = { action: "callar" | "seguir"; target: string };

export function parseCommand(text: string): SetterCommand | null {
  const match = /^\s*(callar|seguir)\s+@?([\w.]+)\s*$/i.exec(text);
  return match ? { action: match[1].toLowerCase() as SetterCommand["action"], target: match[2] } : null;
}

async function conversationFor(target: string) {
  return (
    (await prisma.setterConversation.findUnique({ where: { id: target } })) ??
    (await prisma.setterConversation.findFirst({
      where: { username: { equals: target, mode: "insensitive" } },
      orderBy: { updatedAt: "desc" },
    }))
  );
}

async function runCommand(text: string): Promise<void> {
  const command = parseCommand(text);
  if (!command) {
    await notifyOwner({
      title: "No entendí el comando",
      message: `"${text.slice(0, 80)}". Escribí "callar @usuario" o "seguir @usuario".`,
      tags: ["question"],
    });
    return;
  }
  const conversation = await conversationFor(command.target);
  if (!conversation) {
    await notifyOwner({
      title: "No encontré esa charla",
      message: `El agente no habló con ${command.target}.`,
      tags: ["question"],
    });
    return;
  }
  const who = conversation.username ? `@${conversation.username}` : "esa persona";
  if (command.action === "callar") {
    await silenceSetter(conversation, "Callado desde el celular");
    await notifyOwner({
      title: `Listo: el agente no le habla más a ${who}`,
      message: "La charla queda en tus manos aunque le escribas. Para que vuelva: el botón \"Que siga el agente\" o \"seguir\".",
      tags: ["mute"],
      click: chatLink(conversation.username),
    });
  } else {
    await resumeSetter(conversation);
    await notifyOwner({
      title: `Listo: el agente sigue con ${who}`,
      message: "Si quedó un mensaje suyo sin contestar, le contesta ahora.",
      tags: ["robot"],
      click: chatLink(conversation.username),
    });
  }
}

/** Read and apply what came in since the last read. */
export async function pollSetterCommands(): Promise<void> {
  const topic = commandTopic();
  if (!topic || !setterEnabled()) return;
  const redis = getRedisConnection();
  // By time, not by message id: an id ntfy no longer keeps would bring back
  // every cached message. Same-second messages come again, skipped by id.
  let last = JSON.parse((await redis.get(LAST_KEY)) ?? "null") as { time: number; ids: string[] } | null;
  const since = last ? String(last.time) : "10m";
  const response = await fetch(`${ntfyBase()}/${topic}/json?poll=1&since=${since}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`ntfy HTTP ${response.status}`);
  const events = (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; time: number; event: string; message?: string })
    .filter((event) => event.event === "message" && !last?.ids.includes(event.id));

  for (const event of events) {
    // Marked before it runs: a command that fails is not repeated forever.
    last = { time: event.time, ids: last?.time === event.time ? [...last.ids, event.id] : [event.id] };
    await redis.set(LAST_KEY, JSON.stringify(last), "EX", 7 * 24 * 3600);
    await runCommand(event.message ?? "");
  }
}
