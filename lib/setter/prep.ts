/**
 * A prompt for the owner to paste into Claude before a booked call: who the
 * person is and the whole chat, with what to prepare. Plain text, no API call;
 * it goes into a private event on his calendar right before the call, and
 * `scripts/setter.ts prep <usuario>` prints a fresh one.
 */

export interface PrepLine {
  role: "user" | "bot" | "owner";
  text: string;
  at: Date;
}

export interface PrepInput {
  username: string | null;
  email: string | null;
  callAt: Date;
  minutes: number;
  personTimeZone: string | null;
  ownerTimeZone: string;
  reel: string;
  notes: string | null;
  transcript: PrepLine[];
}

// Google Calendar keeps up to ~8k characters in a description.
export const PREP_MAX_CHARS = 7_500;
// The reel context carries the resource page; its start is enough here.
const REEL_MAX_CHARS = 1_500;

function when(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-UY", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

function stamp(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("es-UY", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

export function callPrepPrompt(input: PrepInput, maxChars = PREP_MAX_CHARS): string {
  const who = input.username ? `@${input.username}` : "una persona de instagram";
  const theirTime =
    input.personTimeZone && input.personTimeZone !== input.ownerTimeZone
      ? ` (para la persona: ${when(input.callAt, input.personTimeZone)}, ${input.personTimeZone})`
      : "";

  const head = [
    "Soy Valentín Panizza (@valentinpanizza), de Uruguay. Tengo NodeStudio: armo sistemas con IA y automatizaciones para negocios (contestar mensajes y consultas, turnos y agenda, seguimiento de clientes, reportes, procesos internos) y doy consultorías 1 a 1 a quienes quieren aprender a armar sus propios sistemas.",
    "",
    `Tengo una llamada de ${input.minutes} minutos por Google Meet con ${who} el ${when(input.callAt, input.ownerTimeZone)}, mi hora${theirTime}.${input.email ? ` Mail: ${input.email}.` : ""}`,
    "La persona comentó uno de mis reels y la llamada la agendó mi setter: una IA que habla por DM de Instagram en mi nombre, siguiendo mi guion (situación actual, obstáculo, propuesta de llamada gratis). Abajo está la charla completa.",
    "",
    "Ayudame a preparar la llamada:",
    "1. Resumen de la persona en 3 o 4 líneas: quién es, qué negocio tiene o qué quiere aprender, qué le duele y qué intentó.",
    "2. Qué le automatizaría primero y por qué: 1 a 3 ideas concretas para su caso, y cómo las armaría por arriba.",
    "3. Preguntas para hacerle en la llamada, para entender su caso y ver si califica (volumen, urgencia, presupuesto, quién decide).",
    "4. Objeciones probables y cómo responderlas.",
    "5. Cómo cerrar: qué le propondría al final (sistema a medida o consultoría 1 a 1) y cómo plantearlo.",
    "Si falta información para algún punto, decímelo y decime qué preguntarle. No inventes datos que no estén en la charla.",
    "",
    `<reel_que_comento>\n${input.reel.trim().slice(0, REEL_MAX_CHARS) || "(sin datos)"}\n</reel_que_comento>`,
    "",
    `<notas_del_setter>\n${input.notes?.trim() || "(sin notas)"}\n</notas_del_setter>`,
  ].join("\n");

  const label = { user: "persona", bot: "setter", owner: "yo (a mano)" } as const;
  const lines = input.transcript.map(
    (line) => `[${stamp(line.at, input.ownerTimeZone)}] ${label[line.role]}: ${line.text}`
  );
  const open = "\n\n<charla> (horas de Uruguay)\n";
  const close = "\n</charla>";
  // Too long for the calendar: keep the newest lines, which are closest to the call.
  let dropped = 0;
  const body = () => (dropped ? `(…${dropped} mensajes anteriores)\n` : "") + lines.slice(dropped).join("\n");
  while (dropped < lines.length && head.length + open.length + body().length + close.length > maxChars) dropped++;
  return `${head}${open}${body() || "(vacía)"}${close}`;
}
