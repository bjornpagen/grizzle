import type { Brand, Effect } from "effect"
import type { ApplyOutcome } from "#adapter/public/db.ts"
import type { DbOf } from "#adapter/types/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import type { ReadsOf, WritesOf } from "#compiler/types/changeset/changeset.ts"
import type { ParamsOf } from "#compiler/types/query/query.ts"
import type { Equals, Expect } from "#test/types/changeset/support.ts"
import {
	AutomaticTask,
	Cents as CentsContract,
	Kind,
	ManualTask,
	type Reader as ReaderRole,
	Task,
	TaskNote,
	Work,
	type Writer as WriterRole
} from "#test/types/query/fixtures/work.ts"

/** The names of a program's parameters: never for one that takes none. */
type ParamNamesOf<X> = keyof ParamsOf<X>

/**
 * The ChangeSet facade, built through the public barrels over the worked example's schema:
 * Params, Writes and Reads accumulate through insert, delete, put, read, bind, union and sequence; db.apply accepts
 * only a ChangeSet whose writes lie within its role's write list; read-back names are distinct, a type error
 * otherwise, across unions and strata too. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness
 * requires on the next line; refusals sit inside functions the runtime check never calls, because the fixtures also
 * run and build real ChangeSet values.
 */
type Cents = bigint & Brand.Brand<"Cents">

/**
 * The described arm switch. Its parameters are inferred from their uses, the head-only operator
 * typed by the field it is written into.
 */
export const switchDescribed = ChangeSet.empty(Work)
	.put(
		Task,
		query(Work).rule((r) => {
			const { account } = v(Task)
			return r
				.match(Task, { id: r.param("task", Task.fields.id), account, kind: "Automatic" })
				.find({ id: r.param("task", Task.fields.id), account, kind: r.literal("Manual") })
		})
	)
	.delete(
		AutomaticTask,
		query(Work).rule((r) => {
			const { budget } = v(AutomaticTask)
			return r
				.match(AutomaticTask, { task: r.param("task", AutomaticTask.fields.task), budget })
				.find({ task: r.param("task", AutomaticTask.fields.task), budget })
		})
	)
	.insert(
		ManualTask,
		query(Work).rule((r) =>
			r.match(Task, { id: r.param("task", Task.fields.id), kind: "Automatic" }).find({
				task: r.param("task", ManualTask.fields.task),
				operator: r.param("operator", ManualTask.fields.operator)
			})
		)
	)
	.read("previous", (delta) =>
		query(Work).rule((r) => {
			const { task, budget } = v(delta.removed(AutomaticTask))
			return r.match(delta.removed(AutomaticTask), { task, budget }).find({ task, budget })
		})
	)

export type SwitchParams = Expect<
	Equals<ParamsOf<typeof switchDescribed>, { readonly task: string; readonly operator: string }>
>

export type SwitchWrites = Expect<
	Equals<WritesOf<typeof switchDescribed>, "Task" | "AutomaticTask" | "ManualTask">
>

export type SwitchReads = Expect<
	Equals<
		ReadsOf<typeof switchDescribed>,
		{ readonly previous: ReadonlyArray<{ readonly task: string; readonly budget: Cents }> }
	>
>

/** bind closes every parameter. */
export const switchBound = switchDescribed.bind({
	task: "00000000-0000-4000-8000-000000000001",
	operator: "ann"
})
export type BoundParams = Expect<Equals<ParamNamesOf<typeof switchBound>, never>>
export type BoundKeepsWrites = Expect<
	Equals<WritesOf<typeof switchBound>, WritesOf<typeof switchDescribed>>
>

/** The enumerated switch needs no parameter. */
export const switchEnumerated = ChangeSet.empty(Work)
	.put(Task, [
		{
			id: "00000000-0000-4000-8000-000000000001",
			account: "00000000-0000-4000-8000-000000000002",
			kind: "Manual"
		}
	])
	.delete(AutomaticTask, [
		{ task: "00000000-0000-4000-8000-000000000001", budget: CentsContract(5n) }
	])
	.insert(ManualTask, [{ task: "00000000-0000-4000-8000-000000000001", operator: "ann" }])
