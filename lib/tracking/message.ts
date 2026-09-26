export interface MessageTrackedLink {
  slug: string;
  destinationUrl: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

function trimTrailingPunctuation(url: string) {
  return url.replace(/[.,!?;:]+$/, "");
}

export function extractFirstUrl(message: string): string | null {
  const match = message.match(URL_PATTERN);
  if (!match) return null;

  try {
    const url = trimTrailingPunctuation(match[0]);
    return new URL(url).toString();
  } catch {
    return null;
  }
}

export function replaceUrlWithTrackedPlaceholder(
  message: string,
  destinationUrl: string | null | undefined
) {
  if (!destinationUrl) return message;
  if (message.includes(destinationUrl)) {
    return message.replace(destinationUrl, "{link}");
  }

  const withoutTrailingSlash = destinationUrl.replace(/\/$/, "");
  return message.replace(withoutTrailingSlash, "{link}");
}

// A {a|b|c} group picks one option at random on every render, so a campaign
// does not send byte-identical text to everyone who comments: identical
// messages to many strangers are what spam filters look for. Groups cannot
// nest, but a {username} inside one works, because names are filled in first.
const VARIANT_GROUP = /\{([^{}]*\|[^{}]*)\}/g;

export function pickVariants(message: string, random: () => number = Math.random) {
  return message.replace(VARIANT_GROUP, (_, options: string) => {
    const choices = options.split("|");
    return choices[Math.floor(random() * choices.length)];
  });
}

// Without a name, drop the placeholder and the space before it ("Hola
// {username}!" -> "Hola!") instead of inserting a stand-in word, which read
// as "Hola there!" in any language but English.
function fillUsername(message: string, commenterName?: string | null) {
  return commenterName
    ? message.replace(/\{username\}/gi, commenterName)
    : message.replace(/\s*\{username\}/gi, "");
}

/**
 * Personalize {username} and strip the {link} token — used when the link is
 * delivered as a separate button rather than inline in the message text.
 */
export function renderMessageWithoutLink({
  message,
  commenterName,
}: {
  message: string;
  commenterName?: string | null;
}) {
  return pickVariants(fillUsername(message, commenterName))
    .replace(/\s*\{link\}\s*/gi, " ")
    .trim();
}

export function buildTrackedUrl(slug: string, baseUrl?: string) {
  const resolvedBaseUrl =
    baseUrl ??
    (typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXTAUTH_URL ?? "http://localhost:3000");

  return `${resolvedBaseUrl.replace(/\/$/, "")}/r/${slug}`;
}

export function renderMessageWithTracking({
  message,
  commenterName,
  trackedLinks,
  baseUrl,
}: {
  message: string;
  commenterName?: string | null;
  trackedLinks?: MessageTrackedLink[];
  baseUrl?: string;
}) {
  let rendered = pickVariants(fillUsername(message, commenterName));
  const primaryLink = trackedLinks?.[0];

  if (!primaryLink) return rendered;

  const trackedUrl = buildTrackedUrl(primaryLink.slug, baseUrl);

  if (/\{link\}/i.test(rendered)) {
    return rendered.replace(/\{link\}/gi, trackedUrl);
  }

  if (rendered.includes(primaryLink.destinationUrl)) {
    rendered = rendered.replaceAll(primaryLink.destinationUrl, trackedUrl);
  } else {
    const withoutTrailingSlash = primaryLink.destinationUrl.replace(/\/$/, "");
    rendered = rendered.replaceAll(withoutTrailingSlash, trackedUrl);
  }

  return rendered;
}
