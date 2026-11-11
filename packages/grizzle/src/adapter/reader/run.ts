import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { type InputTooLarge, UnreadableAnswer } from "#adapter/errors/failures.ts"
import {
	type ExecutionInputs,
	encodeForm,
	type HostParams,
	formFor,
	inputCount,
	outputOf,
	partRuns,
	programRecords,
	type ReadChoice,
	type RunStatement,
	readBinding,
	rowsOf,
	runOf,
	runStatement,
	type SentRuns,
	type StatementRecord
} from "#adapter/reader/execution.ts"
import {
	type BatchOutcome,
	type Flight,
	type PreparedStatement,
	sentAnswer
} from "#adapter/wire/batch.ts"
import type { Carrier, Cell, Codebook, Layout, ParamId, Row } from "#compiler/plan/common.ts"
import type {
	CarrierHost,
	CompletedOrder,
	GroupMerge,
	Heading,
	ProgramDelivery,
	RelationInput,
	PartDivision,
	TakeBound
} from "#compiler/plan/read.ts"
import {
	carrierSpecOf,
	columnPosition,
	columnType,
	compareValues,
	defined,
	mergeHeadingGroups,
	rowCell,
	runsLargeForm,
	scalarReader
} from "#compiler/plan/runtime.ts"
import type {
	ServedChoice,
	ServedRiddenSource,
	ServedSource,
	ServedSpine
} from "#compiler/plan/serve.ts"

/**
 * Running one compiled query template and delivering its public result.
 *
 * A template sends one statement in one flight (wire/batch.ts), one round trip, in one transaction and snapshot: its
 * parts are the main rows or the heading groups, and every attachment beside them, each part over its parent's rows,
 * which the statement holds once (lower/shapes OptimizedDelivery rowsPart). The statement is encoded by its slots when
 * the flight is made, and its rows, texts, divide into its parts' runs (execution.ts partRuns) and become Rows when it
 * answers. How the statement binds its parameters and chooses its per-execution form, and how a part delivers its
 * Rows, is execution.ts's, settled once per template and artifact (readProgram), so a read checks nothing its program
 * already settled. The delivered Rows are decoded by the value's decoder, bound to the program's layouts (one per
 * heading group, one for a rows delivery).
 *
 * - Heading groups. A heterogeneous union is one part per heading group, each
 *   delivering its group's full heading, its discriminant included, and each Row states its group. Without a bound the
 *   union is the groups' rows. With a take, each group holds its first k in the take's completed order, and the k-way
 *   merge on that order keeps the first k overall: the first k of the union lie among the first k of each group. An
 *   ordered union then delivers the kept rows in its order. The merge compares Rows, before any is decoded, on the
 *   order's columns converted from each group's texts (GroupOrder: PostgreSQL's B-tree order per column), so only the
 *   kept rows are decoded.
 * - Shared sub-queries. An attachment whose part an earlier attachment of the same parent computes (R25,
 *   lower/shapes/share shareKey) has no part of its own: the runtime hands it the earlier part's rows, which in one
 *   snapshot are the rows it would deliver, and stitches them under its own name.
 *
 * What a read delivers from: its served source (engine served/read.ts ServedSource), the delivery of the artifact that
 * runs, its statement with the spec emitted from it and its forms, each large form with its spec, and its parts in
 * their tree, each with the run of the answer that holds its rows.
 */
/** How a take bound reads its k: a literal, or a declared parameter's admitted input. */
type BoundPlan =
	| { readonly kind: "literal"; readonly k: number }
	| { readonly kind: "param"; readonly param: ParamId }

/** One value of an ordered column, converted from its text: a host value of its carrier. */
type OrderValue = CarrierHost[Carrier]

/** A row's key under an order: the order's columns converted from the row's cells, in the order's key order. */
type OrderKey = ReadonlyArray<OrderValue>

/** How a heading group reads a row's key from its statement's cells. */
type KeyReader = (cells: ReadonlyArray<Cell>) => OrderKey