export type EnumeratedParams = Expect<Equals<ParamNamesOf<typeof switchEnumerated>, never>>
export type EnumeratedReads = Expect<Equals<keyof ReadsOf<typeof switchEnumerated>, never>>

const notes = ChangeSet.empty(Work)
	.insert(TaskNote, [{ task: "00000000-0000-4000-8000-000000000003", note: "n" }])
	.read("notes", () =>
		query(Work).rule((r) => {
			const { task, note } = v(TaskNote)
			return r.match(TaskNote, { task, note }).find({ task, note })
		})
	)

/** union and sequence accumulate parameters, writes and reads. */
export const unioned = ChangeSet.union(switchDescribed, notes)
export type UnionParams = Expect<Equals<ParamsOf<typeof unioned>, ParamsOf<typeof switchDescribed>>>
export type UnionWrites = Expect<
	Equals<WritesOf<typeof unioned>, "Task" | "AutomaticTask" | "ManualTask" | "TaskNote">
>
export type UnionReads = Expect<Equals<keyof ReadsOf<typeof unioned>, "previous" | "notes">>
export const sequenced = ChangeSet.sequence(
	ChangeSet.sequence(switchEnumerated, notes),
	switchDescribed
)

export type SequenceParams = Expect<
	Equals<ParamsOf<typeof sequenced>, { readonly task: string; readonly operator: string }>
>
export type SequenceReads = Expect<Equals<keyof ReadsOf<typeof sequenced>, "previous" | "notes">>

/** Read-back names are distinct. */
export const duplicateRead = () =>
	notes.read(
		// @ts-expect-error -- TS2345 refusal: read-back names are distinct: this ChangeSet already has a read-back of this name
		"notes",
		() =>
			query(Work).rule((r) => {
				const { id, account, kind } = v(Task)
				return r.match(Task, { id, account, kind }).find({ id, account, kind })
			})
	)

export const duplicateUnion = () =>
	// @ts-expect-error -- TS2345 refusal: read-back names are distinct: the ChangeSets share a read-back name
	ChangeSet.union(notes, notes)

export const duplicateSequence = () =>
	// @ts-expect-error -- TS2345 refusal: read-back names are distinct: the ChangeSets share a read-back name
	ChangeSet.sequence(ChangeSet.sequence(switchEnumerated, notes), notes)

export const distinctNames = notes.read("other", () =>
	query(Work).rule((r) => {
		const { id, account, kind } = v(Task)
		return r.match(Task, { id, account, kind }).find({ id, account, kind })
	})
)
export type DistinctReads = Expect<Equals<keyof ReadsOf<typeof distinctNames>, "notes" | "other">>

/** A ChangeSet writes only the ordinary relations of its schema. */
export const closedMember = () =>
	// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
	ChangeSet.empty(Work).insert(Kind, [{ id: "Automatic" }])

/** The write list: the writer may apply the switch, the reader may not. */
type Writer = DbOf<typeof WriterRole, unknown>
type Reader = DbOf<typeof ReaderRole, unknown>
export const applied = (
	db: Writer
): Effect.Effect<ApplyOutcome<ReadsOf<typeof switchDescribed>>, unknown> =>
	db.apply(switchDescribed, { task: "00000000-0000-4000-8000-000000000001", operator: "ann" })
export const appliedBound = (db: Writer) => db.apply(switchBound, {})
export const outsideScope = (db: Reader) =>
	// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only relations its role's write list names
	db.apply(switchEnumerated, {})

export const missingParams = (db: Writer) =>
	// @ts-expect-error -- TS2345: the switch needs task and operator
	db.apply(switchDescribed, {})
