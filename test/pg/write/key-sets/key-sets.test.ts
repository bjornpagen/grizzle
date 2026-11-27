/**
 * A union, a fold or a join no value of a write restricts is computed at the keys its reads read it at, every read's
 * restriction gathered from what the write fixes (lower/shapes/share/keys.ts, magic sets; statements.ts keyedShares,
 * statementKeys and StatementSharing #keyedBody), on PostgreSQL 19: the content a write reads by the call's open items,
 * the labels, a union of two folds of every item's tags, or the labels joined to each item's greatest link, is computed
 * at the open items' keys alone, a union's every arm at them, a fold's below its aggregate, a join's every input at its
 * own, so the write reads the same content rows however many other items' are stored; and its rows are the whole
 * content's at every reader. metis's assign derived the status of every assignment (100,028) for two guards that read
 * the assigned test's; edullm's decideStage wrote its session's values over every item's declarations (776 of 200
 * items, 19.8 s of 20.0), and its answer read every attribute joined to every other.
 *
 * The box, exhausted: the content's readers (key-sets.fixtures.ts Readers): a diamond of two members by the open
 * items, two members by the open and the done items, one member so and one reading every label (an unrestricted
 * reader: everything whole), an anti-join's right side, a join by the folds' aggregate, a chain three nodes deep whose
 * join has two inputs that both grow with the content, and a guard union at the call's session on an anti-join's right;
 * each at scale 1 and 16, the content of 12 and 132 items stored, of which the call's open items are 3. Each case
 * installs the schema twice, once a scale.
 *
 * Property, per case: at each scale the call commits and Out0 and Out1 hold the model's rows (key-sets.fixtures.ts
 * modelOf: each member's meaning over the stored state, the content whole); and where every read is restricted, the
 * content rows the write reads in its transaction (pg_stat_xact_user_tables, Tag's, TagB's and Link's, which no member
 * reads but through the content) are the same at both scales: no node of the content, at any depth, reads a row the
 * call's keys do not reach. Oracle: specification, the model, and PostgreSQL's own counts.
 *
 * Features: each readers.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import {
	attemptLabel,
	installWrites,
	observedChange,
	openFull,
	ownerTransaction
} from "#bench/write/support/writes.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import {
	build,
	changeOf,
	contentAt,
	Done,
	done,
	Item,
	items,
	Link,
	modelOf,
	Out0,
	Out1,
	Pin,
	type Readers,
	readersGen,
	restricted,
	session,
	situations,
	Tag,
	TagB
} from "#test/pg/write/key-sets/key-sets.fixtures.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/** The scales: the stored items' content beyond the call's, eight more items a scale. */
const scales = [1, 16] as const

/** The relations the property counts the reads of: the content, which no member reads but through the shared nodes. */
const counted = [Tag, TagB, Link] as const

/** One scale's run: Out0's and Out1's rows after the call, and the content rows the write read in its transaction. */
const runAt = (readers: Readers, scale: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const s = yield* Substrate
			const fx = yield* installWrites(build("KeySets"), "keysets", {
				programs: {},
				logins: () => []
			})
			const S = build(fx.installed.declared)
			const names = namesOf(fx.installed)
			/** The INSERT of `rows` into `r`, each row its `fields`' values in order; none for no row. */
			const insert = (
				r: typeof Item | typeof Done | typeof Tag | typeof TagB | typeof Link | typeof Pin,
				fields: ReadonlyArray<string>,
				rows: ReadonlyArray<ReadonlyArray<number>>
			): ReadonlyArray<string> =>
				rows.length === 0
					? []
					: [
							`INSERT INTO ${names.table(r)} (${Arr.join(
								Arr.map(fields, (f) => quoteIdent(names.columnIdent(r, f))),
								", "
							)}) VALUES ${Arr.join(
								Arr.map(rows, (row) => `(${Arr.join(Arr.map(row, String), ", ")})`),
								", "
							)}`
						]
			const { tag, tagB, link, pin } = contentAt(scale)
			yield* ownerTransaction(
				fx,
				Arr.flatten([
					insert(
						Item,
						["session", "k", "v"],
						Arr.map(items, (i) => [i.session, i.k, i.v])
					),
					insert(
						Done,
						["session", "k"],
						Arr.map(done, (d) => [d.session, d.k])
					),
					insert(
						Tag,
						["k", "t"],
						Arr.map(tag, (x) => [x.k, x.t])
					),
					insert(
						TagB,
						["k", "t"],
						Arr.map(tagB, (x) => [x.k, x.t])
					),
					insert(
						Link,
						["k", "j"],
						Arr.map(link, (x) => [x.k, x.t])
					),
					insert(
						Pin,
						["k", "t"],
						Arr.map(pin, (x) => [x.k, x.t])
					)
				])
			)
			const db = yield* openFull(fx, S)
			let read = -1
			const observed = yield* observedChange(db, changeOf(S, readers), attemptLabel, {
				kind: "probe",
				run: (probe) =>
					Effect.map(
						probe.rows(
							"SELECT (COALESCE(sum(seq_tup_read), 0) + COALESCE(sum(idx_tup_fetch), 0))::text FROM pg_catalog.pg_stat_xact_user_tables WHERE relid = ANY (ARRAY[$1::regclass, $2::regclass, $3::regclass])",
							Arr.map(counted, (r) => names.table(r))
						),
						(rows) => {
							read = Number(defined(rows[0]?.[0], "the content rows read"))
						}
					)
			})
			const applied = yield* observed.apply({ session })
			assert.ok(
				applied.value.kind === "accepted" || applied.value.kind === "no-change",
				`${readers} at scale ${scale}: the call commits, not ${applied.value.kind}`
			)
			const rowsOf = (r: typeof Out0 | typeof Out1) =>
				Effect.map(
					s.admin.queryValues(
						`SELECT ${Arr.join(
							Arr.map(["session", "k", "t"], (f) => `${quoteIdent(names.columnIdent(r, f))}::text`),
							", "
						)} FROM ${names.table(r)}`,
						[]
					),
					(rows) =>
						Arr.sort(
							Arr.map(rows, (row) => Arr.join(Arr.map(row, String), " | ")),
							Order.String
						)
				)
			return { out0: yield* rowsOf(Out0), out1: yield* rowsOf(Out1), read }
		})
	)

