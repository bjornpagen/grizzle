/**
 * `natural` and `pred` against PostgreSQL 19rc1, through the engine's own lowering: the domain a `natural` field is,
 * the STORED generated column a `pred` term is, and the foreign keys between the two, out of pred's column into a
 * natural key and out of a selected side's natural columns into pred's column.
 *
 * A partial term is null outside its definition, pred(x) at x = 0 among them. pred's column is generated as the natural
 * domain's base, int8, as every law column is typed by its base (physical/ddl/names.ts lawColumnType): its value,
 * x - 1 where x > 0, is a natural its generation proves, so the domain's CHECK would only judge it again. 19rc1 would
 * take the domain, since it refuses a domain only to a virtual generated column (catalog/heap.c CheckAttributeType). A
 * box of no slots leaves pred's column null: the last slot's foreign key, out of that column, passes, and marked's,
 * into it, finds no key there, so the box's state is admitted and a slot marked last in it refused.
 *
 * Each case installs the real installation of the schema in a transaction of a pinned session, and writes each of its
 * drawn states whole under a savepoint: one INSERT per relation, the slots successor before predecessor
 * (`successorFirst`), then every deferred constraint checked at once (SET CONSTRAINTS ALL IMMEDIATE), so the verdict is
 * the state's whichever foreign keys the installation defers.
 *
 * Oracle, the specification turned into a checker: a state holding a negative count or index is refused as it is
 * written, with a check violation under the natural domain, its boxes' INSERT first; any other is admitted exactly
 * when the host meaning of its laws holds (`broken`), and otherwise refused with a foreign key violation under a
 * constraint the installation maps to one of the laws it breaks.
 *
 * A state is drawn box by box (boxGen), each draw a named, weighted case of the representation: a box absent or present
 * with a count of 0 to 3 or a negative one; its slots a run from 0 covering the count or falling short of it; a gap in
 * the run or none; a mark on no slot, on the count's last or on another; and a slot at a negative index or none. So
 * lawful states and states breaking each law are drawn as often as their weights say, never filtered for.
 *
 * Features: a state admitted, one beside a box of no slots, each law refusing, marked refusing under a box of no slots,
 * and the domain refusing a negative count and a negative index. Plants: ~/.cache/grizzle-release/BR09/plants/
 * domains-natural-admits-minus-one.patch, natural's CHECK at VALUE >= -1, admits a count of -1; and
 * domains-pred-defined-at-zero.patch, pred(x) defined at x = 0 as -1, refuses a box of no slots its laws admit.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	proportional,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Result } from "effect"
import { appendAll, indices } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { type ConstraintLaws, constraintLaw } from "#compiler/ir/products.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { natural, pg } from "#compiler/public/fields.ts"
import { contained, on, pred, relation, schema, select } from "#compiler/public/schema.ts"
import { assert } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import type { PgConnection, PgErrorFields, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import { reportedOwnerOf } from "#test/support/substrate/errors.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The schema: a box of `slots` slots, each slot at a natural index, and a slot marked last. Its three laws read pred
 * both ways: out of pred's column into the slots' natural key, and out of a selected side's natural columns into
 * pred's column, which a box of no slots leaves null.
 */
const Box = relation("Box", { id: pg.integer, slots: natural }, ["id"])
const Slot = relation("Slot", { box: pg.integer, at: natural, last: pg.boolean }, ["box", "at"])
/** Every slot above 0 follows its predecessor. */
const follows = contained(on(Slot, "box", pred("at")), on(Slot, "box", "at"))
/** A box of n > 0 slots holds its last, at n - 1. */
const lastSlot = contained(on(Box, "id", pred("slots")), on(Slot, "box", "at"))
/** A slot marked last sits at its box's n - 1, which a box of no slots has none of. */
const marked = contained(
	on(
		select(Slot, (x) => x.eq(x.last, true)),
		"box",
		"at"
	),
	on(Box, "id", pred("slots"))
)
const Slots = schema("Slots", [Box, Slot], [follows, lastSlot, marked])

interface BoxRow {
	readonly id: number
	readonly slots: number
}

interface SlotRow {
	readonly box: number
	readonly at: number
	readonly last: boolean
}

/** One state a probe writes whole: boxes of distinct ids, and slots of distinct boxes and indexes. */
interface State {
	readonly boxes: ReadonlyArray<BoxRow>
	readonly slots: ReadonlyArray<SlotRow>
}

/** A law of the schema, as the host states it. */
type Rule = "follows" | "last slot" | "marked"

const hasSlot = (state: State, box: number, at: number): boolean =>
	Arr.some(state.slots, (x) => x.box === box && x.at === at)