/**
 * An order over a heterogeneous union's heading groups: each group, in group order, with its reading of a row's key
 * from the group statement's texts; and the comparator of two keys, PostgreSQL's B-tree order per column
 * (values/identity.ts compareValues: numeric and float with NaN last, text in code point order, closed ids in code
 * order, which is their roster's order), reversed for a descending key.
 */
export interface GroupOrder<G> {
	readonly groups: Arr.NonEmptyReadonlyArray<{ readonly group: G; readonly key: KeyReader }>
	readonly compare: (a: OrderKey, b: OrderKey) => number
}

/**
 * One heading group of a read's delivery: its record, and its index among the groups, which its Rows state
 * (core/decoder.ts Row.group).
 */
interface HeadingGroup {
	readonly record: StatementRecord
	readonly group: number
}

/**
 * A heading group with its reading of a row's key under the union's own order, which a take's merge orders by its own.
 */
type Reordered = GroupOrder<HeadingGroup>["groups"][number]

/**
 * How a heterogeneous union's heading groups become its rows: concatenated; merged on the order; or merged on the
 * take's order and cut to its bound, then delivered in that order or sorted into the union's own, which each group of
 * the take's merge reads its key under.
 */
type MergePlan =
	| { readonly kind: "concat" }
	| { readonly kind: "order"; readonly order: GroupOrder<HeadingGroup> }
	| { readonly kind: "take"; readonly take: GroupOrder<HeadingGroup>; readonly bound: BoundPlan }
	| {
			readonly kind: "takeThenOrder"
			readonly take: GroupOrder<Reordered>
			readonly bound: BoundPlan
			readonly order: GroupOrder<HeadingGroup>["compare"]
	  }

/**
 * What a read delivers: the Rows of its delivered statements, each a heading group, merged; a rows delivery's one
 * statement is the one group, concatenated.
 */
interface DeliveryPlan {
	readonly groups: Arr.NonEmptyReadonlyArray<HeadingGroup>
	readonly merge: MergePlan
}

/**
 * A read's program: its statement as it runs, its parts' records in flight order, what the read delivers, and the
 * layouts of its delivered Rows, one per heading group, in group order (one for a rows delivery), which a decoder
 * binds to.
 */
export interface ReadProgram {
	readonly run: RunStatement
	readonly records: ReadonlyArray<StatementRecord>
	readonly delivery: DeliveryPlan
	readonly layouts: Arr.NonEmptyReadonlyArray<Layout>
}

/** A per-execution choice of a read: by a relation parameter's count. */
const readChoice = (choice: ServedChoice<RelationInput>): ReadChoice => ({
	source: choice.source.param,
	threshold: choice.threshold
})

/**
 * The order `order` over heading groups `groups`, in group order, of headings `headingOf`, under the union's heading
 * `heading` and the installation's codes `codes`. Each ordered column has the union's type, the one type every group
 * delivers it as, so every group's texts convert alike and the comparator reads one carrier per column; each group
 * reads the column at its own position.
 */
export const groupOrder = <G>(
	order: CompletedOrder,
	heading: Heading,
	groups: Arr.NonEmptyReadonlyArray<G>,
	headingOf: (group: G) => Heading,
	codes: Codebook
): GroupOrder<G> => {
	const keys = Arr.map(order.keys, (k) => {
		const type = columnType(heading, k.column)
		return {
			column: k.column,
			spec: carrierSpecOf(type, codes),
			convert: scalarReader(type, codes).convert,
			sign: k.dir === "desc" ? -1 : 1
		}
	})
	return {
		groups: Arr.map(groups, (group) => {
			const own = headingOf(group)
			const cells = Arr.map(keys, (k) => ({
				at: columnPosition(own, k.column),
				convert: k.convert
			}))
			return {
				group,
				key: (row): OrderKey => {
					const key: Array<OrderValue> = []
					for (const cell of cells) {
						key.push(cell.convert(rowCell(row, cell.at)))
					}
					return key
				}
			}
		}),
		/** Every key holds one value per ordered column, in the order's column order, as `keys` does. */
		compare: (a, b) => {
			for (const [k, [x, y]] of Arr.zip(keys, Arr.zip(a, b))) {
				const c = compareValues(k.spec, x, y)
				if (c !== 0) {
					return c * k.sign
				}
			}
			return 0
		}
	}
}

