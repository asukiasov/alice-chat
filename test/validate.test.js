import { describe, it, expect } from "vitest";
import { normalizeUsername, validDisplayName, validPin, validText, chatId, otherParticipant } from "../src/validate.js";
import { hashPin } from "../src/auth.js";

describe("normalizeUsername", () => {
  it("accepts names, phone numbers and ids, and lowercases", () => {
    expect(normalizeUsername("  Alice ")).toBe("alice");
    expect(normalizeUsername("+995555123456")).toBe("+995555123456");
    expect(normalizeUsername("Маша_7")).toBe("маша_7");
  });
  it("rejects empty, too long and punctuation", () => {
    for (const bad of ["", "   ", "a".repeat(33), "a b", "a\nb", "<x>", 5, null]) {
      expect(() => normalizeUsername(bad)).toThrow();
    }
  });
});

describe("other rules", () => {
  it("validates display names", () => {
    expect(validDisplayName(" Маша ")).toBe("Маша");
    expect(() => validDisplayName("")).toThrow();
    expect(() => validDisplayName("x".repeat(51))).toThrow();
  });
  it("validates PINs as 4-8 digits", () => {
    expect(validPin("1234")).toBe("1234");
    expect(validPin("12345678")).toBe("12345678");
    for (const bad of ["123", "123456789", "12a4", 1234]) expect(() => validPin(bad)).toThrow();
  });
  it("validates message text", () => {
    expect(validText("  hi ")).toBe("hi");
    expect(() => validText("   ")).toThrow();
    expect(() => validText("x".repeat(2001))).toThrow();
  });
  it("gives a pair one chat id in either order", () => {
    expect(chatId("bob", "ann")).toBe(chatId("ann", "bob"));
    expect(otherParticipant(chatId("ann", "bob"), "ann")).toBe("bob");
    expect(otherParticipant(chatId("ann", "bob"), "bob")).toBe("ann");
  });
  it("hashes a PIN repeatably, and differently per salt", async () => {
    expect(await hashPin("1234", "aa")).toBe(await hashPin("1234", "aa"));
    expect(await hashPin("1234", "aa")).not.toBe(await hashPin("1234", "bb"));
  });
});
