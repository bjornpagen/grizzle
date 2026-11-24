/** What the properties of readback-placement.test.ts read: its spaces, models and helpers. */

import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Equivalence, Option, Order, Record as Rec } from "effect"
import type { NamedSide } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { mutable, relation, schema, unit } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { removedTag, type WriteStepResult } from "#compiler/runtime/write/steps.ts"
import { carrierScope } from "#compiler/sql/naming.ts"
import {
	changeSetDesc,
	changeSetOver,
	type ChangeSetValue
} from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import type { WriteArtifact } from "#compiler/write/program/artifact.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import { type FixtureSchema, testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { checking, owning } from "#test/support/policy.ts"

const M = relation("M", { id: pg.integer, v: pg.integer }, ["id"])

const A = relation("A", { id: pg.integer, v: pg.integer }, ["id"])

const Z = relation("Z", { id: pg.integer, v: pg.integer }, ["id"])

const schemaName = "readback_placement"

/** M mutable inside the unit of its id, since the cases put and delete it. */
const S = schema(schemaName, [M, A, Z], [unit("Row", { id: pg.integer }), mutable(M)])

type Op = "insert" | "delete" | "put"

type Side = NamedSide["side"]

/** A case: M's first-stratum action, the opposite action beside it, a second stratum's insert of M; W, where it is
 * written; and what the read-back reads beside M's sides. */
export interface Sketch {
	readonly op: Op
	readonly beside: boolean
	readonly again: boolean
	readonly sides: "added" | "removed" | "both"
	readonly other: "A" | "Z"
	readonly written: "none" | "first" | "second"
	readonly reads: "nothing" | "delta" | "state"
}

export const sketchGen: Gen<Sketch> = (source) => ({
	op: source.draw(element(["insert", "delete", "put"] as const)),
	beside: source.draw(boolean),
	again: source.draw(boolean),
	sides: source.draw(element(["added", "removed", "both"] as const)),
	other: source.draw(element(["A", "Z"] as const)),
	written: source.draw(element(["none", "first", "second"] as const)),
	reads: source.draw(element(["nothing", "delta", "state"] as const))
})

/** The kind of write whose statement makes a delta (the statement's result): an insertion's or a put's insert half's,
 * a deletion's or a put's displacing deletion's. */
type Maker = "insert" | "put" | "delete" | "displaced"

/** A write the construction implies: the relation and side it makes, its stratum, the statement it is part of, and its
 * kind. */
interface Write {
	readonly relation: string
	readonly side: Side
	readonly stratum: 1 | 2
	readonly statement: string
	readonly maker: Maker
}

/** The writes a case implies, each in the statement the realization puts it in. A put of the mutable M is its upsert,
 * one statement, where the read-back names M's added side alone, and its displacing deletion and its upsert, two, where
 * it names M's removed side. */
const writesOf = (s: Sketch): ReadonlyArray<Write> => {
	const upsertAlone = s.op === "put" && s.sides === "added"
	const firstSingle = (s.op !== "put" || upsertAlone) && !s.beside && s.written === "first"
	const secondSingle = s.again && s.written === "second"
	const at = (stratum: 1 | 2, own: string): string =>
		(stratum === 1 && firstSingle) || (stratum === 2 && secondSingle)
			? `stratum ${stratum}`
			: `stratum ${stratum}: ${own}`
	const of = (relation: string, side: Side, stratum: 1 | 2, own: string, maker: Maker): Write => ({
		relation,
		side,
		stratum,
		statement: at(stratum, own),
		maker
	})
	const first: ReadonlyArray<Write> =
		s.op === "insert"
			? [of("M", "added", 1, "M", "insert")]
			: s.op === "delete"
				? [of("M", "removed", 1, "M", "delete")]
				: upsertAlone
					? [of("M", "added", 1, "M", "put")]
					: [of("M", "removed", 1, "M displaced", "displaced"), of("M", "added", 1, "M put", "put")]
	const beside: ReadonlyArray<Write> = !s.beside
		? []
		: s.op === "delete"
			? [of("M", "added", 1, "M beside", "insert")]
			: [of("M", "removed", 1, "M beside", "delete")]
	const again: ReadonlyArray<Write> = s.again ? [of("M", "added", 2, "M", "insert")] : []
	const other: ReadonlyArray<Write> =
		s.written === "none"
			? []
			: [of(s.other, "added", s.written === "first" ? 1 : 2, s.other, "insert")]
	return [...first, ...beside, ...again, ...other]
}

/** The statement that makes a named side whole: the relation and kind of its write of the side, and the relations its
 * statement writes. */
export interface Making {
	readonly relation: string
	readonly maker: Maker
	readonly writes: ReadonlyArray<string>
}

/** What the model says of a case: the statement the read-back rides, which makes every side it names whole; after the
 * last stratum, each side it names carried out of the statement making it whole, none where it names no side a
 * statement makes; or refused, with every side no one statement makes whole. */