/** How a take bound reads its k: a literal, or its declared parameter's admitted input. */
const boundPlan = (bound: TakeBound): BoundPlan =>
	bound.kind === "literal"
		? { kind: "literal", k: Number(bound.k) }
		: { kind: "param", param: bound.param }

/** A heading group's heading: its statement's spec's. */
const headingOf = (group: HeadingGroup): Heading => outputOf(group.record.part).heading

/** How a heterogeneous union of the union heading `heading` merges its heading groups, under the codes `codes`. */
const mergePlan = (
	merge: GroupMerge,
	heading: Heading,
	groups: Arr.NonEmptyReadonlyArray<HeadingGroup>,
	codes: Codebook
): MergePlan => {
	switch (merge.kind) {
		case "concat":
			return { kind: "concat" }
		case "order":
			return { kind: "order", order: groupOrder(merge.order, heading, groups, headingOf, codes) }
		case "take":
			return {
				kind: "take",
				take: groupOrder(merge.take, heading, groups, headingOf, codes),
				bound: boundPlan(merge.bound)
			}
		case "takeThenOrder": {
			const order = groupOrder(merge.order, heading, groups, headingOf, codes)
			return {
				kind: "takeThenOrder",
				take: groupOrder(merge.take, heading, order.groups, (r) => headingOf(r.group), codes),
				bound: boundPlan(merge.bound),
				order: order.compare
			}
		}
	}
}

/**
 * What a read delivers, from its program's delivery and its delivered records, in flight order: each a heading group,
 * merged as the delivery says, a rows delivery's concatenated.
 */
const deliveryPlan = (
	delivery: ProgramDelivery,
	delivered: Arr.NonEmptyReadonlyArray<StatementRecord>,
	codes: Codebook
): DeliveryPlan => {
	const groups = Arr.map(delivered, (record, group): HeadingGroup => ({ record, group }))
	return {
		groups,
		merge:
			delivery.kind === "rows"
				? { kind: "concat" }
				: mergePlan(delivery.merge, delivery.heading, groups, codes)
	}
}

/** The layouts of the Rows a delivery delivers: each heading group's, in group order. */
const deliveredLayouts = (delivery: DeliveryPlan): Arr.NonEmptyReadonlyArray<Layout> =>
	Arr.map(delivery.groups, (g) => g.record.layout)

/**
 * The program of a read source on its delivered spine `spine` (engine served/read.ts servedSpine), under the
 * installation's codes `codes`: built once by the compiled read that holds it (reader.ts), from the source a served file
 * carries or the compile serves alike.
 */
export const readProgram = (
	source: ServedSource,
	spine: ServedSpine,
	codes: Codebook
): ReadProgram => {
	const { records, delivered } = programRecords(source.roots, spine, codes)
	const delivery = deliveryPlan(source.delivery, delivered, codes)
	return {
		run: runStatement(source.statement, source.parts, readChoice),
		records,
		delivery,
		layouts: deliveredLayouts(delivery)
	}
}

/**
 * A riding read-back's program, which reads its statement's rows from the write statement it rides and sends nothing:
 * how its statement's rows divide into its parts, what it delivers, and the layouts of its delivered Rows
 * (ReadProgram).
 */
export interface RiddenProgram extends Pick<ReadProgram, "delivery" | "layouts"> {
	readonly parts: PartDivision
}

/**
 * The program of a riding read-back's source on its delivered spine `spine`, under the installation's codes `codes`:
 * its parts' records read as a read's are (programRecords), with no form to send.
 */
export const riddenProgram = (
	source: ServedRiddenSource,
	spine: ServedSpine,
	codes: Codebook
): RiddenProgram => {
	const { delivered } = programRecords(source.roots, spine, codes)
	const delivery = deliveryPlan(source.delivery, delivered, codes)
	return { parts: source.parts, delivery, layouts: deliveredLayouts(delivery) }
}

