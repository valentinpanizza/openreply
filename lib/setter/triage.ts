/**
 * Two calls made without asking the model, so the daily cap (quota.ts) goes to
 * the people worth a call (24/11: it ran out at 18:20 and the "sí" of real
 * estate agents waited for the morning behind goodbyes).
 */

const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const REAL_ESTATE_USER =
  /inmobili|inmueble|propiedades|bienes_?\.?raices|bienesraices|finca_?\.?raiz|realty|real_?\.?estate|remax|re\.max|broker|century21|kellerwilliams|martiller|tasador/;

/** A real estate account (by its username) that came from the Tasacion reel. */
export function evidentBusiness(username: string | null, campaignName: string | null | undefined): boolean {
  if (!username || !campaignName || !plain(campaignName).includes("tasacion")) return false;
  return REAL_ESTATE_USER.test(plain(username));
}

const THANKS_WORDS = new Set(
  (
    "gracias graciass graciasss grax muchas muchisimas mil totales ok oka okey dale listo genial buenisimo barbaro " +
    "perfecto joya de nada igualmente saludos abrazo un bro crack capo hermano amigo valentin vale che te lo agradezco"
  ).split(" ")
);

/** Only a thank-you, an ok or emojis: nothing in it to answer. */
export function justThanks(text: string): boolean {
  if (text.includes("?") || text.includes("[")) return false;
  const words = plain(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length <= 8 && words.every((word) => THANKS_WORDS.has(word.replace(/s{2,}$/, "s")));
}
