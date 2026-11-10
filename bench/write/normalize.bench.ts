import { Array as Arr, Effect } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { fill, settle } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	installWrites,
	loadedByOwner,
	type ObservedApply,
	type ObservedStatement,
	observedChange,
	openFull,
	theStatement,
	timedSamples,
	warmedOnce
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { ParamMap } from "#compiler/types/core/phantom.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"
import { refusedLaws } from "#test/support/refused.ts"

/**
 * R34: normalize unnormalized input before the arbiter insert.
 *
 * "Two facts with one key and different payloads in one member are refused with the key law, never with
 * PostgreSQL's error; a fact repeated in a member counts once; an elision fires only with its evidence".
 * Unnormalized input reaches the arbiter insert as an array member's facts, which each call of a served member gives,
 * or a described member: an array member's facts are normalized on the host, and a described member is normalized in
 * its statement, `SELECT DISTINCT` and the same-key check with its marker column, before the INSERT proposes a row.
 * The statement's form is read off its audited AST (kernel shapeOf). A served workload holds no Stream member, so the
 * host's normalization is met through an array member's call.
 *
 * Measured on a described member over a relation parameter folded onto one key (two facts, one key, different
 * payloads; and two equal facts), a described member projecting a stored relation's key (the evidence that elides both
 * steps), and an array member whose call repeats a fact; and the cost of a described insert of N facts with and
 * without that evidence, each member compiled once before its samples.
 */
const Item = relation("Item", { id: pg.bigint, v: pg.integer }, ["id"])
const Src = relation("Src", { id: pg.bigint, v: pg.integer }, ["id"])
const build = (name: string) => schema(name, { Item, Src }, [])

interface Options extends Readonly<Record<string, unknown>> {
	readonly batch: number
	readonly samples: number
}

/** The facts an accepted outcome made present, over every relation. */
const addedOf = (o: ObservedApply): bigint | "not accepted" =>
	o.value.kind === "accepted"
		? Arr.reduce(o.value.counts, 0n, (sum, x) => sum + x.added)
		: "not accepted"

/** An outcome as its measure reads: its kind, its law when rejected, and the SQLSTATE of its wire failure. */
const outcomeText = (o: ObservedApply): string =>
	`${
		o.value.kind === "invariant-rejected"
			? `invariant-rejected ${Arr.join(
					Arr.map(refusedLaws(o.value.refused), (l) => l.kind),
					", "
				)}`
			: o.value.kind
	}; ${o.failure.kind === "none" ? "no wire failure" : `wire ${o.failure.failure.sqlstate}`}`

