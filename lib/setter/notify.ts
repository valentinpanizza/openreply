// A ping to the owner's phone (ntfy, NTFY_TOPIC). Never throws.
export async function notifyOwner(body: {
  title: string;
  message: string;
  tags?: string[];
  click?: string;
  actions?: NtfyAction[];
}): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const response = await fetch(ntfyBase(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) console.log(`[Setter] ntfy ping failed: HTTP ${response.status}`);
  } catch (error) {
    console.log("[Setter] ntfy ping failed:", error instanceof Error ? error.message : error);
  }
}

export function chatLink(username: string | null | undefined): string {
  return username ? `https://ig.me/m/${username}` : "https://www.instagram.com/direct/inbox/";
}

export function ntfyBase(): string {
  return (process.env.NTFY_URL ?? "https://ntfy.sh").replace(/\/+$/, "");
}

/**
 * Where the buttons on the owner's pings post their command (read by
 * commands.ts): his topic plus a suffix, as private as the topic itself. He can
 * also subscribe to it in the ntfy app and type a command by hand.
 */
export function commandTopic(): string | null {
  const topic = process.env.NTFY_TOPIC;
  return topic ? `${topic}-setter` : null;
}

interface NtfyAction {
  action: "http";
  label: string;
  url: string;
  method: "POST";
  body: string;
  clear: boolean;
}

/** Buttons to silence the setter with someone, or hand them back to it. */
export function setterButtons(conversationId: string): NtfyAction[] | undefined {
  const topic = commandTopic();
  if (!topic) return undefined;
  const button = (label: string, command: string): NtfyAction => ({
    action: "http",
    label,
    url: `${ntfyBase()}/${topic}`,
    method: "POST",
    body: `${command} ${conversationId}`,
    clear: true,
  });
  return [button("Callar al agente", "callar"), button("Que siga el agente", "seguir")];
}
