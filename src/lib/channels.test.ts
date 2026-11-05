import { describe, it, expect } from "vitest";
import { CHANNELS, CHANNEL_LABELS } from "./channels";

describe("channels", () => {
  it("every channel has a label", () => {
    expect([...CHANNELS]).toEqual(Object.keys(CHANNEL_LABELS));
    expect(CHANNELS.map((c) => CHANNEL_LABELS[c])).toEqual([
      "Online",
      "In store",
      "Bill",
      "PayNow or transfer",
      "Overseas",
    ]);
  });
});
