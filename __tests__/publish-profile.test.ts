import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));

import { agencyUsername, profileEnv, profileKey, titlePrefix, withProfile } from "../lib/publishing/profile";
import { setterSkippedAccounts } from "../lib/setter/config";

describe("publishing profile", () => {
  it("leaves the owner's settings and keys as they were", () => {
    const env = { CAROUSEL_FOLDER: "Carruseles", AGENCY_CAROUSEL_FOLDER: "NodeStudio/X" };
    expect(profileEnv(env, { CAROUSEL_FOLDER: "default" })).toBe(env);
    expect(profileKey("carousel:next")).toBe("carousel:next");
    expect(titlePrefix()).toBe("");
  });

  it("gives the agency only its AGENCY_ settings, its defaults and the time zone", async () => {
    const env = {
      CAROUSEL_PUBLISH_ENABLED: "true",
      CAROUSEL_FOLDER: "Carruseles",
      CAROUSEL_PUBLISH_HOURS: "0-24",
      TRIAL_PUBLISH_TIMEZONE: "America/Montevideo",
      AGENCY_CAROUSEL_EVERY_DAYS: "2",
    };
    await withProfile("agency", async () => {
      expect(profileEnv(env, { CAROUSEL_FOLDER: "NodeStudio/Carruseles" })).toEqual({
        TRIAL_PUBLISH_TIMEZONE: "America/Montevideo",
        CAROUSEL_FOLDER: "NodeStudio/Carruseles",
        CAROUSEL_EVERY_DAYS: "2",
      });
      expect(profileKey("reel:next")).toBe("agency:reel:next");
      expect(titlePrefix()).toBe("Agencia · ");
    });
  });

  it("knows the agency's username", () => {
    expect(agencyUsername({})).toBe("nodestudio.ai");
    expect(agencyUsername({ AGENCY_INSTAGRAM_USERNAME: " @OtraCuenta " })).toBe("otracuenta");
  });

  it("keeps the setter off the agency's account unless told otherwise", () => {
    expect(setterSkippedAccounts({})).toEqual(["nodestudio.ai"]);
    expect(setterSkippedAccounts({ SETTER_SKIP_ACCOUNTS: "@a, B" })).toEqual(["a", "b"]);
    expect(setterSkippedAccounts({ SETTER_SKIP_ACCOUNTS: "-" })).toEqual([]);
  });
});
