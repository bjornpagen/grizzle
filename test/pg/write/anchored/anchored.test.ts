import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
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
import type { StatementSpec } from "#compiler/ir/products.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts } from "#test/support/compile.ts"
import { Instant } from "#test/support/fixtures/api/contracts.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
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
 * back. The plan does not depend on the parameters' values, only on the statement and the statistics. The property is the plan's contract, not its text: exactly one node reads Wanted, and an index
 * condition bounds it. Every member shape is planned (exhaust), each a required feature. */
const shapes = [
	"the claim's deletion of the Wanted items its pick names",
	"a deletion of the Wanted items a relation parameter names",
	"a deletion of the Wanted item a parameter selects"
] as const
type Shape = (typeof shapes)[number]

type AnchoredFeature = `${Shape}: Wanted read once, by an index condition`

/** Wanted and Work items loaded, keyed by digest: enough that a probe per input row is the right join at any estimate of
 * a relation parameter's arrays, their length in a custom plan and the default ten in a generic one. */
const items = 200_000

const hostParams: Readonly<Record<string, unknown>> = {
	kind: "render",
	slot: Slot(0),
	now: Instant(1n),
	from: Digest(Str.repeat(64)("0")),
	resource: "gpu",
	fromSeat: SeatNo(0),
	expires: Instant(2n),
	key: Digest(Str.repeat(64)("f")),
	keys: [{ key: Digest(Str.repeat(64)("a")) }, { key: Digest(Str.repeat(64)("b")) }]
}

/**
 * The placeholder texts of a statement, each through its own encoder, from the fixed parameters: a relation
 * parameter's placeholder its array at its part.
 */
const texts = (spec: StatementSpec): ReadonlyArray<string> =>
	Arr.map(spec.paramSlots, (slot) => {
		switch (slot.kind) {
			case "scalar":
				return succeeded(slot.encode(hostParams[slot.param]), `the parameter ${slot.param}`)
			case "relation": {
				const arrays = succeeded(slot.encode(hostParams[slot.param]), `the parameter ${slot.param}`)
				const array = arrays[slot.part]
				if (array === undefined) {
					throw new Error(`the parameter ${slot.param} has no array ${slot.part}`)
				}
				return array
			}
			case "member":
			case "page":
				throw new Error(`a ${slot.kind} placeholder`)
		}
	})

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
	it.effect(
		"reads its relation once, by an index condition",
		(ctx) =>
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
								installation: o.installation.settings.installation,
								vectorSchema: undefined
							})
						)
					)
					const table = (relation: string) => printObjectName(names.relation(relation))
					const column = (relation: string, field: string) =>
						quoteIdent(names.column(relation, field))
					const kind = printObjectName(names.enumType(parsedName("Kind")))
					const standing = printObjectName(names.enumType(parsedName("Standing")))
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
						)}) SELECT ${digestOf("g")}, 'render'::${kind}, 0, 'wanted'::${standing}, 0, g FROM pg_catalog.generate_series(1, ${items}) AS g`,
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
					return yield* exhaust(
						{
							suite: "pg/write/anchored",
							generator: element(shapes),
							literal: Formatter.format,
							limit: shapes.length,
							coverage: requiredInSpace<AnchoredFeature>(
								Arr.map(
									shapes,
									(shape): AnchoredFeature => `${shape}: Wanted read once, by an index condition`
								)
							),
							caseHang: Duration.minutes(2)
						},
						(shape, c) =>
							Effect.gen(function* () {
								const desc = changeSetDesc(members[shape])
								if (desc === undefined) {
									throw new Error(`${shape}: no ChangeSet`)
								}
								const program = compileWrite(checking(S), desc, reality)
								if (!program.ok) {
									throw new Error(`${shape}: ${program.error.message}`)
								}
								const statements = program.value.artifacts.optimized.statements
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
												yield* pinned.query(st.spec.sql, texts(st.spec))
											}
										}
										const rows = yield* pinned.queryValues(
											`EXPLAIN (FORMAT JSON) ${deletion.spec.sql}`,
											texts(deletion.spec)
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
							})
					)
				})
			),
		300_000
	)
})
