import {
	type Capacity,
	capacity,
	closedId,
	type Mirrors,
	mirrors,
	on,
	ref,
	relation,
	type Side,
	select,
	uuid,
	weigh,
	within
} from "#index.ts"
import { Claim, Kind, Pool, Task } from "#test/types/api/fixtures/schema.ts"
import type { Equals, Expect } from "#test/types/api/support.ts"

/**
 * Capacity and mirrors laws: a mirrors statement's sides join position by position, by
 * host type and PostgreSQL type, and a capacity's rule takes a source side, an optional weight and a bound of bigint
 * literals or field references. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the
 * next line.
 *
 * A mirrors statement keeps both sides' sources and fields in its type.
 */
export const TaskKind = relation("TaskKind", { task: uuid, kind: closedId(Kind) }, ["task"])
export const taskKind = mirrors(on(Task, "id", "kind"), on(TaskKind, "task", "kind"))
export type TaskKindMirrors = Expect<
	Equals<
		typeof taskKind,
		Mirrors<
			Side<typeof Task, readonly ["id", "kind"]>,
			Side<typeof TaskKind, readonly ["task", "kind"]>
		>
	>
>
/** A selected side: the manual tasks mirror their TaskKind rows. */
export const manualKind = mirrors(on(select(Task, { kind: "Manual" }), "id"), on(TaskKind, "task"))
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const swapped = mirrors(on(Task, "id", "kind"), on(TaskKind, "kind", "task"))
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const arity = mirrors(on(Task, "id", "kind"), on(TaskKind, "task"))
export const badSelection = mirrors(
	// @ts-expect-error -- TS2322: a selection binds a handle of the field's roster
	on(select(Task, { kind: "Weekly" }), "id"),
	on(TaskKind, "task")
)

/** A capacity keeps its target and source sides; the bound is bigint literals or references, and the weight a field. */
export const seats = capacity(on(Pool, "id"), {
	from: on(Claim, "pool"),
	within: within(0n, ref("seats"))
})

export type SeatsCapacity = Expect<
	Equals<
		typeof seats,
		Capacity<Side<typeof Pool, readonly ["id"]>, Side<typeof Claim, readonly ["pool"]>>
	>
>

export const atLeastOne = capacity(on(Pool, "id"), {
	from: on(Claim, "pool"),
	within: within(1n, "*")
})

export const weighed = capacity(on(Pool, "id"), {
	from: on(Claim, "pool"),
	weight: weigh("seats"),
	within: within(2n)
})
// @ts-expect-error -- TS2345: a bound is a bigint, never a JavaScript number
export const numberBound = within(1)
// @ts-expect-error -- TS2345: an upper bound is a bigint, a reference, or "*"
export const openBound = within(0n, "inf")
// @ts-expect-error -- TS2741: a capacity's rule states its bound
export const unbounded = capacity(on(Pool, "id"), { from: on(Claim, "pool") })
export const perWindow = capacity(on(Pool, "id"), {
	from: on(Claim, "pool"),
	within: within(1n),
	// @ts-expect-error -- TS2353: a capacity has no option beyond its source, weight and bound
	per: "day"
})
// @ts-expect-error -- TS2345: a weight names a field or a span duration
export const numericWeight = weigh(2)