/** The laws a state breaks, read from their statements' meaning: pred(x) is x - 1 for x > 0, and undefined at 0. */
const broken = (state: State): ReadonlyArray<Rule> => [
	...(Arr.some(state.slots, (x) => x.at > 0 && !hasSlot(state, x.box, x.at - 1))
		? (["follows"] as const)
		: []),
	...(Arr.some(state.boxes, (b) => b.slots > 0 && !hasSlot(state, b.id, b.slots - 1))
		? (["last slot"] as const)
		: []),
	...(Arr.some(
		state.slots,
		(x) =>
			x.last && !Arr.some(state.boxes, (b) => b.id === x.box && b.slots > 0 && b.slots - 1 === x.at)
	)
		? (["marked"] as const)
		: [])
]

/** What a case reached: each law refusing, its states admitted, pred's undefined zero, and the domain's refusals. */
type DomainFeature =
	| "admitted"
	| "admitted beside a box of no slots"
	| "refused by follows"
	| "refused by the last slot"
	| "refused by marked"
	| "refused by marked under a box of no slots"
	| "natural refuses a negative count"
	| "natural refuses a negative index"

const situations = [
	"admitted",
	"admitted beside a box of no slots",
	"refused by follows",
	"refused by the last slot",
	"refused by marked",
	"refused by marked under a box of no slots",
	"natural refuses a negative count",
	"natural refuses a negative index"
] as const satisfies ReadonlyArray<DomainFeature>

const ruleFeature: Readonly<Record<Rule, DomainFeature>> = {
	follows: "refused by follows",
	"last slot": "refused by the last slot",
	marked: "refused by marked"
}

const boxIds = [1, 2] as const

/** The highest index a box's slots run to: four slots at most, past every count a box draws. */
const lastIndex = 3

/** A box's count: a natural from 0 to 3, or a negative one, which the natural domain refuses. */
const countGen: Gen<number> = weighted<number>([
	[6, int(0, 3)],
	[1, constant(-1)]
])

/**
 * One box's part of a state: absent, or present with its count; its slots a run from index 0, covering the count, so
 * its last slot is held, or falling short of it; a gap in the run below its last slot, or none; a mark on no slot, on the
 * count's last, or on another slot of the run; and a slot at a negative index, or none. Each choice is weighted, so a
 * lawful box is drawn as often as a box breaking each law, and none is filtered; a choice a box cannot take, a run short
 * of a count of none or a gap in a run of one, is no arm of its draw.
 */
const boxGen =
	(box: number): Gen<State> =>
	(source) => {
		const count = source.draw(
			weighted<number | undefined>([
				[1, constant(undefined)],
				[3, countGen]
			])
		)
		const needed = count === undefined ? 0 : Math.max(count, 0)
		const run = source.draw(
			proportional<number>([
				[4, int(needed, lastIndex + 1)],
				...(needed > 0 ? [[1, int(0, needed - 1)] as const] : [])
			])
		)
		const gap = source.draw(
			proportional<number | undefined>([
				[4, constant(undefined)],
				...(run > 1 ? [[1, int(0, run - 2)] as const] : [])
			])
		)
		const held = Arr.filter(indices(run), (at) => at !== gap)
		const last = count === undefined || count < 1 ? undefined : count - 1
		const mark = source.draw(
			proportional<number | undefined>([
				[2, constant(undefined)],
				...(last !== undefined && held.includes(last) ? [[2, constant(last)] as const] : []),
				...(Arr.isReadonlyArrayNonEmpty(held) ? [[1, element(held)] as const] : [])
			])
		)
		const negative = source.draw(
			weighted<boolean>([
				[8, constant(false)],
				[1, constant(true)]
			])
		)
		return {
			boxes: count === undefined ? [] : [{ id: box, slots: count }],
			slots: [
				...Arr.map(held, (at) => ({ box, at, last: at === mark })),
				...(negative ? [{ box, at: -1, last: false }] : [])
			]
		}
	}

/** A state: each box's part (boxGen). */
const stateGen: Gen<State> = (source) => {
	const parts = Arr.map(boxIds, (box) => source.draw(boxGen(box)))
	return {
		boxes: Arr.flatMap(parts, (p) => p.boxes),
		slots: Arr.flatMap(parts, (p) => p.slots)
	}
}

/** A case's states: one to four, each written whole and rolled back. */
const caseGen: Gen<ReadonlyArray<State>> = array(stateGen, { min: 1, max: 4 })

/** A statement of a probe: its text and its parameters. */
interface Sql {
	readonly text: string
	readonly params: ReadonlyArray<unknown>
}

/** What the server answered a probe: admitted, or refused with the fields of its error. */
type Verdict =
	| { readonly kind: "admitted" }
	| { readonly kind: "refused"; readonly fields: PgErrorFields }