type Verdict =
	| ({ readonly kind: "rides" } & Making)
	| {
			readonly kind: "after"
			readonly carried: ReadonlyArray<{ readonly side: NamedSide; readonly making: Making }>
	  }
	| { readonly kind: "refused"; readonly sides: ReadonlyArray<NamedSide> }

/** The model (the header): the case's writes, the sides the read-back names, and where each is made whole. */
export const verdictOf = (s: Sketch): Verdict => {
	const writes = writesOf(s)
	const makers = (relation: string, side: Side) =>
		Arr.filter(writes, (w) => w.relation === relation && w.side === side)
	const wanted: ReadonlyArray<NamedSide> = [
		...(s.sides === "removed" ? [] : [{ relation: "M", side: "added" as const }]),
		...(s.sides === "added" ? [] : [{ relation: "M", side: "removed" as const }]),
		...(s.reads === "delta" ? [{ relation: s.other, side: "added" as const }] : [])
	]
	const named = Arr.filter(wanted, (n) => makers(n.relation, n.side).length > 0)
	const whole = (n: NamedSide): Write | undefined => {
		const [maker, ...others] = makers(n.relation, n.side)
		if (maker === undefined || others.length > 0) {
			return undefined
		}
		const netting = Arr.filter(
			makers(n.relation, n.side === "added" ? "removed" : "added"),
			(w) => w.stratum !== maker.stratum
		)
		return Arr.isReadonlyArrayEmpty(netting) ? maker : undefined
	}
	const made = Arr.map(named, (n) => ({ side: n, write: whole(n) }))
	const broken = Arr.flatMap(made, (m) => (m.write === undefined ? [m.side] : []))
	if (Arr.isReadonlyArrayNonEmpty(broken)) {
		return { kind: "refused", sides: broken }
	}
	const making = (w: Write): Making => ({
		relation: w.relation,
		maker: w.maker,
		writes: Arr.sort(
			Arr.dedupe(
				Arr.map(
					Arr.filter(writes, (x) => x.statement === w.statement),
					(x) => x.relation
				)
			),
			Order.String
		)
	})
	const wholes = Arr.flatMap(made, (m) =>
		m.write === undefined ? [] : [{ side: m.side, write: m.write }]
	)
	const [first] = wholes
	const together =
		first !== undefined && Arr.every(wholes, (w) => w.write.statement === first.write.statement)
	const stateAfter =
		first !== undefined &&
		s.reads === "state" &&
		(s.written === "second" ||
			(s.written === "first" &&
				Arr.some(writes, (w) => w.relation === s.other && w.statement === first.write.statement)))
	if (first !== undefined && together && !stateAfter) {
		return { kind: "rides", ...making(first.write) }
	}
	return {
		kind: "after",
		carried: Arr.map(wholes, (w) => ({ side: w.side, making: making(w.write) }))
	}
}

/** What a box's ChangeSets are built and compiled over: a schema, its M and the relations W may be, and its names and
 * artifacts. */
const subjectOf = (value: FixtureSchema, name: string, m: unknown, a: unknown, z: unknown) => {
	const owned = owning(value)
	return {
		schema: value,
		m,
		a,
		z,
		checked: checking(value),
		names: succeeded(
			compileInstallation(owned, {
				...installOptions(owned),
				levels: [identity.schema(parsedSchemaName(name))]
			})
		).names,
		artifacts: succeeded(testArtifacts(value, testCompile))
	}
}

type Subject = ReturnType<typeof subjectOf>

/** The box's subject built afresh: its names and artifacts objects of their own, which no compile has read under. */
export const freshSubject = (): Subject => subjectOf(S, schemaName, M, A, Z)

/** The box's subject, built once when a worker loads the module and read by every case. */
export const subject: Subject = freshSubject()

/** The read-back's rule: each source it reads matched by id, its payload under a name of its own. */
const readBackOf = (s: Sketch, at: Subject, other: unknown) => (d: DeltaValue) =>
	queryOver(at.schema).rule((r: RuleValue): FinishedValue => {
		const id = defined(varsOver(at.m, "key")["id"], "the id variable")
		const sources = Arr.map(
			[
				...(s.sides === "removed" ? [] : [["added", d.added(at.m)] as const]),
				...(s.sides === "added" ? [] : [["removed", d.removed(at.m)] as const]),
				...(s.reads === "delta" ? [["other", d.added(other)] as const] : []),
				...(s.reads === "state" ? [["state", other] as const] : [])
			],
			([name, from]) => ({
				name,
				from,
				payload: defined(varsOver(at.m, name)["v"], "a payload variable")
			})
		)
		const matched = Arr.reduce(sources, r, (rule, x) => rule.match(x.from, { id, v: x.payload }))
		return matched.find({ id, ...Rec.fromEntries(Arr.map(sources, (x) => [x.name, x.payload])) })
	})

/** A case's ChangeSet, built through the untyped core since its members are drawn: M's insertions arrays and a query of
 * whole facts. */