export default defineGate({
	name: "write-normalize",
	gates: ["R34"],
	title: "Normalizing described and array members before the arbiter insert",
	scope:
		"A described member folded onto one key, with equal and with different payloads; a described member over a " +
		"stored key, which elides the checks; an array member whose call repeats a fact; described inserts of N facts " +
		"with and without key evidence.",
	phases: ["operationMs"],
	options: {
		full: { batch: 20000, samples: 9 },
		quick: { batch: 500, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installWrites(build("Normal"), "benchnormal", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared)
			const itemKey = namesOf(fx.installed).primaryKeyLaw(Item)
			/** An outcome's law read back to its LawId. */
			const reported = namesOf(fx.installed).reported
			yield* fill(fx, "Src", options.batch * (options.samples + 2), {
				id: "g::int8",
				v: "(g % 7)::int4"
			})
			yield* settle(fx)
			const db = yield* openFull(fx, S)
			/** `changes` compiled into a member of the Db's workload, as the gate observes it. */
			const observed = (changes: unknown) =>
				observedChange(db, changes, attemptLabel, { kind: "none" })
			const applying = (changes: unknown, params: ParamMap) =>
				Effect.flatMap(observed(changes), (change) => change.apply(params))
			/** The one insert statement of Item a ChangeSet compiles to. */
			const itemInsertOf = (changes: unknown): Effect.Effect<ObservedStatement> =>
				Effect.map(observed(changes), (change) =>
					theStatement(
						change.statements,
						"the insert of Item",
						(l) => l.kind === "write" && l.relation === Item.name && l.result.kind === "insert"
					)
				)
			/** Every row of the relation parameter moved onto the key `key`. */
			const folded = ChangeSet.empty(S).insert(
				Item,
				query(S).rule((r) => {
					const rows = r.relation("rows", { n: pg.integer, v: pg.integer })
					const { n, v: x } = v(rows, "rows")
					return r.match(rows, { n, v: x }).find({ id: r.param("key", Item.fields.id), v: x })
				})
			)
			/** A range of Src: the member projects Src's key, so its facts are distinct and unique on Item's key. */
			const fromSrc = ChangeSet.empty(S).insert(
				Item,
				query(S).rule((r) => {
					const { id, v: x } = v(Src, "src")
					return r
						.match(Src, { id, v: x })
						.where(r.ge(id, r.param("from", pg.bigint)), r.lt(id, r.param("to", pg.bigint)))
						.find({ id, v: x })
				})
			)
			/** The same range through a relation parameter of ids, which carries no key evidence onto Item. */
			const fromIds = ChangeSet.empty(S).insert(
				Item,
				query(S).rule((r) => {
					const rows = r.relation("rows", { n: pg.bigint, v: pg.integer })
					const { n, v: x } = v(rows, "rows")
					return r.match(rows, { n, v: x }).find({ id: n, v: x })
				})
			)
			const sameKey = yield* applying(folded, {
				rows: [
					{ n: 1, v: 1 },
					{ n: 2, v: 2 }
				],
				key: 1n
			})
			const repeated = yield* applying(folded, {
				rows: [
					{ n: 1, v: 5 },
					{ n: 2, v: 5 }
				],
				key: 2n
			})
			const items = yield* observed(ChangeSet.empty(S).insert(Item, []))
			const arrayed = yield* items.applyWith(
				{
					insert: {
						Item: [
							{ id: 3n, v: 1 },
							{ id: 3n, v: 1 },
							{ id: 4n, v: 1 }
						]
					}
				},
				{}
			)
			const foldedInsert = yield* itemInsertOf(folded)
			const srcInsert = yield* itemInsertOf(fromSrc)
			const foldedShape = shapeOf(foldedInsert.ast)
			const srcShape = shapeOf(srcInsert.ast)
			/** Past the keys the cases above inserted. */
			let next = 1000
			const evidenced = yield* observed(fromSrc)
			const withEvidence = yield* timedSamples(
				options.samples,
				() => {
					const from = next
					next += options.batch
					return evidenced.apply({ from: BigInt(from), to: BigInt(from + options.batch) })
				},
				0
			)
			const unevidenced = yield* observed(fromIds)
			const withoutEvidence = yield* timedSamples(
				options.samples,
				() => {
					const from = 10000000 + next
					next += options.batch
					return unevidenced.apply({
						rows: Arr.map(indices(options.batch), (i) => ({ n: BigInt(from + i), v: 1 }))
					})
				},
				0
			)
			/**
			 * The SQLSTATE of the same-key refusal's wire failure is grizzle's, never PostgreSQL's own cardinality or unique
			 * violation.
			 */
			const sameKeyWire = sameKey.failure
			const cases: Array<CaseRecord<"R34">> = [
				{
					name: "same-key and repeated facts in a described and an array member",
					gates: ["R34"],
					conditions: {
						workload:
							"a served member's apply of a described insert folding two relation-parameter rows onto one key, and of an array member whose call repeats a fact",
						schemaState: loadedByOwner,
						dataDistribution: "Item empty at those keys",
						parameters: {},
						resultSemantics:
							"two facts at one key with different payloads are invariant-rejected with the key law; equal facts count once",
						cacheState: warmedOnce
					},
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						sameKey: outcomeText(sameKey),
						repeated: `${repeated.value.kind} added ${addedOf(repeated)}`,
						arrayed: `${arrayed.value.kind} added ${addedOf(arrayed)}`,
						foldedStatement: foldedInsert.sql,
						storedKeyStatement: srcInsert.sql
					}
				},
				{
					name: `a described insert of ${options.batch} facts with and without key evidence`,
					gates: ["R34"],
					conditions: {
						workload:
							"a served member's apply of a described insert projecting Src's key over a range, and of the same facts through a relation parameter",
						schemaState: loadedByOwner,
						dataDistribution: `Src holds ${options.batch * (options.samples + 2)} facts`,
						parameters: { batch: options.batch },
						resultSemantics: "every fact is new; accepted",
						cacheState: warmedOnce
					},
					phases: { operationMs: withEvidence.ms },
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						withoutEvidenceOperationMs: withoutEvidence.ms,
						outcomes: Arr.join(
							Arr.map([...withEvidence.values, ...withoutEvidence.values], (o) => o.value.kind),
							", "
						)
					}
				}
			]
			const r34: VerdictInput = {
				checks: [
					mechanism(
						"without evidence the insert statement deduplicates and checks the key before the INSERT",
						has(foldedShape, "distinct") && has(foldedShape, "having"),
						foldedInsert.sql
					),
					mechanism(
						"a member projecting a stored relation's key elides the same-key check",
						!has(srcShape, "having"),
						srcInsert.sql
					),
					mechanism(
						"a member projecting a stored relation's key elides SELECT DISTINCT",
						!has(srcShape, "distinct"),
						srcInsert.sql
					),
					equivalence(
						"two facts with one key and different payloads are refused with the key law, never PostgreSQL's error",
						sameKey.value.kind === "invariant-rejected" &&
							Arr.every(refusedLaws(sameKey.value.refused), (l) => reported(l) === itemKey) &&
							(sameKeyWire.kind === "none" ||
								(sameKeyWire.failure.sqlstate !== "21000" &&
									sameKeyWire.failure.sqlstate !== "23505")),
						outcomeText(sameKey)
					),
					equivalence(
						"a fact repeated in a described member counts once",
						addedOf(repeated) === 1n,
						`${repeated.value.kind} added ${addedOf(repeated)}`
					),
					equivalence(
						"a fact repeated in an array member's call counts once",
						addedOf(arrayed) === 2n,
						`${arrayed.value.kind} added ${addedOf(arrayed)}`
					),
					equivalence(
						"with and without evidence every batch is accepted",
						Arr.every(
							[...withEvidence.values, ...withoutEvidence.values],
							(o) => o.value.kind === "accepted"
						),
						Arr.join(
							Arr.map([...withEvidence.values, ...withoutEvidence.values], (o) => o.value.kind),
							", "
						)
					)
				]
			}
			return { cases, verdicts: { R34: r34 } }
		})
})
