import type { Brand, Stream } from "effect"
import type { Phantom } from "#compiler/core/phantom.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { ReadsOf, WritesOf } from "#compiler/types/changeset/changeset.ts"
import type { Invariant } from "#compiler/types/core/phantom.ts"
import type { ParamsOf } from "#compiler/types/query/query.ts"
import type { Fact } from "#compiler/types/schema/relation.ts"
import { query, v } from "#index.ts"
import {
	Cents,
	Clock,
	Edu,
	Instant,
	Reports,
	Task,
	Ticket,
	Work
} from "#test/types/skeleton/fixtures/work.ts"
import type { Equals, Expect } from "#test/types/skeleton/support.ts"

/** The names of a program's parameters: never for one that takes none. */
type ParamNamesOf<X> = keyof ParamsOf<X>

/**
 * ChangeSet members given as queries over declare-only values.
 * Query is invariant in its head, so a member's head is checked by assignability against the relation's facts: a head
 * literal is a value of its field, an insert's head supplies every serial field or none, and a parameter the head
 * alone uses is typed by the field it is written to. Every `@ts-expect-error -- TSnnnn` names the diagnostic the
 * harness requires on the next line.
 *
 * Task with its automatic and manual arms.
 */
export const Mode = closed("Kind", ["Automatic", "Manual"])
export const ModalTask = relation("Task", { id: uuid, account: uuid, kind: closedId(Mode) }, ["id"])
export const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: Cents }, ["task"])
export const ManualTask = relation(
	"ManualTask",
	{ task: uuid, operator: str.regex("^.*$", "su") },
	["task"]
)
export const Switch = schema("Work", { Mode, ModalTask, AutomaticTask, ManualTask }, [])

/**
 * The worked example's described arm switch, verbatim but for the relation names: the put's head writes the literal "Manual" into the kind
 * field, and the insert's head writes the head-only parameter operator into ManualTask.operator.
 */
export const switchToManualDescribed = ChangeSet.empty(Switch)
	.put(
		ModalTask,
		query(Switch).rule((r) => {
			const { account } = v(ModalTask)
			return r
				.match(ModalTask, { id: r.param("task", ModalTask.fields.id), account, kind: "Automatic" })
				.find({ id: r.param("task", ModalTask.fields.id), account, kind: r.literal("Manual") })
		})
	)
	.delete(
		AutomaticTask,
		query(Switch).rule((r) => {
			const { budget } = v(AutomaticTask)
			return r
				.match(AutomaticTask, { task: r.param("task", AutomaticTask.fields.task), budget })
				.find({ task: r.param("task", AutomaticTask.fields.task), budget })
		})
	)
	.insert(
		ManualTask,
		query(Switch).rule((r) =>
			r.match(ModalTask, { id: r.param("task", ModalTask.fields.id), kind: "Automatic" }).find({
				task: r.param("task", ManualTask.fields.task),
				operator: r.param("operator", ManualTask.fields.operator)
			})
		)
	)
	.read("previous", (delta) =>
		query(Switch).rule((r) => {
			const { task, budget } = v(delta.removed(AutomaticTask))
			return r.match(delta.removed(AutomaticTask), { task, budget }).find({ task, budget })
		})
	)

export type SwitchParams = Expect<
	Equals<
		ParamsOf<typeof switchToManualDescribed>,
		{ readonly task: string; readonly operator: string }
	>
>

export type SwitchReads = Expect<
	Equals<
		ReadsOf<typeof switchToManualDescribed>,
		{
			readonly previous: ReadonlyArray<{
				readonly task: string
				readonly budget: bigint & Brand.Brand<"Cents">
			}>
		}
	>
>

/** A query member may supply its serial values, or omit them all. */
export const explicitSerial = ChangeSet.empty(Work).insert(
	Ticket,
	query(Work).rule((r) => {
		const { id, account } = v(Task)
		return r.match(Task, { id, account }).find({
			id: Compute.literal(pg.bigint, 1n),
			account,
			amount: Compute.literal(Cents, Cents(5n))
		})
	})
)

export const generatedSerial = ChangeSet.empty(Work).insert(
	Ticket,
	query(Work).rule((r) => {
		const { id, account } = v(Task)
		return r
			.match(Task, { id, account })
			.find({ account, amount: Compute.literal(Cents, Cents(5n)) })
	})
)

export type SerialWrites = Expect<
	Equals<[WritesOf<typeof explicitSerial>, WritesOf<typeof generatedSerial>], ["Ticket", "Ticket"]>
