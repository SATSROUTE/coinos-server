import { archive } from "$lib/db";
import { db, g } from "$lib/db";
import { getHealthStatus } from "$lib/health";
import ln from "$lib/ln";
import { getDecodedToken } from "@cashu/cashu-ts";

export default {
  async health(_, res) {
    const status = getHealthStatus();
    const httpStatus = status.healthy ? 200 : 503;
    res.status(httpStatus).send(status);
  },

  async balances(_, res) {
    let total = 0;

    // for await (const k of db.scanIterator({ MATCH: "balance:*" })) {
    //   total += parseInt(await db.get(k));
    // }
    //
    // for await (const k of archive.scanIterator({ MATCH: "balance:*" })) {
    //   total += parseInt(await archive.get(k));
    // }

    const funds = await ln.listfunds();
    const lnchannel = parseInt(
      funds.channels.reduce((a, b) => a + b.channel_sat, 0),
    );
    const lnwallet = parseInt(funds.outputs.reduce((a, b) => a + b.value, 0));

    // Numa instancia nova a chave `cash` nao existe, e getDecodedToken(null)
    // estoura com "null is not an object". So aparece em deploy do zero: a
    // instancia de origem sempre teve a chave.
    const cashToken = await g("cash");
    const cash = cashToken
      ? getDecodedToken(cashToken).proofs.reduce((a, b) => a + b.amount, 0)
      : 0;

    const info = {
      cash,
      lnchannel,
      lnwallet,
    };

    res.send(info);
  },
};
