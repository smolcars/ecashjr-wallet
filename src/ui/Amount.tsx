import { createContext, type ReactNode, useContext } from "react";
import type { AmountUnit, ChainId } from "../core/types.ts";
import { formatAmount } from "./shared.tsx";

const AmountUnitContext = createContext<AmountUnit | null>(null);

export function Amount({ value, chain = "btc" }: { value: number; chain?: ChainId }) {
  const unit = useContext(AmountUnitContext);
  if (!unit) throw new Error("Amount denomination is unavailable");
  return <>{formatAmount(value, unit, undefined, chain)}</>;
}

export function AmountUnitProvider(
  { unit, children }: { unit: AmountUnit; children: ReactNode },
) {
  return <AmountUnitContext.Provider value={unit}>{children}</AmountUnitContext.Provider>;
}
