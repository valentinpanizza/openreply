/**
 * Checks around the model, in code, so a message built to manipulate it
 * cannot make it say something the owner would not. Before: a message that
 * looks like an attempt to override its instructions is not answered at all.
 * After: an answer that talks about money or prices, or says it is an AI, is
 * not sent. Either way the owner gets the conversation.
 */

const INJECTION = [
  /\b(ignor[aáe]\w*|olvid[aáe]\w*|saltea\w*|desobedec\w*)\b.{0,40}\b(instrucci\w*|reglas?|indicaciones|prompt|lo anterior|todo lo que)/i,
  /\bignore\b.{0,30}\b(instructions?|rules|previous|above|prompt)/i,
  /\b(system\s*prompt|prompt del sistema|tu prompt|tus instrucciones)\b/i,
  /\b(a partir de ahora|desde ahora)\b.{0,30}\b(sos|eres|actu[aá]|respond[eé])/i,
  /\b(modo desarrollador|developer mode|jailbreak|DAN)\b/,
  /\b(you are now|act as|pretend (to be|you are))\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION.some((pattern) => pattern.test(text));
}

const FORBIDDEN_OUTPUT: { pattern: RegExp; reason: string }[] = [
  { pattern: /(\$|usd|u\$s|d[oó]lares?|euros?|pesos)\s*\d|\d\s*(\$|usd|u\$s|d[oó]lares?|euros?|pesos)\b/i, reason: "mencionaba un monto de plata" },
  { pattern: /\b(soy|como) (un |una )?(bot|ia|inteligencia artificial|asistente virtual|modelo de lenguaje|chatbot)\b/i, reason: "decía que es una IA" },
  { pattern: /\b(claude|anthropic|openai|chatgpt|gpt-?\d)\b.{0,20}\b(soy|me cre[oó]|me program)/i, reason: "hablaba de cómo está hecho" },
  { pattern: /\b(mis|tus) (instrucciones|reglas)\b|\b(system prompt|prompt del sistema|mi prompt)\b/i, reason: "hablaba de sus instrucciones" },
];

/** Why an answer must not be sent, or null when it is fine. */
export function forbiddenOutput(messages: string[]): string | null {
  for (const message of messages) {
    // The resource link is ours, not something the model wrote.
    const text = message.replace(/https?:\/\/\S+/g, "");
    for (const { pattern, reason } of FORBIDDEN_OUTPUT) if (pattern.test(text)) return reason;
  }
  return null;
}
