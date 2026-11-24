import { describe, expect, it } from "vitest";
import { evidentBusiness, justThanks } from "../lib/setter/triage";

describe("triage", () => {
  it("spots real estate accounts, only from Tasacion", () => {
    for (const u of ["morel.inmobiliaria", "dbdb_propiedades", "jimmymachado.realtyec", "eduaguilar_remax", "nicodelagbroker", "mya.fincaraiz", "perlitarealestate"])
      expect(evidentBusiness(u, "[TRIAL1] Tasacion")).toBe(true);
    expect(evidentBusiness("morel.inmobiliaria", "[TRIAL1] TV")).toBe(false);
    expect(evidentBusiness("juan.perez", "Tasacion PDF")).toBe(false);
    expect(evidentBusiness(null, "Tasacion PDF")).toBe(false);
  });
  it("recognises a message that needs no answer", () => {
    for (const t of ["Gracias", "Graciasss!", "muchas gracias 🙌", "dale gracias", "👏", "Ok, genial!"]) expect(justThanks(t)).toBe(true);
    for (const t of ["gracias, cuanto sale?", "gracias, tengo una inmobiliaria", "?", "no me abre", "[mandó un archivo]", "quiero la llamada"])
      expect(justThanks(t)).toBe(false);
  });
});
