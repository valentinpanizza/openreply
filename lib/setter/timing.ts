/**
 * When the setter answers. Someone who answers right away is in the chat, so
 * the setter answers quickly too and the conversation flows; someone who comes
 * back later gets a reply a minute or two later, the way a person would see it
 * and answer. Every reply also waits a little for the rest of a burst ("hola",
 * "sí", "tengo una inmobiliaria") so it answers all of it at once.
 */

const ACTIVE_CHAT_MS = 3 * 60_000;

export function replyDelayMs(
  lastBotAt: Date | null,
  now: Date,
  random: () => number = Math.random
): number {
  const inChat = lastBotAt !== null && now.getTime() - lastBotAt.getTime() < ACTIVE_CHAT_MS;
  const [min, max] = inChat ? [12_000, 35_000] : [45_000, 150_000];
  return Math.round(min + random() * (max - min));
}

// The pause before each message after the first: about what typing it takes.
export function typingDelayMs(text: string, random: () => number = Math.random): number {
  return Math.min(9_000, 1_500 + text.length * 45 + random() * 1_500);
}
