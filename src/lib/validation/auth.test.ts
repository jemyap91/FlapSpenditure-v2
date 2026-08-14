import { describe, expect, it } from "vitest";
import {
  credentials,
  credentialsValidationError,
  isAccountAlreadyExistsError,
  signInErrorMessage,
  signUpErrorMessage,
} from "./auth";

describe("credentials", () => {
  it("accepts a well-formed email and an 8+ char password", () => {
    const result = credentials.safeParse({ email: "a@example.com", password: "longenough" });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed email", () => {
    const result = credentials.safeParse({ email: "not-an-email", password: "longenough" });
    expect(result.success).toBe(false);
  });

  it("rejects a too-short password", () => {
    const result = credentials.safeParse({ email: "a@example.com", password: "short" });
    expect(result.success).toBe(false);
  });
});

describe("credentialsValidationError", () => {
  it("maps a bad email to our own message, scoped to the email field", () => {
    const result = credentials.safeParse({ email: "not-an-email", password: "longenough" });
    if (result.success) throw new Error("expected failure");
    expect(credentialsValidationError(result.error)).toEqual({
      message: "Enter a valid email address",
      field: "email",
    });
  });

  it("maps a short password to our own message, scoped to the password field", () => {
    const result = credentials.safeParse({ email: "a@example.com", password: "short" });
    if (result.success) throw new Error("expected failure");
    expect(credentialsValidationError(result.error)).toEqual({
      message: "Password must be at least 8 characters",
      field: "password",
    });
  });

  it("never forwards zod's own generated text, however malformed the input", () => {
    // A raw POST can send anything: fields omitted entirely (which zod
    // reports as a type error whose default message mentions "undefined"),
    // or a body that isn't even an object. None of zod's own wording should
    // ever reach the UI — only our app-authored copy.
    const malformedInputs: unknown[] = [
      {}, // both fields missing
      { email: "a@example.com" }, // password missing — Object.fromEntries(new FormData()) shape
      { password: "longenough" }, // email missing
      "not-an-object",
      undefined,
    ];
    for (const input of malformedInputs) {
      const result = credentials.safeParse(input);
      if (result.success) throw new Error(`expected failure for ${JSON.stringify(input)}`);
      const { message } = credentialsValidationError(result.error);
      expect(message).not.toMatch(/undefined|invalid input|expected/i);
    }
  });

  it("falls back to the generic message when the failure isn't about a specific field", () => {
    // A root-level type mismatch (the submitted body isn't an object at
    // all) has no `email`/`password` path to key off of.
    const result = credentials.safeParse("not-an-object");
    if (result.success) throw new Error("expected failure");
    expect(credentialsValidationError(result.error)).toEqual({
      message: "Check your email and password and try again.",
    });
  });
});

describe("signInErrorMessage", () => {
  it("returns the same generic message for invalid_credentials", () => {
    expect(signInErrorMessage({ code: "invalid_credentials", status: 400 })).toEqual({
      message: "Invalid email or password.",
    });
  });

  it("returns the same generic message for an unconfirmed-email code (would only fire for a real account)", () => {
    expect(signInErrorMessage({ code: "email_not_confirmed", status: 400 })).toEqual({
      message: "Invalid email or password.",
    });
  });

  it("returns the same generic message for a rate-limit code", () => {
    expect(signInErrorMessage({ code: "over_request_rate_limit", status: 429 })).toEqual({
      message: "Invalid email or password.",
    });
  });

  it("distinguishes only a 5xx, not the reason", () => {
    expect(signInErrorMessage({ status: 500 })).toEqual({
      message: "Something went wrong. Please try again.",
    });
  });

  it("never sets a field (would leak which half of the credential pair is wrong)", () => {
    expect(signInErrorMessage({ code: "invalid_credentials" }).field).toBeUndefined();
  });
});

describe("signUpErrorMessage", () => {
  it("gives a specific, safe message for a weak password", () => {
    expect(signUpErrorMessage({ code: "weak_password" })).toEqual({
      message: "Choose a stronger password.",
      field: "password",
    });
  });

  it("gives a specific, safe message for a malformed email", () => {
    expect(signUpErrorMessage({ code: "email_address_invalid" })).toEqual({
      message: "Enter a valid email address.",
      field: "email",
    });
  });

  it("collapses an already-registered email to the same fallback as an unrelated error", () => {
    const alreadyExists = signUpErrorMessage({ code: "user_already_exists" });
    const alsoAlreadyExists = signUpErrorMessage({ code: "email_exists" });
    const somethingUnexpected = signUpErrorMessage({ code: "unexpected_failure" });
    const noCodeAtAll = signUpErrorMessage({});

    // The whole point: an attacker reading only the rendered text cannot
    // tell "this email is taken" apart from "the server hiccuped."
    expect(alreadyExists).toEqual(somethingUnexpected);
    expect(alsoAlreadyExists).toEqual(somethingUnexpected);
    expect(noCodeAtAll).toEqual(somethingUnexpected);
    expect(alreadyExists.message).toBe(
      "We couldn't create your account with those details. Please try again."
    );
    expect(alreadyExists.field).toBeUndefined();
  });
});

describe("isAccountAlreadyExistsError", () => {
  it("recognizes the code local GoTrue actually returns for a duplicate signUp", () => {
    // Verified directly against the running local Supabase instance: a
    // second `auth.signUp` with an already-registered email returns
    // { code: "user_already_exists", status: 422 } and no session.
    expect(isAccountAlreadyExistsError({ code: "user_already_exists", status: 422 })).toBe(true);
  });

  it("also recognizes the newer/alternate email_exists code", () => {
    expect(isAccountAlreadyExistsError({ code: "email_exists" })).toBe(true);
  });

  it("does not misfire for unrelated errors", () => {
    expect(isAccountAlreadyExistsError({ code: "weak_password" })).toBe(false);
    expect(isAccountAlreadyExistsError({ code: "unexpected_failure" })).toBe(false);
    expect(isAccountAlreadyExistsError({})).toBe(false);
  });
});
