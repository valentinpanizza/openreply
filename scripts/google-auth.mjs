// Autoriza una sola vez (ver lib/setter/calendar.ts) al worker a usar tu Google Calendar y guarda el permiso
// (refresh token) en /out/google-token.json. Nada se imprime en pantalla.
import http from "node:http";
import fs from "node:fs";

const PORT = 8085;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const { installed: c } = JSON.parse(fs.readFileSync("/in/google-oauth-client.json", "utf8"));

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: c.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });

console.log("\nAbrí este link en el navegador de tu computadora:\n\n" + authUrl + "\n\nEsperando...");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  if (!code) {
    res.end("Falta el codigo. " + (url.searchParams.get("error") ?? ""));
    return;
  }
  const r = await fetch(c.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.client_id,
      client_secret: c.client_secret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    }),
  });
  const t = await r.json();
  if (!t.refresh_token) {
    res.end("No vino el permiso. Volve a correr el script.");
    console.log("Error:", t.error, t.error_description);
    process.exit(1);
  }
  fs.writeFileSync(
    "/out/google-token.json",
    JSON.stringify({ refresh_token: t.refresh_token, scope: t.scope }),
    { mode: 0o600 },
  );
  res.end("Listo, ya podes cerrar esta pestaña.");
  console.log("\nListo: permiso guardado en ~/openreply/google-token.json");
  server.close();
  process.exit(0);
});
server.listen(PORT, "127.0.0.1"); // solo local: se llega por el tunel ssh -L
