import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, increasing, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { type EstimatedNode, parsePlanTree, planNodes } from "#bench/harness/explain.ts"
import {
	claimOf,
	Digest,
	digestOf,
	queueSchema,
	SeatNo,
	Slot,
	Wanted
} from "#bench/queue/support/queue.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { flightOf } from "#compiler/write/program/served.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { installedCodes, paramValues, realityWrite, testArtifacts } from "#test/support/compile.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import { QueueKind, Resource } from "#test/support/fixtures/api/queue.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { transaction } from "#test/support/oracle/install/transaction.ts"
import { checking } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** A deletion whose member is its relation's own facts reads that relation once.
 *
 * The work queue's claim deletes the Wanted facts its pick names: a member that matches Wanted and returns its fields.
 * The DELETE's target plays that match, so the deletion statement reads Wanted once, by its key, where comparing the
 * member against the relation read it twice, two index probes per claim. The same holds for every anchored member:
 * one joined to a relation parameter, and one that selects the relation's facts by a parameter.
 *
 * The queue schema is installed and loaded with enough Work and Wanted items that a
 * probe by key is far cheaper than a scan, and analyzed. Each member's ChangeSet is compiled against the installation
 * (`compileWrite`), and in one transaction the statements before its deletion that make the carriers it
 * reads run with fixed parameters; then its deletion is planned (EXPLAIN, FORMAT JSON) and the transaction rolled
 * back. A case draws the member's shape and every parameter's value: digests of loaded items and of none, a relation
 * parameter of no keys to several, the claim's kind, resource, slot, seat and instants; PostgreSQL plans the deletion
 * for those values, as a custom plan does. The property is the plan's contract, not its text: exactly one node reads
 * Wanted, and an index condition bounds it, whatever the values. Each shape is a required feature, as are a relation
 * parameter of no keys and one of several.
 *
 * Plant: ~/.cache/grizzle-release/BR08/plants/anchored-delete-never-anchored.patch, an exact deletion never anchored on
 * its relation's occurrence, must turn the property red.
 */
type Shape =
	| "the claim's deletion of the Wanted items its pick names"
	| "a deletion of the Wanted items a relation parameter names"
	| "a deletion of the Wanted item a parameter selects"

type AnchoredFeature =
	| `${Shape}: Wanted read once, by an index condition`
	| "a relation parameter of no keys"
	| "a relation parameter of several keys"

/** Wanted and Work items loaded, keyed by digest: enough that a probe per input row is the right join at any estimate of
 * a relation parameter's arrays, their length in a custom plan and the default ten in a generic one. */
const items = 200_000

/**
 * One member's shape, and every parameter any member reads, drawn: the plan is the deletion's for these values. An item
 * is named by its number, whose digest the load computes (digestOf): within the load for 1 to `items`, of no item
 * beyond.
 */
interface Anchored {
	readonly shape: Shape
	readonly keys: ReadonlyArray<number>
	readonly from: number
	readonly key: number
	readonly params: Readonly<Record<string, unknown>>
}

const itemGen = int(1, 2 * items)

const anchoredGen: Gen<Anchored> = (source) => {
	const shape = source.draw(
		element([
			"the claim's deletion of the Wanted items its pick names",
			"a deletion of the Wanted items a relation parameter names",
			"a deletion of the Wanted item a parameter selects"
		] as const)
	)
	const keys = source.draw(
		weighted<ReadonlyArray<number>>([
			[1, constant([])],
			[2, increasing(1, 2 * items, { min: 1, max: 4 })]
		])
	)
	return {
		shape,
		params: {
			kind: source.draw(element(QueueKind.handles)),
			slot: Slot(source.draw(int(0, 3))),
			now: Instant(BigInt(source.draw(int(0, 3)))),

			resource: source.draw(element(Resource.handles)),
			fromSeat: SeatNo(source.draw(int(0, 3))),
			expires: Instant(BigInt(source.draw(int(0, 3))))
		},
		keys,
		from: source.draw(itemGen),
		key: source.draw(itemGen)
	}
}

/** Every node of a plan that reads `relation`'s rows: not the DELETE itself, nor a bitmap index scan, which only yields
 * row locations to its heap scan. */