/** Content every read restricts is computed at its reads' keys at every depth, its rows the whole's at every reader. */
export const contentEveryReadRestrictsIsComputedAtItsReadsKeysAtEveryDepthItsRowsTheWholesAtEveryReader =
	property.exhaust(finite(readersGen), {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<Readers>>,
		check:
			({ substrate }, k: Case<Readers>) =>
			(readers) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						k.note(readers)
						const runs = yield* Effect.forEach(scales, (scale) => runAt(readers, scale))
						for (const [scale, run] of Arr.zip(scales, runs)) {
							const model = modelOf(readers, scale)
							assert.deepEqual<ReadonlyArray<string>>(
								run.out0,
								model.out0,
								`${readers} at scale ${scale}: Out0 is the model's`
							)
							assert.deepEqual<ReadonlyArray<string>>(
								run.out1,
								model.out1,
								`${readers} at scale ${scale}: Out1 is the model's`
							)
						}
						const [small, large] = runs
						if (restricted(readers) && large !== undefined) {
							assert.equal(
								large.read,
								small.read,
								`${readers}: the content rows the write reads at scale 16 are those at scale 1, every node of it computed at the call's keys`
							)
						}
					}),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "specification",
			name: "each member's meaning over the stored state, the content whole (key-sets.fixtures.ts modelOf), and PostgreSQL's transaction counts of the content rows read"
		},
		box: "the content's readers (key-sets.fixtures.ts Readers): a diamond by the open items, two reads at keys of their own, an unrestricted reader, an anti-join's right, the folds' aggregate, a chain through a join of two growing inputs, a guard union at the call's session; at scale 1 and 16",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\tconst sources = keyed.flatMap((r) =>\n",
				replacement: "\tconst sources = keyed.slice(0, 1).flatMap((r) =>\n",
				why: "A key set keeps its first read's sources alone: the labels the done items read are computed at the open items' keys, and Out1 misses the done item's labels."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\tif (first === undefined || keyed.length !== reads.length) {\n",
				replacement: "\tif (first === undefined) {\n",
				why: "A read that keeps every row no longer makes the node whole: the labels are held at the open items' keys, and the member reading every label writes theirs alone."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: '\t\t\tcase "Step":\n\t\t\tcase "Union":\n',
				replacement: '\t\t\tcase "Union":\n',
				why: "A step keeps none of its reader's keys: the chain's steps, a write member's arms among them, read their inputs whole, and the content rows read grow with the content."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\t\t\t\t\t\t? this.#atLeftRows(reader, reader.left, reader.on, wanted)\n",
				replacement: "\t\t\t\t\t\t? this.keysOf(reader)\n",
				why: "An existence test's right side is keyed as its left, by the test's own readers, not by its left rows through its pairs: the labels on the anti-join's right are whole, and the content rows read grow with the content."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: "\t\t\t\t\t\t\tmerged.set(a, c)\n",
				replacement: "\t\t\t\t\t\t\tmerged.delete(a)\n",
				why: "A correlated read's column fixed to another read's is not equated with it: the chain's join, which the optimizer reads as a LATERAL, keys its links side alone, and its labels side is computed whole."
			},
			{
				file: "packages/engine/src/analysis/physical/rules.ts",
				original:
					"\t\t\t\t\t\trecordFact(fixed, to, { fixed: f.fixed, just: joinJustifications([f.just, just]) })\n\t\t\t\t\t\tgrew = true\n",
				replacement: "\t\t\t\t\t\tvoid to\n",
				why: "A filter's column equated to an outer-fixed column is fixed to a computation, not to that outer column: the chain's LATERAL equates nothing, and its labels side is computed whole."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original:
					"\t\t\t\t\tif (restrictedByValues(q.source) || (held && unitAtValues(region, q))) {\n",
				replacement: "\t\t\t\t\tif (held && unitAtValues(region, q)) {\n",
				why: "A read the statement's values restrict seeds no crossing: the open items no longer key the content, which is computed whole, and the content rows read grow with the content."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original:
					"\t\treturn keys !== undefined && readAtKeys(node) && scope.materialize.get(node.id) === undefined\n",
				replacement:
					"\t\treturn false && keys !== undefined && readAtKeys(node) && scope.materialize.get(node.id) === undefined\n",
				why: "No union or fold the statement lowers in place is read at its keys: the chain's folds beneath its join are computed whole, and the content rows read grow with the content."
			},
			{
				file: "packages/engine/src/lower/shapes/share/statements.ts",
				original: '\t\t\treturn node === share.node && restriction.kind === "keys"\n',
				replacement: '\t\t\treturn false && node === share.node && restriction.kind === "keys"\n',
				why: "A share carried at its keys is filled whole: the labels' part reads every item's tags, and the content rows read grow with the content."
			},
			{
				file: "packages/engine/src/lower/shapes/share/keys.ts",
				original: '\t\t: node.kind !== "Group" || keys.kind === "whole"\n',
				replacement: '\t\t: keys.kind === "whole" || keys.kind === "keys"\n',
				why: "A fold is computed at keys on its aggregate: the labels read by the folds' aggregate restrict each fold below it, which keyedGroup refuses."
			}
		]
	})
