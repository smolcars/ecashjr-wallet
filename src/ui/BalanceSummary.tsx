import type { ReactNode } from "react";
import type { WalletSnapshot } from "../core/types.ts";
import { Amount } from "./Amount.tsx";

function BalanceCard(
  { label, value, detail, accent }: {
    label: string;
    value: number;
    detail: ReactNode;
    accent: string;
  },
) {
  return (
    <article className={`balance-card ${accent}`}>
      <div className="balance-heading">
        <span className="chain-dot" />
        {label}
      </div>
      <strong>
        <Amount value={value} chain={accent === "btc" ? "btc" : "ecx"} />
      </strong>
      <span className="balance-detail">{detail}</span>
    </article>
  );
}

function ReplayProtectionHelp() {
  return (
    <span className="info-tooltip">
      <button
        type="button"
        className="info-tooltip-trigger"
        aria-label="Explain nLockTime = 499999999"
        aria-describedby="replay-protection-tooltip"
      >
        ?
      </button>
      <span id="replay-protection-tooltip" className="info-tooltip-content" role="tooltip">
        ECX sends use locktime 499999999 and non-final input sequences. Bitcoin rejects these
        transactions as non-final; ECX explicitly accepts this marker.
      </span>
    </span>
  );
}

export function BalanceSummary({ snapshot }: { snapshot: WalletSnapshot }) {
  return (
    <section className="balance-grid">
      <BalanceCard
        label="BTC BALANCE"
        value={snapshot.balances.btc}
        detail={
          <>
            <Amount value={snapshot.balances.spendableBtc} /> selectable for BTC sends
          </>
        }
        accent="btc"
      />
      <BalanceCard
        label="ECX BALANCE"
        value={snapshot.balances.ecx}
        detail={
          <>
            <Amount value={snapshot.balances.spendableEcx} chain="ecx" /> selectable with{" "}
            nLockTime = 499999999
            <ReplayProtectionHelp />
          </>
        }
        accent="ecx"
      />
      <BalanceCard
        label="SHARED TO SPLIT"
        value={snapshot.balances.shared}
        detail={`${snapshot.splittableOutpoints.length} UTXO${
          snapshot.splittableOutpoints.length === 1 ? "" : "s"
        } ready`}
        accent="ready"
      />
    </section>
  );
}
