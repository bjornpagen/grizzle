import type * as Grizzle from "#index.ts"
import {
	type Check,
	check,
	closedId,
	type Counted,
	counted,
	type Fin,
	fin,
	type Mirrors,
	mirrors,
	on,
	relation,
	type Side,
	select,
	uuid
} from "#index.ts"
import {
	Claim,
	type claimsWithinSeats,
	Kind,
	Pool,
	type poolClaims,
	Task
} from "#test/types/api/fixtures/schema.ts"
import type { Equals, Expect } from "#test/types/api/support.ts"

/**
 * Mirrors and count laws: a mirrors statement's sides join position by position, by host type and PostgreSQL type, and
 * a count is a counted family over its owner's drawn count bounded by row checks (fin §6), no capacity statement. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the
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
export const manualKind = mirrors(
	on(
		select(Task, (t) => t.eq(t.kind, "Manual")),
		"id"
	),
	on(TaskKind, "task")
)
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const swapped = mirrors(on(Task, "id", "kind"), on(TaskKind, "kind", "task"))
// @ts-expect-error -- TS2345 refusal: the sides' field types differ
export const arity = mirrors(on(Task, "id", "kind"), on(TaskKind, "task"))
export const badSelection = mirrors(
	on(
		// @ts-expect-error -- TS2345: a selection's predicate compares a closed id with a handle of its roster
		select(Task, (t) => t.eq(t.kind, "Weekly")),
		"id"
	),
	on(TaskKind, "task")
)

/**
 * A count law is a counted family and a row check, each keeping what it names in its type: the family its member side
 * and its owner's slots, the check its name and relation.
 */
export type ClaimsFamily = Expect<
	Equals<
		typeof poolClaims,
		Counted<Side<typeof Claim, readonly ["pool"]>, Fin<typeof Pool, "claims">>
	>
>
export type ClaimsCheck = Expect<
	Equals<typeof claimsWithinSeats, Check<"ClaimsWithinSeats", typeof Pool>>
>
export const atLeastOne = check("AtLeastOneClaim", Pool, (p) => p.claims.ge(1n))
// @ts-expect-error -- TS2345: fin's count is a drawn natural of its owner
export const seatSlots = fin(Pool, "seats")
// @ts-expect-error -- TS2345 refusal: a counted family's side is its owner's key
export const unslotted = counted(on(Claim, "pool"), on(Pool, "id"))
/** capacity, its bound and its weight are no part of the public API. */
// @ts-expect-error -- TS2339: capacity is gone, a counted family and a row check in its place
export type NoCapacity = typeof Grizzle.capacity
// @ts-expect-error -- TS2339: within is gone, a row check on the count in its place
export type NoWithin = typeof Grizzle.within
// @ts-expect-error -- TS2339: weigh is gone, a sum fold in its place
export type NoWeigh = typeof Grizzle.weigh
// @ts-expect-error -- TS2339: ref is gone, a row check reads the field
export type NoRef = typeof Grizzle.ref
