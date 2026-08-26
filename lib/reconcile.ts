import config from "$config";
import { db } from "$lib/db";
import ln from "$lib/ln";
import { err, l, warn } from "$lib/logging";
import { SATS } from "$lib/utils";
import rpc from "@coinos/rpc";
import { existsSync, mkdirSync, writeFileSync } from "fs";

// Nothing checked that the ledger still added up. If the sum of what we owe
// users ever exceeds what the nodes actually hold — a crediting bug, a race,
// an attacker, an insider — you'd find out on the day of a withdrawal run,
// not in the minute it happened.
//
// This is an internal proof of reserves: every tick, compare total liabilities
// (sum of balance:*) against total assets (bitcoin + liquid + spendable
// lightning). A deficit warns; a large one trips the withdrawal kill switch on
// its own, because a ledger that doesn't add up is exactly when you want sends
// to stop before a human can argue about it.

const bc = rpc(config.bitcoin);
const lq = rpc(config.liquid);

const INTERVAL = (config.reconcileInterval ?? 300) * 1000;

// A small deficit is worth a look; a large one is worth stopping the service.
// Both in sats, both overridable in config.ts.
const WARN_AT = config.reconcileWarnSats ?? 10_000;
const LOCK_AT = config.reconcileLockSats ?? 1_000_000;

// Same path lib/payments.ts checks in isWithdrawLocked().
const LOCK_DIR = "/locks";
const LOCK_FILE = `${LOCK_DIR}/ALL.locked`;

export const sumLiabilities = async (): Promise<number> => {
  let total = 0;
  // SCAN, never KEYS: KEYS blocks the whole ledger for the duration, and this
  // runs on a live payments database.
  for await (const key of db.scanIterator({
    MATCH: "balance:*",
    COUNT: 500,
  })) {
    const v = Number.parseInt((await db.get(key)) ?? "0", 10);
    if (Number.isFinite(v)) total += v;
  }
  return total;
};

// Returns undefined for any node we couldn't reach — a node being down must
// never be mistaken for a shortfall.
const nodeAssets = async (): Promise<{
  bitcoin?: number;
  liquid?: number;
  lightning?: number;
}> => {
  const out: any = {};

  try {
    out.bitcoin = Math.round((await bc.getBalance()) * SATS);
  } catch (e: any) {
    warn("reconcile: bitcoin unreachable:", e.message);
  }

  try {
    const { bitcoin } = await lq.getBalance();
    out.liquid = Math.round(bitcoin * SATS);
  } catch (e: any) {
    warn("reconcile: liquid unreachable:", e.message);
  }

  try {
    const funds = await ln.listfunds();
    // Mirror freezeCheck: only spendable channel balance counts. Funds in
    // ONCHAIN/CLOSING are mid-sweep and can't honour a withdrawal.
    out.lightning = Math.round(
      funds.channels
        .filter(
          (c) =>
            c.state === "CHANNELD_NORMAL" ||
            c.state === "CHANNELD_AWAITING_SPLICE",
        )
        .reduce((a, b) => a + b.our_amount_msat, 0) / 1000,
    );
  } catch (e: any) {
    warn("reconcile: lightning unreachable:", e.message);
  }

  return out;
};

const lockWithdrawals = (deficit: number) => {
  try {
    if (existsSync(LOCK_FILE)) return;
    mkdirSync(LOCK_DIR, { recursive: true });
    writeFileSync(
      LOCK_FILE,
      `locked by reconcile at ${new Date().toISOString()}\n` +
        `liabilities exceeded assets by ${deficit} sats\n`,
    );
    err(`RECONCILE_LOCK withdrawals halted, deficit ${deficit} sats`);
  } catch (e: any) {
    err("reconcile: COULD NOT WRITE LOCK FILE:", e.message);
  }
};

export const reconcile = async () => {
  try {
    const liabilities = await sumLiabilities();
    const assets = await nodeAssets();

    // Every node has to answer. Adding up the two that replied and comparing
    // that to the full ledger would invent a deficit out of an outage.
    const missing = ["bitcoin", "liquid", "lightning"].filter(
      (k) => assets[k] === undefined,
    );
    if (missing.length) {
      warn(`reconcile: skipped, no balance from ${missing.join(", ")}`);
      return;
    }

    const total = assets.bitcoin + assets.liquid + assets.lightning;
    const delta = total - liabilities;

    await db.set("reconcile:liabilities", String(liabilities));
    await db.set("reconcile:assets", String(total));
    await db.set("reconcile:delta", String(delta));
    await db.set("reconcile:at", String(Date.now()));

    if (delta < 0) {
      const deficit = -delta;
      if (deficit >= LOCK_AT) {
        err(
          `RECONCILE_DEFICIT ${deficit} sats — liabilities ${liabilities} > assets ${total}`,
        );
        lockWithdrawals(deficit);
      } else if (deficit >= WARN_AT) {
        warn(
          `RECONCILE_DEFICIT ${deficit} sats — liabilities ${liabilities} > assets ${total}`,
        );
      }
    } else {
      l(`reconcile ok: assets ${total}, liabilities ${liabilities}, +${delta}`);
    }
  } catch (e: any) {
    err("reconcile: iteration failed:", e?.message ?? String(e));
  } finally {
    setTimeout(reconcile, INTERVAL);
  }
};