const shown = (verdict: Verdict): string =>
	verdict.kind === "admitted"
		? "admitted"
		: `${verdict.fields.code} ${String(verdict.fields.constraint)}: ${verdict.fields.message}`

/**
 * Successor before predecessor: the predecessor key must admit a single INSERT whose rows arrive in this order, since
 * PostgreSQL checks a foreign key once the statement has inserted every row.
 */
const successorFirst: Order.Order<SlotRow> = Order.flip(
	Order.mapInput(Order.Number, (x: SlotRow) => x.at)
)

/**
 * The installation's statements for a state: one INSERT of its boxes and one of its slots, the slots successor first;
 * every row as the owner writes it, the law columns left to PostgreSQL. A relation with no rows has no statement.
 */
const writerOf = (installation: Installation) => {
	const names = installationNamesOf(installation)
	/** One INSERT of `rows` into `table`'s quoted `columns`, its values numbered in row order; none of no rows. */
	const insert = (
		table: string,
		columns: ReadonlyArray<string>,
		rows: ReadonlyArray<ReadonlyArray<unknown>>
	): ReadonlyArray<Sql> =>
		Arr.isReadonlyArrayNonEmpty(rows)
			? [
					{
						text: `INSERT INTO ${table} (${Arr.join(columns, ", ")}) VALUES ${Arr.join(
							Arr.map(
								rows,
								(row, i) =>
									`(${Arr.join(
										Arr.map(row, (_, j) => `$${i * columns.length + j + 1}`),
										", "
									)})`
							),
							", "
						)}`,
						params: Arr.flatten(rows)
					}
				]
			: []
	return {
		state: (state: State): ReadonlyArray<Sql> => [
			...insert(
				names.table(Box),
				[names.column(Box, "id"), names.column(Box, "slots")],
				Arr.map(state.boxes, (b) => [b.id, b.slots])
			),
			...insert(
				names.table(Slot),
				[names.column(Slot, "box"), names.column(Slot, "at"), names.column(Slot, "last")],
				Arr.map(Arr.sort(state.slots, successorFirst), (x) => [x.box, x.at, x.last])
			)
		],
		laws: {
			follows: names.lawOf(follows),
			"last slot": names.lawOf(lastSlot),
			marked: names.lawOf(marked)
		} satisfies Readonly<Record<Rule, LawId>>
	}
}

/**
 * Runs a probe's statements under a savepoint of the pinned session's open transaction, then checks every deferred
 * constraint at once, and rolls back to the savepoint either way: a probe is one state, judged whole, and leaves nothing
 * behind, its SET CONSTRAINTS among it (commands/trigger.c AfterTriggerEndSubXact restores the deferral state a
 * subtransaction saved). A connection failure is the case's defect, not a verdict.
 */
const probe = (
	pinned: PgConnection,
	statements: ReadonlyArray<Sql>
): Effect.Effect<Verdict, SqlError> =>
	Effect.gen(function* () {
		yield* pinned.query("SAVEPOINT probe", [])
		const ran = yield* Effect.result(
			Effect.gen(function* () {
				for (const statement of statements) {
					yield* pinned.query(statement.text, statement.params)
				}
				yield* pinned.query("SET CONSTRAINTS ALL IMMEDIATE", [])
			})
		)
		yield* pinned.query("ROLLBACK TO SAVEPOINT probe", [])
		if (Result.isSuccess(ran)) {
			return { kind: "admitted" } satisfies Verdict
		}
		const reason = ran.failure.reason
		if (reason._tag !== "ServerError") {
			return yield* ran.failure
		}
		return { kind: "refused", fields: reason.fields } satisfies Verdict
	})

/**
 * A state's verdict against its host meaning: refused by the natural domain where it holds a negative count or index
 * (refusedByDomain); otherwise admitted exactly when it breaks no law, and else refused with a foreign key violation
 * under a constraint the installation maps to one of the laws it breaks. Its features, or its problems.
 */
