import { Constants, type Database } from "./database.types";

export type Channel = Database["public"]["Enums"]["expense_channel"];

/** Display order. */
export const CHANNELS: readonly Channel[] = Constants.public.Enums.expense_channel;

export const CHANNEL_LABELS: Record<Channel, string> = {
  online: "Online",
  in_store: "In store",
  bill: "Bill",
  paynow_transfer: "PayNow or transfer",
  overseas: "Overseas",
};