const changeOf = (s: Sketch, at: Subject): ChangeSetValue => {
	const other = s.other === "A" ? at.a : at.z
	const firstOf = (value: ChangeSetValue): ChangeSetValue => {
		const own = value[s.op](at.m, [])
		const beside = s.beside
			? s.op === "delete"
				? own.insert(at.m, [])
				: own.delete(at.m, [])
			: own
		return s.written === "first" ? beside.insert(other, []) : beside
	}
	const first = firstOf(changeSetOver.empty(at.schema))
	const againOf = (value: ChangeSetValue): ChangeSetValue =>
		!s.again
			? value
			: value.insert(
					at.m,
					queryOver(at.schema).rule((r: RuleValue): FinishedValue => {
						const vars = varsOver(at.m, "more")
						const all = {
							id: defined(vars["id"], "the id variable"),
							v: defined(vars["v"], "the payload")
						}
						return r.match(r.relation("more", at.m), all).find(all)
					})
				)
	const second = againOf(changeSetOver.empty(at.schema))
	const both =
		s.again || s.written === "second"
			? changeSetOver.sequence(first, s.written === "second" ? second.insert(other, []) : second)
			: first
	return both.read("r", readBackOf(s, at, other))
}

/** A case's ChangeSet, compiled over reality at SERIALIZABLE. */
export const compiledSketch = (s: Sketch, at: Subject) =>
	compileWrite(at.checked, defined(changeSetDesc(changeOf(s, at)), "a ChangeSet"), {
		names: at.names,
		reads: at.names,
		claims: { kind: "every" },
		world: { kind: "reality" },
		laws: at.artifacts.laws,
		derived: at.artifacts.derived,
		level: "serializable",
		clock: noClock,
		source: transactionClock,
		carrierScope: carrierScope(undefined)
	})

/** The kind of write a statement's result says made its delta: a put's insert half of the mutable M is its upsert. */
const makerOf = (result: WriteStepResult): Maker | undefined => {
	switch (result.kind) {
		case "insert":
			return result.of
		case "delete":
			return removedTag(result)
		case "upsert":
			return "put"
		case "update":
		case "merge":
			return undefined
	}
}

/** The writes of the statement at `position`, a statement of tagged parts: each part's relation and the maker of its
 * rows. */
const writtenAt = (
	artifact: WriteArtifact,
	position: number
): ReadonlyArray<{ readonly relation: string; readonly maker: Maker | undefined }> => {
	const step = defined(artifact.statements[position], "the statement").step
	assert.equal(
		step.kind,
		"single",
		"a read-back rides, or a side is carried out of, a statement of tagged parts"
	)
	return step.kind === "single"
		? Arr.map(step.parts, (p) => ({ relation: p.step.relation, maker: makerOf(p.step.result) }))
		: []
}

/** Whether the statement at `position` is the one `making` says: its write of the side's relation by that maker, and
 * the relations it writes. */
export const isMaking = (artifact: WriteArtifact, position: number, making: Making): boolean => {
	const parts = writtenAt(artifact, position)
	return (
		Arr.some(parts, (p) => p.relation === making.relation && p.maker === making.maker) &&
		sameWrites(
			Arr.sort(
				Arr.map(parts, (p): string => p.relation),
				Order.String
			),
			making.writes
		)
	)
}

/** Two lists of relation names, equal element by element. */
const sameWrites = Arr.makeEquivalence(Equivalence.String)

/** The relations the riding statement at `position` writes, and the maker of its write of `relation`. */
export const ridden = (
	artifact: WriteArtifact,
	position: number,
	relation: string
): { readonly writes: ReadonlyArray<string>; readonly maker: Maker | undefined } => {
	const parts = writtenAt(artifact, position)
	const own = defined(
		Option.getOrUndefined(Arr.findFirst(parts, (p) => p.relation === relation)),
		`the ridden statement's write of ${relation}`
	)
	return {
		writes: Arr.sort(
			Arr.map(parts, (p): string => p.relation),
			Order.String
		),
		maker: own.maker
	}
}

/** Whether two named sides are one. */
export const sameSide = (x: NamedSide, y: NamedSide): boolean =>
	x.relation === y.relation && x.side === y.side

export type Feature =
	| "rides an insert"
	| "rides a delete"
	| "rides a put's insert half"
	| "rides a put's displacing deletion"
	| "rides one statement of two writes"
	| "rides beside the opposite action of M in its stratum"
	| "rides after state written beside it, named before it"
	| "rides after state written beside it, named after it"
	| "runs after the writes"
	| "carried past state its own statement writes"
	| "carried past state a later stratum writes"
	| "carried, two sides two statements make"
	| "carried out of a put's displacing deletion"
	| "refused: a side two statements make"

export const ridingNotes: { readonly [K in Maker]: Feature } = {
	insert: "rides an insert",
	delete: "rides a delete",
	put: "rides a put's insert half",
	displaced: "rides a put's displacing deletion"
}
