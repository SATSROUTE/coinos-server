import config from "$config";
import { db, g } from "$lib/db";
import { warn } from "$lib/logging";
import { PaymentType } from "$lib/types";
import { fail } from "$lib/utils";
import { createHash } from "node:crypto";

// Controles de saque que o Coinos nao traz. O que ja existia era um teto GLOBAL
// por pagamento (`limit`) e uma reserva contra o saldo real do no
// (`${tipo}:limit`) — nenhum dos dois olha para o usuario individual, para a
// frequencia, nem para o destino.
//
// Estes tres fecham isso:
//   1. teto por usuario (por pagamento e acumulado no dia)
//   2. limite de velocidade (quantos saques por janela de tempo)
//   3. carencia para endereco de destino nunca visto
//
// Todos sao OPCIONAIS: valor ausente ou zero desliga o controle. Isso e
// deliberado — um limite mal calibrado bloqueia cliente legitimo, e a
// calibragem depende do perfil de uso, que so aparece depois do lancamento.
// Os valores sugeridos estao em config.ts.sample.

const DAY = 86400;
const num = (v: any) => Number.parseInt(v as any, 10) || 0;

// So os saques que de fato tiram dinheiro do sistema passam por aqui.
// Movimento interno e apenas troca de dono no ledger.
const isExternal = (type: PaymentType) => type !== PaymentType.internal;

// Endereco on-chain e reutilizavel, entao "destino ja conhecido" faz sentido.
// Uma bolt11 e unica por pagamento — dar carencia a ela bloquearia todo saque
// Lightning para sempre, e nao protegeria nada.
const hasReusableDestination = (type: PaymentType) =>
  type === PaymentType.bitcoin || type === PaymentType.liquid;

const destKey = (uid: string, hash: string) =>
  `dest:${uid}:${createHash("sha256").update(hash).digest("hex").slice(0, 32)}`;

const today = () => new Date().toISOString().slice(0, 10);

export const spentTodayKey = (uid: string) => `withdrawn:${uid}:${today()}`;

/**
 * Aplica a politica de saque. Lanca (via fail) quando alguma regra barra.
 * Chamado de dentro do debit(), depois das travas globais e antes da reserva
 * contra o saldo do no.
 */
export const enforceWithdrawalPolicy = async ({
  user,
  amount,
  type,
  hash,
  whitelisted = false,
}: {
  user: any;
  amount: number;
  type: PaymentType;
  hash?: string;
  whitelisted?: boolean;
}) => {
  if (!isExternal(type)) return;

  const uid = user?.id;
  if (!uid) return;

  const block = (motivo: string, detalhe: string) => {
    warn(
      "Blocking",
      user.username,
      amount,
      hash,
      uid,
      type,
      "withdrawal-policy",
      motivo,
    );
    fail(detalhe);
  };

  // ---- 1. Teto por pagamento, por usuario -------------------------------
  // `limit:<uid>` sobrepoe o padrao de config. O `limit` global do Coinos
  // continua valendo em paralelo, aplicado antes desta funcao.
  const perPayment = num(await g(`limit:${uid}`)) || num(config.userLimitSats);
  if (perPayment > 0 && amount > perPayment)
    block("per-payment", "Amount exceeds your per-payment withdrawal limit");

  // ---- 2. Teto diario acumulado -----------------------------------------
  const dayCap = num(await g(`daylimit:${uid}`)) || num(config.dayLimitSats);
  if (dayCap > 0) {
    const k = spentTodayKey(uid);
    const spent = num(await g(k));
    if (spent + amount > dayCap)
      block("daily", "Daily withdrawal limit reached, try again tomorrow");

    // Contabiliza na hora da autorizacao, nao na confirmacao. Um saque que
    // falhe depois conta a mais — o que erra para o lado seguro. O contrario
    // (contar so no sucesso) deixaria varios saques concorrentes passarem
    // todos pelo mesmo saldo restante.
    await db.incrBy(k, amount);
    if ((await db.ttl(k)) < 0) await db.expire(k, 2 * DAY);
  }

  // ---- 3. Limite de velocidade ------------------------------------------
  const vMax = num(config.velocityMax);
  const vWindow = num(config.velocityWindow) || 3600;
  if (vMax > 0) {
    const k = `velocity:${uid}`;
    const n = await db.incr(k);
    if (n === 1) await db.expire(k, vWindow);
    if (n > vMax)
      block("velocity", "Too many withdrawals in a short period, slow down");
  }

  // ---- 4. Carencia para destino novo ------------------------------------
  // Defesa contra conta comprometida: quem entra numa sessao roubada nao
  // consegue sacar imediatamente para um endereco proprio — ha uma janela em
  // que o dono percebe e reage. A lista branca pula esta regra.
  const cooloff = num(config.newAddressCooloff);
  if (cooloff > 0 && !whitelisted && hasReusableDestination(type) && hash) {
    const k = destKey(uid, hash);
    const now = Math.floor(Date.now() / 1000);
    const first = num(await g(k));

    if (!first) {
      // Primeira vez que vemos este destino para este usuario: registra e
      // barra. A proxima tentativa, depois da carencia, passa.
      await db.set(k, String(now));
      await db.expire(k, 180 * DAY);
      block(
        "new-destination",
        `New destination address: for your security, withdrawals to it are released in ${Math.ceil(cooloff / 60)} minutes`,
      );
    }

    const waited = now - first;
    if (waited < cooloff)
      block(
        "cooloff",
        `New destination address: released in ${Math.ceil((cooloff - waited) / 60)} minutes`,
      );
  }
};
