/**
 * Wallet Aggregate。Counter と同じテーブルに書き込まれる想定で、event 名は
 * Aggregate プレフィックス付き (DEC-009)。
 */
import type { AggregateConfig, CommandHandler } from "../../src/index.js";

export type WalletEvents = {
  "Wallet.Credited": { amount: number; currency: string };
  "Wallet.Debited": { amount: number; currency: string };
};

export interface WalletState {
  readonly balance: number;
  readonly currency: string;
}

export const walletConfig: AggregateConfig<WalletState, WalletEvents> = {
  initialState: { balance: 0, currency: "JPY" },
  evolve: {
    "Wallet.Credited": (state, data) => ({
      balance: state.balance + data.amount,
      currency: data.currency,
    }),
    "Wallet.Debited": (state, data) => ({
      balance: state.balance - data.amount,
      currency: data.currency,
    }),
  },
};

export const creditWallet: CommandHandler<
  WalletState,
  WalletEvents,
  { amount: number; currency: string }
> = (_agg, input) => {
  if (input.amount <= 0) return [];
  return [{ type: "Wallet.Credited", data: input }];
};