>

/**
 * A head with a field the relation lacks, or without a field other than the serials, is no addition; a deletion
 * names complete facts; an addition omits all of its serial fields or none.
 */
export const extraField = ChangeSet.empty(Work).insert(
	Ticket,
	// @ts-expect-error -- TS2345 refusal: the query's head is not a fact of the relation
	query(Work).rule((r) => {
		const { id, account } = v(Task)
		return r
			.match(Task, { id, account })
			.find({ account, amount: Compute.literal(Cents, Cents(5n)), extra: id })
	})
)

export const missingField = ChangeSet.empty(Work).insert(
	Ticket,
	// @ts-expect-error -- TS2345 refusal: the query's head is not a fact of the relation
	query(Work).rule((r) => {
		const { id, account } = v(Task)
		return r.match(Task, { id, account }).find({ id: Compute.literal(pg.bigint, 1n), account })
	})
)

export const generatedDelete = ChangeSet.empty(Work).delete(
	Ticket,
	// @ts-expect-error -- TS2345 refusal: the query's head is not a fact of the relation
	query(Work).rule((r) => {
		const { id, account } = v(Task)
		return r
			.match(Task, { id, account })
			.find({ account, amount: Compute.literal(Cents, Cents(5n)) })
	})
)
export const Pair = relation("Pair", { a: pg.bigserial, b: pg.serial, note: uuid }, ["a"])
export const Pairs = schema("Pairs", { Pair, Task }, [])
export const bothSerials = ChangeSet.empty(Pairs).insert(
	Pair,
	query(Pairs).rule((r) => {
		const { id } = v(Task)
		return r
			.match(Task, { id })
			.find({ a: Compute.literal(pg.bigint, 1n), b: Compute.literal(pg.integer, 1), note: id })
	})
)

export const oneSerial = ChangeSet.empty(Pairs).insert(
	Pair,
	// @ts-expect-error -- TS2345 refusal: the query's head is not a fact of the relation
	query(Pairs).rule((r) => {
		const { id } = v(Task)
		return r.match(Task, { id }).find({ a: Compute.literal(pg.bigint, 1n), note: id })
	})
)

/** A head literal outside the field's roster is no fact. */
export const badLiteral = ChangeSet.empty(Switch).put(
	ModalTask,
	// @ts-expect-error -- TS2345 refusal: the query's head is not a fact of the relation
	query(Switch).rule((r) => {
		const { id, account } = v(ModalTask)
		return r.match(ModalTask, { id, account }).find({ id, account, kind: r.literal("Paused") })
	})
)

/**
 * An array or Stream member is checked like a query member's head: TypeScript runs no excess-property check on an
 * inferred member, so the member check enforces that an addition omits all of its serial fields or none and that no
 * fact carries a field its relation lacks.
 */
export const arrayBothSerials = ChangeSet.empty(Pairs).insert(Pair, [{ a: 1n, b: 1, note: "x" }])
export const arrayNoSerials = ChangeSet.empty(Pairs).insert(Pair, [{ note: "x" }])
/** Each fact is an addition on its own, so one array may mix complete facts with generated additions. */
export const arrayMixed = ChangeSet.empty(Pairs).insert(Pair, [
	{ a: 1n, b: 1, note: "x" },
	{ note: "y" }
])

export const arrayMixedReversed = ChangeSet.empty(Pairs).insert(Pair, [
	{ note: "y" },
	{ a: 1n, b: 1, note: "x" }
])

export type ArrayWrites = Expect<
	Equals<[WritesOf<typeof arrayMixed>, WritesOf<typeof arrayNoSerials>], ["Pair", "Pair"]>
>

export const arrayOneSerial = ChangeSet.empty(Pairs).insert(
	Pair,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ a: 1n, note: "x" }]
)

export const arrayMixedOneSerial = ChangeSet.empty(Pairs).insert(
	Pair,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ note: "y" }, { a: 1n, note: "x" }]
)

export const arrayExtraField = ChangeSet.empty(Pairs).insert(
	Pair,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ note: "x", bogus: 1 }]
)

export const arrayDeleteExtra = ChangeSet.empty(Pairs).delete(
	Pair,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ a: 1n, b: 1, note: "x", bogus: 1 }]
)

export const arrayPutExtra = ChangeSet.empty(Work).put(
	Task,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ id: "t", account: "a", kind: "Manual", extra: true }]
)
/**
 * A fact with a literal-typed field (a closed relation's handle) still infers the member itself, not its constraint:
 * the member check sees the facts, and an array member adds no parameter.
 */
