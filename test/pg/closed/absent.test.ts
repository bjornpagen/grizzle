/**
 * A closed read at an absent key is judged by the rule that reads it, never refused by a cast, on PostgreSQL 19.
 *
 * The documented contract: `C.at` at a key its closed relation holds no row at reads NULL, `C.row` of a prefix the
 * relation completes nowhere reads the empty set and of a NULL prefix NULL, `C.has` of a key no row holds is false and
 * of a NULL key value NULL, and the rule's three-valued logic decides.
 * A row check holds where its predicate is true, a selection keeps the rows it is true of, and a generated field's
 * NULL term is refused by its column's NOT NULL. Every domain admits NULL, so no cast to a roster's, a set's, a
 * contract's or a pattern's domain refuses a read first.
 *
 * Each case draws a world: rosters Kind and Flag of one to three and one to eight handles, so a set over Flag is padded
 * by seven bits down to none; Pick, keyed by a kind, whose payload is a flag, an integer, a numeric(3, 1), a text, a
 * contract over an integer and a refined text, holding a drawn subset of the kinds; FlagRel, a set of (from, to) flags,
 * whose row of a flag is its completions, empty for a flag it completes nowhere; FlagW, a flag's integer weight,
 * holding a drawn subset of the flags; Allowed, a set of (kind, flag) pairs; and Slot, keyed by a kind and a flag,
 * whose payload is a flag, holding a drawn subset of the pairs. A read is Pick.at of a payload field at the row's kind,
 * or FlagRel.row, FlagW.at or `Bit.singleton` at the row's own flag or, nested, at Pick.at("flag", kind) or at
 * Slot.at("slot", kind, flag), so FlagRel.row of the slotted flag is the double lookup, a set read whose key is a
 * closed read keyed by two fields, read at a NULL prefix where Slot lacks the pair; or the union of FlagRel.row at the
 * own flag with such a singleton, or a `Logic.cond` over `C.has` of Pick.at at the row's kind or of FlagW.at at a
 * flag, its literal where the key is absent or NULL. A presence is `C.has` of Pick at the row's kind, of FlagW at a
 * flag, of Allowed at the kind and a flag, or of FlagRel at two flags, each flag the own, the picked or the slotted
 * one, so a key value is NULL in every key position. Its positions:
 *
 * - two row checks, each a drawn predicate: a read equal to the row's field of its type or to a literal, the
 *   downstream `Bit.subset(FlagRel.row(…), flags)` equal to true and its converse, the flags within the read, a
 *   flag's membership in a set, `Bit.subset(Bit.singleton(flag), set)` of the own, picked or slotted flag in
 *   the row's flags or a FlagRel.row, a presence, the kind equal or unequal to a handle, and AND, OR and NOT of them,
 *   the guard `or([not(C.has(k…)), φ(C.at(…, k…))])` among them;
 * - a containment of a selection's (kind, flag) into Allowed, under a drawn predicate: a table CHECK whose guard is
 *   the selection;
 * - a key over a selection's integer, under a drawn predicate: a law column `CASE WHEN φ THEN n END`, which grizzle's
 *   writer probes by a query that lowers the selection again. Each drawn row is written at every kind, so a row the
 *   selection keeps and one it leaves unknown share their integer;
 * - a generated field of each read, each its own relation: a closed id, an integer, a numeric, a text, a contract and
 *   a refined text read by Pick.at; a set and an integer read by FlagRel.row and FlagW.at at the own and at the picked
 *   flag; the singleton of the own and of the picked flag; the union of the own flag's FlagRel.row with the picked
 *   flag's singleton; and the conditionals over `C.has`, which store their literal where the key is absent or NULL;
 * - a fold, the sum of an ordered family's integers under a drawn selection of its members. On the host, grizzle's
 *   writer fills it: an owner with every row nested as its members, a stored owner one member put at a time at its
 *   end, and a refill past the first owner's deleted first member; each owner's total must be the sum over the members the
 *   selection makes true. On the server, each stored member's after set to its other branch (its before where the
 *   selection is true, its stepped value where it is false or unknown) must be refused by the fold's CHECK, 23514,
 *   wherever its integer is not 0. Coverage requires a member stepped by a selection that is one set read, true at the
 *   empty set of a flag completed nowhere, which the host's fill reads as the contract does; the generator constructs it
 *   for a case whose turn aims at it (emptySetFoldGen).
 *
 * Each drawn row is written into each relation by grizzle's writer through the full world's served workload, one
 * insert per call: into a generated relation through the one insert of them all whose call holds the row in that
 * relation alone, and into each other relation through its own. The oracle is the
 * documented contract restated over the world's rows: Kleene's three-valued logic over reads that are NULL exactly at
 * an absent key or a NULL argument. A lawful row is accepted; an unlawful one is `invariant-rejected` naming its
 * relation's one law; and every stored generated value is the read's, a set its exact bits. A domain's refusal of a
 * NULL is a 23514 on a roster's or a set's domain, which grizzle's writer dies with as its own defect, or names a
 * contract's or a pattern's law: neither is what the domain names.
 *
 * The planted bugs: a domain CHECK that refuses NULL refuses the downstream case and every generated closed id, set,
 * contract or pattern field at an absent key; a C.row of a prefix completed nowhere read as NULL refuses a subset
 * check and a generated set the contract stores empty; a host evaluator that reads a closed read at an absent key as
 * unsupported refuses a fold write whose selection it leaves unknown; a fold CHECK that steps where `NOT φ` fails,
 * not where φ holds, refuses the host's fill of such a member; a singleton whose bit is set at its code plus one, or
 * counted from the right, stores another set and decides a membership otherwise; a singleton of a NULL id read as
 * the empty set, on the host or in PostgreSQL, decides a membership the contract leaves unknown and stores a set where
 * the contract refuses the row; a C.has read as NULL at an absent key, on the host or in PostgreSQL, refuses the
 * guard's row the contract holds and skips a fold's member its negation makes true; and a C.has of a NULL key value read
 * as false holds a negated presence the contract leaves unknown.
 *
 * The world's Flag has one to eight handles, so a set over it is a whole byte (eight flags) or padded,
 * and a singleton meets the first and the last code; the downstream shape a diagonal closed relation once spelled, a
 * row's own flag in FlagRel.row of the flag its kind picks, is a kept case, at a kind Pick holds and at one it lacks;
 * so is the downstream count bound, a payload compared only where `C.has` holds the key, and the conditional that reads
 * a payload where the key is held and a literal where it is not.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	absentCase,
	caseGen,
	emptySetFoldGen,
	type Feature,
	situations
} from "#test/pg/closed/absent.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A closed read at an absent key is judged by the rule that reads it, never refused by a domain's cast.
 *
 * Its pre-conversion budget: runs 24, coverage cases 64 (test/pg/closed/absent.test.ts at d8eed1786).
 */
