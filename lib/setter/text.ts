/**
 * How the setter's messages look: all lowercase, no emojis, no opening ¿ ¡,
 * no long dashes, the way people actually type in a DM. Links and email
 * addresses keep their case, since a lowercased path can break a link.
 */

const KEEP_CASE = /(https?:\/\/\S+|\S+@\S+\.\S+|\{link\})/gi;
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu;

export function humanize(text: string): string {
  const parts = text.split(KEEP_CASE);
  const out = parts
    .map((part, index) =>
      // split() with a capturing group puts the kept tokens at odd indexes.
      index % 2 === 1
        ? part
        : part
            .replace(EMOJI, "")
            .replace(/[¿¡]/g, "")
            .replace(/\s*[—–]\s*/g, ", ")
            .toLocaleLowerCase("es")
    )
    .join("");
  return out.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?])/g, "$1").trim();
}

/** A transcript line for the model: what an attachment-only message was. */
export function describeAttachment(type: string | undefined): string {
  switch (type) {
    case "audio":
      return "[mandó un audio de voz]";
    case "image":
      return "[mandó una foto]";
    case "video":
      return "[mandó un video]";
    case "share":
    case "ig_reel":
    case "reel":
      return "[compartió una publicación]";
    case "story_mention":
      return "[te mencionó en una historia]";
    default:
      return "[mandó un archivo]";
  }
}
