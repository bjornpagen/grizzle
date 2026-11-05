import type { Effect } from "effect"
import {
	type Db,
	type Evidence,
	type EvidenceOfQuery,
	type HeadOf,
	type Origin,
	type ParamsOf,
	type ParamType,
	query,
	type ReadError,
	type SelfSource,
	type Term,
	type Uuid,
	uuid,
	v
} from "#index.ts"
import { Edge, Task, Work, type WorkReader } from "#test/types/api/fixtures/schema.ts"
import type { Equals, Expect } from "#test/types/api/support.ts"

/**
 * Recursive queries and the variables their arms mint: the row signature types self and every arm's head, the
 * parameters of every arm join the query's, a recursive query proves no cardinality, and a variable keeps its
 * relation's origin and type. Every
 * `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 */
declare const reader: Db<typeof WorkReader, unknown>

/** A variable minted in a rule callback: its term carries the relation's origin and the field's host type. */
const edgeVars = () => v(Edge, "edge")
export type MintedVariable = Expect<
	Equals<
		ReturnType<typeof edgeVars>["to"],
		Term<Uuid, unknown, Origin<"Edge", "to", "edge">, "uuid">
	>
>

export const reach = query(Work).recursive("Reach", {
	row: { from: uuid, to: uuid },
	base: [
		(r) => {
			const step = edgeVars()
			return r
				.match(Edge, { from: r.param("start", Edge.fields.from), to: step.to })
				.find({ from: step.from, to: step.to })
		}
	],
	rec: [
		(r, self) => {
			const prior = v(self, "self")
			const step = edgeVars()
			return r
				.match(self, { from: prior.from, to: prior.to })
				.match(Edge, { from: prior.to, to: step.to })
				.where(r.ne(step.to, r.param("avoid", uuid)))
				.find({ from: prior.from, to: step.to })
		}
	]
})

export type ReachHead = Expect<
	Equals<HeadOf<typeof reach>, { readonly from: Uuid; readonly to: Uuid }>
>

/** The parameters of the base and recursive arms join. */
export type ReachParams = Expect<
	Equals<
		ParamsOf<typeof reach>,
		{ readonly start: ParamType<Uuid, "uuid">; readonly avoid: ParamType<Uuid, "uuid"> }
	>
>
/** A fixpoint proves no key or cardinality, so it is read as rows, never by get. */
export type ReachEvidence = Expect<Equals<EvidenceOfQuery<typeof reach>, Evidence.Unknown>>
const start = "0193d8f2-7c1e-7000-8000-0000000000e1"
const avoid = "0193d8f2-7c1e-7000-8000-0000000000e2"
export const reached = reader.execute(reach, { start, avoid })
// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
export const reachOne = reader.get(reach, { start, avoid })
export type Reached = Expect<
	Equals<
		Effect.Success<typeof reached>["collect"],
		Effect.Effect<ReadonlyArray<HeadOf<typeof reach>>, ReadError>
	>
>

/** self is a source of the row signature, its variables typed by the row's descriptors. */
export const selfSource = (
	self: SelfSource<{ readonly from: typeof uuid; readonly to: typeof uuid }>
) => v(self, "self")
export type SelfVars = Expect<Equals<keyof ReturnType<typeof selfSource>, "from" | "to">>

/** Every arm's head is the row signature: no field missing, none added, none of another type. */
export const missingField = query(Work).recursive("Short", {
	row: { from: uuid, to: uuid },
	base: [
		// @ts-expect-error -- TS2322 refusal: an arm's head delivers the row: each of its fields, at a type that meets the field's
		(r) => {
			const { from, to } = v(Edge, "edge")
			return r.match(Edge, { from, to }).find({ from })
		}
	],
	rec: []
})

export const wrongType = query(Work).recursive("Kinds", {
	row: { from: uuid, to: uuid },
	base: [],
	rec: [
		// @ts-expect-error -- TS2322 refusal: an arm's head delivers the row: each of its fields, at a type that meets the field's
		(r, self) => {
			const prior = v(self, "self")
			const { kind } = v(Task, "task")
			return r
				.match(self, { from: prior.from, to: prior.to })
				.match(Task, { id: prior.to, kind })
				.find({ from: prior.from, to: kind })
		}
	]
})

export const selfBinding = query(Work).recursive("Bound", {
	row: { from: uuid, to: uuid },
	base: [],
	rec: [
		(r, self) => {
			const prior = v(self, "self")
			return (
				r
					// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
					.match(self, { from: prior.from, via: prior.to })
					.find({ from: prior.from, to: prior.to })
			)
		}
	]
})
/** The row signature is a record of descriptors, never host values. */
// @ts-expect-error -- TS2322: a row field is a descriptor
export const hostRow = query(Work).recursive("Host", { row: { from: "uuid" }, base: [], rec: [] })