export const aClosedReadAtAnAbsentKeyIsJudgedByTheRuleThatReadsItNeverRefusedByADomainsCast =
	property.explore(
		aimed(caseGen, [
			[
				"a fold steps a member its selection, one set read, makes true at the empty set of a flag completed nowhere",
				emptySetFoldGen
			]
		]),
		{
			needs: { substrate: Substrate.fresh(baseSubstrate) },
			situations: situations satisfies ReadonlyArray<Reached<Feature>>,
			check:
				({ substrate }, c: Case<Feature>) =>
				(value2) =>
					Effect.provideServiceEffect(
						absentCase(value2, c),
						Substrate,
						Effect.map(substrate, (taken) => taken.substrate)
					),
			oracle: {
				kind: "specification",
				name: "the documented contract over the world's rows: C.at NULL at an absent key, C.row empty where nothing completes its prefix and NULL at a NULL prefix, C.has false at an absent key and NULL at a NULL key value, Kleene's three-valued logic, a selection holding where it is true, and a generated field's NULL refused by its NOT NULL"
			},
			budget: { runs: 24, steered: 64 },
			kept: [
				{
					token: ReplayToken(
						"test/pg/closed/absent.test.ts#aClosedReadAtAnAbsentKeyIsJudgedByTheRuleThatReadsItNeverRefusedByADomainsCast:-:1.1.1.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.8.1.0.0.4.1.1.1.0.8.1.0.0.3.0.0.0.0.0.4.1.0.4.1.0.4.1.1.0.0.0.0.0.0.0.0.0"
					),
					reason:
						"downstream: Kind {a, b} and Flag {x, y}, Pick holds only a → x, FlagSelf the diagonal; SetItem's check or(ne(kind, a), subset(FlagSelf.row(Pick.at(flag, kind)), flags)) and ScalarItem's or(ne(kind, a), eq(Pick.at(flag, kind), x)) hold of kind b with no flags",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/closed/absent.test.ts#aClosedReadAtAnAbsentKeyIsJudgedByTheRuleThatReadsItNeverRefusedByADomainsCast:-:1.1.1.0.1.1.0.0.0.0.1.0.1.0.0.0.0.0.0.0.1.0.1.1.1.1.0.8.1.0.0.6.0.1.1.0.6.0.1.1.0.6.0.1.1.0.6.0.1.1.0.6.0.1.1.0.0.1.0.1.0.0.0.0.2.1.1.0.0.2.0.0.0.0.0.1.0.1.3.0.0.0.0"
					),
					reason:
						"downstream, with no diagonal: Kind {a, b} and Flag {x, y}, Pick holds only a → x, FlagRel x → {x} and y → {x, y}; Checked0's or(ne(kind, a), subset(singleton(flag), FlagRel.row(Pick.at(flag, kind)))) holds of kind a with flag x and of kind b, whose Pick read is NULL; Checked1's membership alone refuses kind b's unknown row and kind a's flag y; every selection reads the membership, and the picked singleton is refused by its NOT NULL at kind b",
					since: "2026-11-19"
				},
				{
					token: ReplayToken(
						"test/pg/closed/absent.test.ts#aClosedReadAtAnAbsentKeyIsJudgedByTheRuleThatReadsItNeverRefusedByADomainsCast:-:1.1.1.0.0.1.0.0.0.0.1.0.1.0.0.0.0.0.1.2.0.1.0.1.1.0.2.1.1.2.1.0.0.0.3.0.0.0.0.0.0.1.1.0.1.2.0.0.2.1.1.0.0.1.0.1.0.0.0.0.2.0.1.0.0.2.0.0.0.0.1.1.0.1.3.0.0.0.0"
					),
					reason:
						"downstream, absence stated by C.has: Kind {a, b} and Flag {x, y}, Pick holds only a → (x, n 1), FlagW only x; Checked0 is the count bound, or(not(Pick.has(kind)), eq(Pick.at(n, kind), n)), which holds of kind b at any n and refuses kind a's n 2; Checked1 negates a guarded comparison, not(and(Pick.has(kind), eq(Pick.at(flag, kind), x))), true at kind b; the selections read presences, FlagW's at the picked flag NULL at kind b; and the conditionals store Pick's payload at kind a and their literal at kind b, the picked weight's at its NULL key",
					since: "2026-11-19"
				}
			],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/expr/index.ts",
					original:
						'\t\t? closedRead(site, set, [...set.args.map(lower), lower(code)], { kind: "has" })\n',
					replacement:
						'\t\t? closedRead(site, set, [lower(code), ...set.args.map(lower)], { kind: "has" })\n',
					why: "A membership in a closed row reads the key set at the code before the row's prefix, another key's bit; the kept FlagRel case, x → {x} and y → {x, y}, accepts kind a's flag y, which FlagRel.row(x) does not hold."
				}
			]
		}
	)
