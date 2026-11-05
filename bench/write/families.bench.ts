import { Array as Arr, Effect, Result } from "effect"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { GateSetupError, settle } from "#bench/query/support/kit.ts"
import {
	attemptLabel,
	familyWritesOf,
	installWrites,
	loadedByOwner,
	observedChange,
	oneRow,
	openFull,
	writeConditions,
	writePhases,
	writesOf
} from "#bench/write/support/writes.ts"
import { indices } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { drawn, natural, pg } from "#compiler/public/fields.ts"
import { fin, mutable, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * families (W5.BF): what a family's writes cost, by the family's length (fin.md §4.5, §5.3).
 *
 * The gate's text is the families entry of bench/harness/rules.ts. The mechanisms measured:
 * - a fresh family is written with its owner: the program inserts the owner once and its members by the family's
 *   INSERT alone (write/program/artifact.ts FamilyStep), with no count statement, since the count is drawn from the
 *   nested array and written with the owner (D4, D5);
 * - each count change rewrites the copy ‹n› on every sibling: an UPDATE of one owner's drawn count, by the owner, cascades
 *   over the owner axis's ON UPDATE CASCADE to exactly its n members, so a growth touches n member rows, O(n). The
 *   transaction is rolled back before COMMIT, so the deferred last-slot foreign key the bare UPDATE breaks is never
 *   checked: the reading is the cascade's work alone.
 *
 * Every figure is recorded beside its check; times gate nothing until a full run of the gate on the build it runs on
 * has measured a ceiling for them.
 */
const Owner = relation("Owner", { id: pg.integer, members: drawn(natural) }, ["id"])
const Item = relation("Item", { owner: pg.integer, at: drawn(natural), payload: pg.integer }, [
	"owner",
	"at"
])
const items = ordered(on(Item, "owner", "at"), fin(Owner, "members"))

const build = (name: string) =>
	schema(name, { Owner, Item }, [items, mutable(Owner), mutable(Item)])

interface Options extends Readonly<Record<string, unknown>> {
	/** The lengths of the families written, one owner each. */
	readonly lengths: ReadonlyArray<number>
}

/** The ChangeSet inserting owner `id` with a family of `length` members, nested at its count field. */
const freshFamily = (s: ReturnType<typeof build>, id: number, length: number) =>
	ChangeSet.empty(s).insert(Owner, [
		{ id, members: Arr.map(indices(length), (k) => ({ payload: k })) }
	])

/** @internal */
export default defineGate({
	name: "write-families",
	gates: ["families"],
	title:
		"A family's writes: its fresh insert's statements, and the copy ‹n› a count change rewrites on every sibling",
	scope:
		"one owner with a family of each length written through a Db; then, by the owner, one UPDATE of each owner's drawn " +
		"count, rolled back, and the member rows its cascade updated.",
	phases: writePhases,
	options: {
		full: { lengths: [10, 1000, 100000] },
		quick: { lengths: [10, 200] }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const fx = yield* installWrites(build("Families"), "benchfamilies", {
				programs: {},
				logins: []
			})
			const S = build(fx.installed.declared)
			const O = fx.table("Owner")
			const I = fx.table("Item")
			const c = (rel: string, f: string) => fx.column(rel, f)
			const fresh: Array<{
				readonly length: number
				readonly ownerInserts: number
				readonly ownerUpdates: number
				readonly itemWrites: number
				readonly itemUpdates: number
				readonly applied: string
			}> = []
			for (const [i, length] of options.lengths.entries()) {
				const run = yield* Effect.scoped(
					Effect.gen(function* () {
						const db = yield* openFull(fx, S)
						const change = observedChange(db, freshFamily(S, i + 1, length), attemptLabel, {
							kind: "none"
						})
						if (Result.isFailure(change)) {
							return yield* Effect.die(change.failure)
						}
						const applied = yield* change.success.apply({})
						return { statements: change.success.statements, applied }
					})
				)
				const owner = writesOf(run.statements, "Owner")
				const counts = Arr.filter(
					familyWritesOf(run.statements, "Owner"),
					(f) => f.statement === "count"
				)
				const item = familyWritesOf(run.statements, "Item")
				fresh.push({
					length,
					ownerInserts: Arr.filter(owner, (w) => w.result.kind === "insert").length,
					ownerUpdates: Arr.filter(owner, (w) => w.result.kind !== "insert").length + counts.length,
					itemWrites: item.length,
					itemUpdates: Arr.filter(item, (f) => f.statement !== "insert").length,
					applied: run.applied.value.kind
				})
			}
			yield* settle(fx)
			/** One owner's count raised by one, by the owner, its cascade's member updates read before the rollback. */
			const cascaded = (id: number) =>
				Effect.gen(function* () {
					yield* s.admin.query("BEGIN", [])
					return yield* Effect.gen(function* () {
						yield* s.admin.query(
							`UPDATE ${O} SET ${c("Owner", "members")} = ${c("Owner", "members")} + 1 WHERE ${c("Owner", "id")} = $1::int4`,
							[String(id)]
						)
						const rows = yield* s.admin.queryValues(
							"SELECT n_tup_upd::text FROM pg_catalog.pg_stat_xact_user_tables WHERE relid = $1::regclass",
							[I]
						)
						return Number(trusted<readonly [string]>(oneRow(rows))[0])
					}).pipe(Effect.ensuring(Effect.orDie(s.admin.query("ROLLBACK", []))))
				})
			const growth: Array<{ readonly length: number; readonly updated: number }> = []
			for (const [i, length] of options.lengths.entries()) {
				const updated = yield* cascaded(i + 1)
				growth.push({ length, updated })
			}
			const cases: Array<CaseRecord<"families">> = Arr.map(options.lengths, (length, i) => ({
				name: `a family of ${length} members`,
				gates: ["families"],
				conditions: writeConditions({
					workload: `one owner with ${length} nested members written through a Db; then one UPDATE of its count by the owner, rolled back`,
					schemaState: loadedByOwner,
					data: `${options.lengths.length} owners, one family each`,
					parameters: { length },
					semantics:
						"the fresh family is lawful and commits; the count's UPDATE is rolled back unchecked",
					cache: "a fresh Db per family; the UPDATE on the owner's warm session"
				}),
				phases: {},
				variants: [],
				comparisons: [],
				transactions: {},
				loads: {},
				measures: {
					ownerInserts: fresh[i]?.ownerInserts ?? -1,
					ownerUpdates: fresh[i]?.ownerUpdates ?? -1,
					itemWrites: fresh[i]?.itemWrites ?? -1,
					cascadedMemberUpdates: growth[i]?.updated ?? -1
				}
			}))
			if (fresh.length !== options.lengths.length || growth.length !== options.lengths.length) {
				throw new GateSetupError({ what: "a family length was not measured" })
			}
			const families: VerdictInput = {
				checks: [
					mechanism(
						"a fresh family is its owner's one INSERT and its members' INSERTs: no owner or member UPDATE",
						Arr.every(
							fresh,
							(f) => f.ownerInserts === 1 && f.ownerUpdates === 0 && f.itemUpdates === 0
						),
						Arr.join(
							Arr.map(
								fresh,
								(f) =>
									`${f.length}: owner ${f.ownerInserts} insert, ${f.ownerUpdates} update; ${f.itemWrites} member writes`
							),
							", "
						)
					),
					mechanism(
						"a count change rewrites ‹n› on every sibling: one owner UPDATE updates exactly its n members",
						Arr.every(growth, (g) => g.updated === g.length),
						Arr.join(
							Arr.map(growth, (g) => `${g.updated} of ${g.length}`),
							", "
						)
					),
					equivalence(
						"every fresh family was accepted",
						Arr.every(fresh, (f) => f.applied === "accepted"),
						Arr.join(
							Arr.map(fresh, (f) => f.applied),
							", "
						)
					)
				]
			}
			return { cases, verdicts: { families } }
		})
})