const reads = (plan: EstimatedNode, relation: string): ReadonlyArray<EstimatedNode> =>
	planNodes(plan)
		.filter(
			(n) =>
				Option.contains(n.relation, relation) &&
				Option.isNone(n.operation) &&
				n.nodeType !== "Bitmap Index Scan"
		)
		.toArray()

/** An index condition bounds the read: an Index Cond on an index scan, a Recheck Cond on a bitmap heap scan. */
const bounded = (n: EstimatedNode): boolean =>
	((n.nodeType === "Index Scan" || n.nodeType === "Index Only Scan") &&
		Option.isSome(n.indexCond)) ||
	(n.nodeType === "Bitmap Heap Scan" && Option.isSome(n.recheckCond))

layer(Substrate.layer, { excludeTestServices: true })("an anchored deletion", (it) => {
	it.effect("reads its relation once, by an index condition", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const o = yield* install(queueSchema("Queue"), {
					ambient: ordinarySession,
					label: "anchored",
					extensions: [],
					logins: []
				})
				const S = queueSchema(o.schema)
				const names = o.installation.names
				const reality = realityWrite(
					succeeded(
						testArtifacts(S, {
							installation: o.installation.names.installation,
							codes: installedCodes(names.codes)
						})
					)
				)
				const table = (relation: string) => printObjectName(names.relation(relation))
				const column = (relation: string, field: string) =>
					quoteIdent(names.column(relation, field))
				const codeIn = (roster: string, handle: string): string =>
					`${codeOf(defined(names.codes.rosters.get(parsedName(roster)), `the codes of ${roster}`), handle)}::smallint`
				const governed = ["Work", "Wanted"]
				yield* transaction(
					s.admin,
					Arr.map(governed, (t) => `ALTER TABLE ${table(t)} DISABLE TRIGGER USER`)
				)
				yield* transaction(s.admin, [
					`INSERT INTO ${table("Work")} (${Arr.join(
						Arr.map(["key", "kind", "slot", "standing", "epoch", "enqueued"], (f) =>
							column("Work", f)
						),
						", "
					)}) SELECT ${digestOf("g")}, ${codeIn("Kind", "render")}, 0, ${codeIn("Standing", "wanted")}, 0, g FROM pg_catalog.generate_series(1, ${items}) AS g`,
					`INSERT INTO ${table("Wanted")} (${Arr.join(
						Arr.map(["key", "due", "attempts"], (f) => column("Wanted", f)),
						", "
					)}) SELECT ${digestOf("g")}, 0, 0 FROM pg_catalog.generate_series(1, ${items}) AS g`
				])
				yield* transaction(
					s.admin,
					Arr.map(governed, (t) => `ALTER TABLE ${table(t)} ENABLE TRIGGER USER`)
				)
				yield* s.admin.query(`VACUUM (ANALYZE) ${Arr.join(Arr.map(governed, table), ", ")}`, [])

				const members: { readonly [K in Shape]: unknown } = {
					"the claim's deletion of the Wanted items its pick names": claimOf(S),
					"a deletion of the Wanted items a relation parameter names": ChangeSet.empty(S).delete(
						Wanted,
						query(S).rule((r) => {
							const named = r.relation("keys", { key: Wanted.fields.key })
							const { key, due, attempts } = v(Wanted, "wanted")
							return r
								.match(named, { key })
								.match(Wanted, { key, due, attempts })
								.find({ key, due, attempts })
						})
					),
					"a deletion of the Wanted item a parameter selects": ChangeSet.empty(S).delete(
						Wanted,
						query(S).rule((r) => {
							const { key, due, attempts } = v(Wanted, "wanted")
							return r
								.match(Wanted, { key, due, attempts })
								.where(r.eq(key, r.param("key", Wanted.fields.key)))
								.find({ key, due, attempts })
						})
					)
				}
				const wanted = names.relation("Wanted").name
				/** Each member's ChangeSet compiled against the installation, once: its plan is drawn per case. */
				const compiledOf = (shape: Shape) => {
					const desc = changeSetDesc(members[shape])
					if (desc === undefined) {
						throw new Error(`${shape}: no ChangeSet`)
					}
					const program = compileWrite(checking(S), desc, reality)
					if (!program.ok) {
						throw new Error(`${shape}: ${program.error.message}`)
					}
					return program.value
				}
				const programs = {
					"the claim's deletion of the Wanted items its pick names": compiledOf(
						"the claim's deletion of the Wanted items its pick names"
					),
					"a deletion of the Wanted items a relation parameter names": compiledOf(
						"a deletion of the Wanted items a relation parameter names"
					),
					"a deletion of the Wanted item a parameter selects": compiledOf(
						"a deletion of the Wanted item a parameter selects"
					)
				}
				return yield* explore(
					{
						suite: "pg/write/anchored",
						draw: drawn(anchoredGen),
						literal: Formatter.format,
						oracle: {
							kind: "postgresql",
							name: "PostgreSQL's plan of the deletion for the drawn values: one node reads Wanted, bounded by an index condition"
						},
						coverage: required<AnchoredFeature>(
							[
								"the claim's deletion of the Wanted items its pick names: Wanted read once, by an index condition",
								"a deletion of the Wanted items a relation parameter names: Wanted read once, by an index condition",
								"a deletion of the Wanted item a parameter selects: Wanted read once, by an index condition",
								"a relation parameter of no keys",
								"a relation parameter of several keys"
							],
							{ cases: 48, sense: notesOnly }
						),
						kept: [],
						runs: 12,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					({ shape, keys, from, key, params }, c) =>
						Effect.gen(function* () {
							const numbered = [from, key, ...keys]
							const digestRows = yield* s.admin.queryValues(
								`SELECT ${digestOf("n")} FROM pg_catalog.unnest(ARRAY[${Arr.join(Arr.map(numbered, String), ", ")}]::integer[]) WITH ORDINALITY AS u (n, at) ORDER BY at`,
								[]
							)
							const digests = Arr.map(digestRows, (row) => Digest(String(row[0])))
							const digestOfItem = (at: number) => defined(digests[at], `the digest of item ${at}`)
							const hostParams: Readonly<Record<string, unknown>> = {
								...params,
								from: digestOfItem(0),
								key: digestOfItem(1),
								keys: Arr.map(keys, (_, i) => ({ key: digestOfItem(i + 2) }))
							}
							const program = programs[shape]
							const statements = flightOf(program, names.codes).statements
							/**
							 * Each placeholder from the drawn parameters, as its statement binds it, a relation's normalized once:
							 * the key of Wanted is text, so a relation parameter of keys travels as a binary text[].
							 */
							const declared = { params: program.params, codes: names.codes }
							const found = Arr.findFirst(statements, (st, at) =>
								st.step.kind === "write" &&
								st.step.relation === Wanted.name &&
								st.step.result.kind === "delete"
									? Option.some({ deletion: st, at })
									: Option.none()
							)
							if (Option.isNone(found)) {
								throw new Error(`${shape}: no deletion of Wanted`)
							}
							const { deletion, at } = found.value
							/** The carriers the deletion reads, made and filled in one transaction, then the deletion planned. */
							const plan = yield* Effect.scoped(
								Effect.gen(function* () {
									const pinned = yield* s.admin.pin
									yield* pinned.query("BEGIN", [])
									for (const st of statements.slice(0, at)) {
										if (st.step.kind === "carrier" || st.step.kind === "analyze") {
											yield* pinned.query(
												st.form.text.sql,
												paramValues(st.form, hostParams, declared)
											)
										}
									}
									const rows = yield* pinned.queryValues(
										`EXPLAIN (FORMAT JSON) ${deletion.form.text.sql}`,
										paramValues(deletion.form, hostParams, declared)
									)
									yield* pinned.query("ROLLBACK", [])
									return succeeded(parsePlanTree(rows[0]?.[0]), "one EXPLAIN plan")
								})
							)
							const read = reads(plan, wanted)
							assert.equal(
								read.length,
								1,
								`${shape}: ${Arr.join(
									Arr.map(read, (n) => n.nodeType),
									", "
								)} read Wanted`
							)
							assert.deepEqual(
								Arr.map(
									Arr.filter(read, (n) => !bounded(n)),
									(n) => n.nodeType
								),
								[],
								`${shape}: these nodes read Wanted unbounded`
							)
							c.note(`${shape}: Wanted read once, by an index condition`)
							if (shape === "a deletion of the Wanted items a relation parameter names") {
								if (keys.length > 1) {
									c.note("a relation parameter of several keys")
								}
								if (keys.length === 0) {
									c.note("a relation parameter of no keys")
								}
							}
						})
				)
			})
		)
	)
})