export const Lane = closed("Lane", ["Left", "Right"])
export const Slot = relation("Slot", { a: pg.bigserial, b: pg.serial, lane: closedId(Lane) }, ["a"])
export const Slots = schema("Slots", { Lane, Slot }, [])
export const slotsMixed = ChangeSet.empty(Slots).insert(Slot, [
	{ lane: "Left" },
	{ a: 1n, b: 2, lane: "Right" }
])
export type SlotsParams = Expect<Equals<ParamNamesOf<typeof slotsMixed>, never>>
export const slotsOneSerial = ChangeSet.empty(Slots).insert(
	Slot,
	// @ts-expect-error -- TS2345 refusal: a member fact is not a fact of the relation
	[{ a: 1n, lane: "Left" }]
)
declare const generatedPairs: Stream.Stream<{ readonly note: string }>
declare const partialPairs: Stream.Stream<{ readonly a: bigint; readonly note: string }>
declare const widePairs: Stream.Stream<Fact<typeof Pair> & { readonly bogus: number }>
export const streamGenerated = ChangeSet.empty(Pairs).insert(Pair, generatedPairs)
// @ts-expect-error -- TS2379 refusal: a member fact is not a fact of the relation
export const streamOneSerial = ChangeSet.empty(Pairs).insert(Pair, partialPairs)
// @ts-expect-error -- TS2379 refusal: a member fact is not a fact of the relation
export const streamExtraField = ChangeSet.empty(Pairs).put(Pair, widePairs)

/**
 * ChangeSets over two levels of one chain combine, as db.apply accepts either: the result is over the
 * higher level, in either argument order. Schemas of which neither is a level of the other do not combine.
 */
const at = Instant(0n)
type SchemaOf<C> = C extends Phantom<{ readonly schema: Invariant<infer S> }> ? S : never
export const baseTick = ChangeSet.empty(Edu).put(Clock, [{ id: "current", at }])
export const extensionTick = ChangeSet.empty(Reports).put(Clock, [{ id: "current", at }])
export const unionUp = ChangeSet.union(baseTick, extensionTick)
export const unionDown = ChangeSet.union(extensionTick, baseTick)
export type UnionUp = Expect<
	Equals<[SchemaOf<typeof unionUp>, WritesOf<typeof unionUp>], [typeof Reports, "Clock"]>
>

export type UnionDown = Expect<
	Equals<[SchemaOf<typeof unionDown>, WritesOf<typeof unionDown>], [typeof Reports, "Clock"]>
>
export const unionSame = ChangeSet.union(baseTick, baseTick)
export type UnionSame = Expect<
	Equals<[SchemaOf<typeof unionSame>, WritesOf<typeof unionSame>], [typeof Edu, "Clock"]>
>
export const sequenceUp = ChangeSet.sequence(ChangeSet.sequence(baseTick, extensionTick), baseTick)
export const sequenceDown = ChangeSet.sequence(extensionTick, baseTick)
export type SequenceUp = Expect<
	Equals<[SchemaOf<typeof sequenceUp>, WritesOf<typeof sequenceUp>], [typeof Reports, "Clock"]>
>

export type SequenceDown = Expect<
	Equals<[SchemaOf<typeof sequenceDown>, WritesOf<typeof sequenceDown>], [typeof Reports, "Clock"]>
>
/** The higher level's ChangeSet takes members over either level, and keeps the empty parameter map. */
export const unionThenPut = unionUp.put(Clock, [{ id: "current", at }])
export type UnionParams = Expect<
	Equals<
		[
			ParamNamesOf<typeof baseTick>,
			ParamNamesOf<typeof unionThenPut>,
			ParamNamesOf<typeof sequenceUp>
		],
		[never, never, never]
	>
>
// @ts-expect-error -- TS2345 refusal: the ChangeSets' schemas are not levels of one another
export const unionUnrelated = ChangeSet.union(baseTick, ChangeSet.empty(Pairs))
export const sequenceUnrelated = ChangeSet.sequence(
	ChangeSet.sequence(baseTick, extensionTick),
	// @ts-expect-error -- TS2345 refusal: the ChangeSets' schemas are not levels of one another
	ChangeSet.empty(Work)
)
// @ts-expect-error -- TS2345 refusal: the ChangeSets' schemas are not levels of one another
export const sequenceSameName = ChangeSet.sequence(ChangeSet.empty(Switch), ChangeSet.empty(Work))
