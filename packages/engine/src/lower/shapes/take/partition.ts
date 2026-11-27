import type { NodeOf } from "#compiler/ir/rel.ts"

/**
 * A take's partition, and the restriction that commutes with it.
 *
 * A take ranks its input within each evaluation, and an evaluation ranks only the input rows that satisfy every one of
 * its correlations (ir/rel.ts Take): an attachment's take is correlated at the attachment's parent columns
 * (check/checker.ts take), so it ranks each parent key's rows apart, a group of its own, and keeps the first k of each.
 * Its partition is those correlated columns.
 *
 * Rule: a restriction that equates columns of the partition to values commutes with the take. For P the partition, p
 * a subset of P and k a value of p, σ_{p=k}(take_P(R)) = take_P(σ_{p=k}(R)).
 *
 * Proof: take_P(R) is the union over each value g of P of the first k rows of σ_{P=g}(R) under the take's order. The
 * restriction keeps a group whole or drops it whole, since each of its columns is one of P: σ_{p=k} of the union is the
 * union over the g that agree with k on p of the first k rows of σ_{P=g}(R), and σ_{P=g}(σ_{p=k}(R)) is σ_{P=g}(R) for
 * those g and empty for every other. So taking the first k of each group of σ_{p=k}(R) gives the same rows. A group's
 * rank reads only that group's rows.
 *
 * A column the take orders by, or any other column outside P, does not commute: σ_{c=k} keeps some rows of a group and
 * drops others, so the first k of what it keeps are other rows than the first k of the group, the ranked rows among
 * the ones dropped, and a take with no correlation ranks its whole input as one group, which no restriction narrows.
 * Only the partition's columns of a restriction pass through a take (`inPartition`). The rest stay with the reader
 * above the take, which keeps them where the take delivers its rows.
 *
 * The keys a reader reads a take at reach its input at the same columns (share/keys.ts KeyAnalysis), as a fold's
 * grouping keys reach its input. A restriction reaches the input inside the take, below its ORDER BY and LIMIT, where
 * PostgreSQL moves none (share/keys.ts restrictionWalk). A take whose partition binds every stored relation its input
 * reads on a declared-key prefix is read once per parent key at that key (cte-policy keyPrefixBound, attachmentRead
 * `perKey`): metis's results page read the credit of each session's latest attempt as a take over its whole credit
 * chain, derived for every attempt of the database, 2.8 million values each probed twice, once for each of the
 * sitting's sessions. Read at each session's key, the chain reads that session's attempts alone.
 */

/**
 * Whether `column` is one of `take`'s partition's (the module header), the columns its correlations hold: a restriction
 * of it passes through the take into its input, one of any other column stays with the reader above the take, and a
 * take with no correlation has none.
 */
export const inPartition = (take: NodeOf<"Take">, column: string): boolean =>
	take.correlation.some((c) => c.column === column)