const judgeState = (
	laws: ConstraintLaws,
	lawOf: Readonly<Record<Rule, LawId>>,
	state: State,
	verdict: Verdict
): { readonly problems: ReadonlyArray<string>; readonly reached: ReadonlyArray<DomainFeature> } => {
	const what = Formatter.format(state)
	const negativeCount = Arr.some(state.boxes, (b) => b.slots < 0)
	if (negativeCount || Arr.some(state.slots, (x) => x.at < 0)) {
		const problems = refusedByDomain(what, verdict)
		return {
			problems,
			reached: Arr.isReadonlyArrayNonEmpty(problems)
				? []
				: [negativeCount ? "natural refuses a negative count" : "natural refuses a negative index"]
		}
	}
	const rules = broken(state)
	if (!Arr.isReadonlyArrayNonEmpty(rules)) {
		return verdict.kind === "admitted"
			? {
					problems: [],
					reached: [
						"admitted",
						...(Arr.some(state.boxes, (b) => b.slots === 0)
							? (["admitted beside a box of no slots"] as const)
							: [])
					]
				}
			: { problems: [`${what}: breaks no law, refused with ${shown(verdict)}`], reached: [] }
	}
	if (verdict.kind === "admitted") {
		return { problems: [`${what}: breaks ${Arr.join(rules, ", ")}, but was admitted`], reached: [] }
	}
	const owner = reportedOwnerOf(verdict.fields)
	const constraint = verdict.fields.constraint
	const law =
		owner === undefined || constraint === undefined
			? undefined
			: constraintLaw(laws, owner, constraint)
	const refusing = Arr.filter(rules, (rule) => lawOf[rule] === law)
	if (
		verdict.fields.code !== sqlstates.foreignKeyViolation ||
		!Arr.isReadonlyArrayNonEmpty(refusing)
	) {
		return {
			problems: [
				`${what}: breaks ${Arr.join(rules, ", ")}, expected ${sqlstates.foreignKeyViolation} under one of their constraints, got ${shown(verdict)}`
			],
			reached: []
		}
	}
	const markedUnderEmpty = Arr.some(
		state.slots,
		(x) => x.last && Arr.some(state.boxes, (b) => b.id === x.box && b.slots === 0)
	)
	return {
		problems: [],
		reached: [
			...Arr.map(refusing, (rule) => ruleFeature[rule]),
			...(Arr.contains(refusing, "marked") && markedUnderEmpty
				? (["refused by marked under a box of no slots"] as const)
				: [])
		]
	}
}

/** The problem of a negative natural's verdict: a check violation under a domain, or none. */
const refusedByDomain = (what: string, verdict: Verdict): ReadonlyArray<string> =>
	verdict.kind === "refused" &&
	verdict.fields.code === sqlstates.checkViolation &&
	Option.isSome(verdict.fields.dataType) &&
	verdict.fields.constraint !== undefined
		? []
		: [
				`${what}: expected ${sqlstates.checkViolation} under the natural domain, got ${shown(verdict)}`
			]

/** Installs `sql` on the pinned session in a transaction, runs `body` in it, and rolls back. */
const inInstallation = <A>(
	pinned: PgConnection,
	sql: ReadonlyArray<string>,
	body: Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError> =>
	Effect.ensuring(
		Effect.gen(function* () {
			yield* pinned.query("BEGIN", [])
			for (const statement of sql) {
				yield* pinned.query(statement, [])
			}
			return yield* body
		}),
		Effect.orDie(pinned.query("ROLLBACK", []))
	)

/** The case's real installation of the schema under a fresh schema name of the substrate's. */
const installationOf = Effect.gen(function* () {
	const substrate = yield* Substrate
	const schemaName = yield* substrate.schema({ create: false, label: "naturals" })
	const owned = owning(Slots)
	const real = compileInstallation(owned, {
		...installOptions(owned, substrate.owner.role),
		levels: [identity.schema(parsedSchemaName(schemaName))]
	})
	if (!real.ok) {
		return yield* Effect.die(new Error(`the natural schema did not compile: ${real.error.message}`))
	}
	return real.value
})

layer(Substrate.layer)("natural and pred against PostgreSQL", (it) => {
	it.effect(
		"admit exactly the states their laws admit, as the real installation lowers them",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					return yield* explore(
						{
							oracle: {
								kind: "specification",
								name: "the laws' host meaning over each drawn state (broken), pred(x) x - 1 above zero, and the natural domain refusing a negative value"
							},
							suite: "laws/projections/domains",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<DomainFeature>(situations, { cases: 40, sense: notesOnly }),
							kept: [],
							runs: 40,
							shrink: { kind: "complete" },
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(drawnStates, c) =>
							Effect.scoped(
								Effect.gen(function* () {
									const installation = yield* installationOf
									const pinned = yield* substrate.admin.pin
									const writer = writerOf(installation)
									const problems: Array<string> = []
									yield* inInstallation(
										pinned,
										installationSql(installation, substrate.database),
										Effect.gen(function* () {
											for (const state of drawnStates) {
												const verdict = yield* probe(pinned, writer.state(state))
												const judged = judgeState(
													installation.constraintToLaw,
													writer.laws,
													state,
													verdict
												)
												appendAll(problems, judged.problems)
												c.noteAll(judged.reached)
											}
										})
									)
									assert.deepEqual(problems, [])
								})
							)
					)
				})
			)
	)
})