/** A read statement's choice: a relation parameter's distinct fact count above its threshold. */
export const readExceeds =
	(inputs: ExecutionInputs) =>
	(choice: ReadChoice): boolean =>
		runsLargeForm(choice, inputCount(inputs, choice.source))

/**
 * A take bound's k: its literal, or its declared parameter's host value, a bigint or a number the parameter's integer
 * codec admitted before any statement was sent.
 */
const boundOf = (bound: BoundPlan, params: HostParams): number =>
	bound.kind === "literal" ? bound.k : Number(params[bound.param])

/** What a delivered Row is emitted as, with the heading group whose statement delivered it. */
type Emit<T> = (row: Row, group: HeadingGroup) => T

/** A Row, the group it belongs to, and its key under an order. */
interface Keyed<G> {
	readonly row: Row
	readonly group: G
	readonly key: OrderKey
}

/** The Rows of a heading group in a flight whose sent statements answered `sent`, or the repeat that refuses them. */
const groupRows = (
	group: HeadingGroup,
	sent: SentRuns
): Result.Result<ReadonlyArray<Row>, UnreadableAnswer> =>
	rowsOf(group.record, sent, runOf(group.record, sent), group.group)

/**
 * The Rows of the heading groups of `order` merged on it, each with its group, the first `limit` of them when it is a
 * number.
 */
const mergedOn = <G>(
	order: GroupOrder<G>,
	rowsOfGroup: (group: G) => ReadonlyArray<Row>,
	limit: number | undefined
): ReadonlyArray<Keyed<G>> => {
	const compare = (a: Keyed<G>, b: Keyed<G>) => order.compare(a.key, b.key)
	const sorted = order.groups.map(({ group, key }) =>
		rowsOfGroup(group)
			.map((row): Keyed<G> => ({ row, group, key: key(row.cells) }))
			.toSorted(compare)
	)
	return mergeHeadingGroups(sorted, compare, limit).map((one) => one.row)
}

/** Each kept Row emitted with its group, `emit` reading the HeadingGroup off a take's reordered group. */
const emitKeyed = <T>(keyed: ReadonlyArray<Keyed<HeadingGroup>>, emit: Emit<T>): ReadonlyArray<T> =>
	keyed.map((one) => emit(one.row, one.group))

/**
 * Each kept Row is keyed by its own group's reading of the union's order, and emitted with its group. Every group's
 * Rows are read first, so a group whose answer repeats a row refuses the whole delivery (execution.ts rowsOf).
 */
const merged = <T>(
	merge: MergePlan,
	groups: Arr.NonEmptyReadonlyArray<HeadingGroup>,
	sent: SentRuns,
	params: HostParams,
	emit: Emit<T>
): Result.Result<ReadonlyArray<T>, UnreadableAnswer> => {
	const read: Array<ReadonlyArray<Row>> = []
	for (const group of groups) {
		const rows = groupRows(group, sent)
		if (Result.isFailure(rows)) {
			return Result.fail(rows.failure)
		}
		read.push(rows.success)
	}
	return Result.succeed(
		mergedRows(
			merge,
			(group) => defined(read[group.group], `the Rows of heading group ${group.group}`),
			groups,
			params,
			emit
		)
	)
}

/** The merge of the groups' Rows, each group's read by `rowsOfGroup`. */
const mergedRows = <T>(
	merge: MergePlan,
	rowsOfGroup: (group: HeadingGroup) => ReadonlyArray<Row>,
	groups: Arr.NonEmptyReadonlyArray<HeadingGroup>,
	params: HostParams,
	emit: Emit<T>
): ReadonlyArray<T> => {
	switch (merge.kind) {
		case "concat": {
			const out: Array<T> = []
			for (const group of groups) {
				for (const row of rowsOfGroup(group)) {
					out.push(emit(row, group))
				}
			}
			return out
		}
		case "order":
			return emitKeyed(mergedOn(merge.order, rowsOfGroup, undefined), emit)
		case "take":
			return emitKeyed(mergedOn(merge.take, rowsOfGroup, boundOf(merge.bound, params)), emit)
		case "takeThenOrder": {
			const taken = mergedOn(merge.take, (r) => rowsOfGroup(r.group), boundOf(merge.bound, params))
			const rekeyed = taken.map((one): Keyed<Reordered> => ({
				row: one.row,
				group: one.group,
				key: one.group.key(one.row.cells)
			}))
			return rekeyed
				.toSorted((a, b) => merge.order(a.key, b.key))
				.map((one) => emit(one.row, one.group.group))
		}
	}
}

