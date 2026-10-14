// A ping to the owner's phone (ntfy, NTFY_TOPIC). Never throws.
export async function notifyOwner(body: {
  title: string;
  message: string;
  tags?: string[];
  click?: string;
}): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  try {
    const response = await fetch(process.env.NTFY_URL ?? "https://ntfy.sh", {
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