const asRow: Emit<Row> = (row) => row

/**
 * The delivered Rows of a program in a flight whose sent statements answered `sent`: its heading groups', merged; or
 * UnreadableAnswer at a statement whose answer repeats a row.
 */
export const deliveredRows = (
	program: Pick<ReadProgram, "delivery">,
	sent: SentRuns,
	params: HostParams
): Result.Result<ReadonlyArray<Row>, UnreadableAnswer> =>
	merged(program.delivery.merge, program.delivery.groups, sent, params, asRow)

/** A delivered Row with the heading group whose statement delivered it. */
interface Delivered {
	readonly row: Row
	readonly group: HeadingGroup
}

const withGroup: Emit<Delivered> = (row, group) => ({ row, group })

/** The statement of one execution of a read program (see the header), in its form for `inputs`. */
export const programStatement = (
	program: ReadProgram,
	inputs: ExecutionInputs
): Effect.Effect<PreparedStatement, InputTooLarge> =>
	encodeForm(formFor(program.run, readExceeds(inputs)), (slot) => readBinding(slot, inputs))

/** The runs of a read program's answer `outcomes`, its one statement's: its parts' rows (execution.ts partRuns). */
const answerRuns = (program: ReadProgram, outcomes: ReadonlyArray<BatchOutcome>): SentRuns =>
	partRuns(program.run.parts, sentAnswer(outcomes, 0).rows)

/**
 * The one flight of a read program (see the header), reading its delivered Rows through `read`, the value's decoder
 * bound to the program's layouts. A statement whose answer repeats a row is UnreadableAnswer (deliveredRows).
 */
export const programFlight = <A>(
	program: ReadProgram,
	inputs: ExecutionInputs,
	read: (row: Row) => A
): Effect.Effect<Flight<ReadonlyArray<A>, UnreadableAnswer>, InputTooLarge> =>
	Effect.map(programStatement(program, inputs), (statement) => ({
		statements: [statement],
		read: (outcomes) =>
			Effect.suspend(() =>
				Effect.fromResult(
					Result.map(deliveredRows(program, answerRuns(program, outcomes), inputs.params), (rows) =>
						rows.map((row) => read(row))
					)
				)
			)
	}))

/**
 * The one delivered Row of a program proved at most one row per parameter binding, read through `read`, or none. The
 * rows are the server's answer, so a second one contradicts the proof: UnreadableAnswer at the statement that delivered
 * it, after the read's transaction committed.
 */
const atMostOne = <A>(
	delivered: ReadonlyArray<Delivered>,
	read: (row: Row) => A
): Result.Result<Option.Option<A>, UnreadableAnswer> => {
	const [first, second] = delivered
	if (second !== undefined) {
		return Result.fail(new UnreadableAnswer({ index: 0, fate: "committed" }))
	}
	return Result.succeed(first === undefined ? Option.none() : Option.some(read(first.row)))
}

/** The one flight of a get: a read program proved at most one row per parameter binding, its row read by `read`. */
export const programGetFlight = <A>(
	program: ReadProgram,
	inputs: ExecutionInputs,
	read: (row: Row) => A
): Effect.Effect<Flight<Option.Option<A>, UnreadableAnswer>, InputTooLarge> =>
	Effect.map(programStatement(program, inputs), (statement) => ({
		statements: [statement],
		read: (outcomes) =>
			Effect.suspend(() => {
				const { merge, groups } = program.delivery
				return Effect.fromResult(
					Result.flatMap(
						merged(merge, groups, answerRuns(program, outcomes), inputs.params, withGroup),
						(delivered) => atMostOne(delivered, read)
					)
				)
			})
	}))
