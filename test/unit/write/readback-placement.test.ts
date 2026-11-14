/**
 * Where a ChangeSet's read-back runs (write/schedule/plan.ts placeReadBacks): a read-back over a delta a statement makes
 * rides the one statement that makes every side it reads whole, after every write of the state it reads; one that reads
 * no delta a statement makes runs after the writes; any other is refused as ReadBackCrossesStatements, naming one of its
 * crossings. No artifact carries a delta in a temporary table.
 *
 * The box, constructed: over immutable relations M, A and Z of an id and a payload, a first stratum that inserts, deletes
 * or puts M's facts, with or without the opposite action of M beside it (a delete beside an insert or a put, an insert
 * beside a delete), and with or without a second stratum inserting M's facts again from a query over a relation
 * parameter; another relation W, A or Z, written by an insert in the first stratum, in the second, or not at all; and
 * one read-back of one rule joining by id M's added facts, its removed facts, or both, with W's added facts, W's
 * state, or neither. M's id is a plain integer, or a serial its sequence draws: then every insertion of M is a
 * generated addition, a query over a relation parameter of payloads alone, and M's deletions and puts are arrays of
 * whole facts. Every other member is an array a call gives, so no member is carried. Exhausted.
 *
 * Oracle: the rule as a model over the statements the construction implies. M's first-stratum action is one statement,
 * an insert's or a delete's, or a put's two, its displacing deletion making removed facts and its insert half added
 * ones; an action beside it is one more; a second stratum's insert is one more. A stratum of one-statement writes of
 * two relations is one statement. A side is made whole by a statement exactly where that statement is its only maker
 * and no maker of the opposite side is of another stratum or a generated addition, nor is the maker one: no fact is
 * both added and removed by the writes of one stratum (README, "A row one stratum both adds and deletes stays") but a
 * generated addition's, whose drawn id a lagging sequence may repeat; a read-back rides where every side it names, of a
 * side some statement makes, is made whole by one statement and W, which the read-back reads as state, is written
 * before it: W written at that statement (one statement of both writes) or in a later stratum is state after it, and W
 * written beside M in a stratum of several statements is ordered first. The model's crossings are every side not made
 * whole, every two sides made whole by two statements, and state after; a refusal names one of them, and is made
 * exactly where there is one. A read-back naming no side any statement makes runs after the writes.
 *
 * Features: riding an insert, a delete, a put's insert half, a put's displacing deletion and one statement of two
 * writes; riding beside the opposite action of M in its stratum; riding a generated addition; a generated addition
 * beside the opposite action of M refused; riding after W's state written beside M, by name before M and after it;
 * running after the writes; and each crossing refused.
 *
 * Plants (~/.cache/grizzle-release/CARRIER/plants): placement-relation-writers (a delta's writers counted by relation,
 * as before, so a put's sides never ride), placement-no-netting (a side's one maker taken whole whatever nets against
 * it), placement-no-order-key (the canonical order with no key for the delta relations), placement-own-writes-settled
 * (the statement a read-back rides left out of the writes after it), placement-strata-settled (the writes of later
 * strata left out), placement-sides-together (a read-back of two sides placed at the first's statement); and
 * ~/.cache/grizzle-release/READBACK/plants/placement-stratum-cancels.patch (an addition and a removal of one stratum
 * taken to cancel, so a read-back beside the opposite action of its relation is refused) and
 * ~/.cache/grizzle-release/READBACK/plants/placement-drawn-whole.patch (a generated addition taken never to cancel
 * with its stratum's removals, so its read-back beside a deletion rides).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { boolean, element, type Gen } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import type { NamedSide, ReadBackCrossing } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { removedTag, type WriteStepResult } from "#compiler/runtime/write/steps.ts"
import {
	changeSetDesc,
	changeSetOver,
	type ChangeSetValue
} from "#compiler/write/changeset/value.ts"
import type { DeltaValue } from "#compiler/write/delta/source.ts"
import type { WriteArtifact } from "#compiler/write/program/artifact.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { type FixtureSchema, testArtifacts, testCompile } from "#test/support/compile.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, owning } from "#test/support/policy.ts"

const M = relation("M", { id: pg.int4, v: pg.int4 }, ["id"])
const A = relation("A", { id: pg.int4, v: pg.int4 }, ["id"])
const Z = relation("Z", { id: pg.int4, v: pg.int4 }, ["id"])
const schemaName = "readback_placement"
const S = schema(schemaName, [M, A, Z], [])
/** M with an id its sequence draws, in a schema of its own beside copies of A and Z. */
const MD = relation("M", { id: pg.serial, v: pg.int4 }, ["id"])
const AD = relation("A", { id: pg.int4, v: pg.int4 }, ["id"])
const ZD = relation("Z", { id: pg.int4, v: pg.int4 }, ["id"])
const drawnName = "readback_placement_drawn"
const SD = schema(drawnName, [MD, AD, ZD], [])

type Op = "insert" | "delete" | "put"
type Side = NamedSide["side"]

/** A case: M's first-stratum action, the opposite action beside it, a second stratum's insert of M; W, where it is
 * written; and what the read-back reads beside M's sides. */
interface Sketch {
	readonly drawn: boolean
	readonly op: Op
	readonly beside: boolean
	readonly again: boolean
	readonly sides: "added" | "removed" | "both"
	readonly other: "A" | "Z"
	readonly written: "none" | "first" | "second"
	readonly reads: "nothing" | "delta" | "state"
}

const sketchGen: Gen<Sketch> = (source) => ({
	drawn: source.draw(boolean),
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

/** A write the construction implies: the relation and side it makes, its stratum, the statement it is part of, its
 * kind, and whether it is a generated addition. */
interface Write {
	readonly relation: string
	readonly side: Side
	readonly stratum: 1 | 2
	readonly statement: string
	readonly maker: Maker
	readonly drawn: boolean
}

/** The writes a case implies, each in the statement the realization puts it in. */
const writesOf = (s: Sketch): ReadonlyArray<Write> => {
	const firstSingle = s.op !== "put" && !s.beside && s.written === "first"
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
		maker,
		drawn: s.drawn && relation === "M" && maker === "insert"
	})
	const first: ReadonlyArray<Write> =
		s.op === "insert"
			? [of("M", "added", 1, "M", "insert")]
			: s.op === "delete"
				? [of("M", "removed", 1, "M", "delete")]
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

/** What the model says of a case: the statement the read-back rides, with the relations it writes and the write that
 * makes the first named side; after the writes; or refused, with every crossing the case holds. */
type Verdict =
	| {
			readonly kind: "rides"
			readonly relation: string
			readonly maker: Maker
			readonly writes: ReadonlyArray<string>
	  }
	| { readonly kind: "after" }
	| { readonly kind: "refused"; readonly crossings: ReadonlyArray<ReadBackCrossing> }

/** The model (the header): the case's writes, the sides the read-back names, and where each is made whole. */
const verdictOf = (s: Sketch): Verdict => {
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
			(w) => w.stratum !== maker.stratum || w.drawn || maker.drawn
		)
		return Arr.isReadonlyArrayEmpty(netting) ? maker : undefined
	}
	const [first] = named
	if (first === undefined) {
		return { kind: "after" }
	}
	const made = Arr.map(named, (n) => ({ side: n, write: whole(n) }))
	const twice = Arr.flatMap(made, (m): ReadonlyArray<ReadBackCrossing> =>
		m.write === undefined ? [{ kind: "sideWrittenTwice", ...m.side }] : []
	)
	const apart = Arr.flatMap(made, (x) =>
		Arr.flatMap(made, (y): ReadonlyArray<ReadBackCrossing> =>
			x.write !== undefined && y.write !== undefined && x.write.statement !== y.write.statement
				? [{ kind: "sidesApart", first: x.side, second: y.side }]
				: []
		)
	)
	const [riding] = Arr.flatMap(made, (m) => (m.write === undefined ? [] : [m.write]))
	const stateAfter =
		riding !== undefined &&
		s.reads === "state" &&
		(s.written === "second" ||
			(s.written === "first" &&
				Arr.some(writes, (w) => w.relation === s.other && w.statement === riding.statement)))
	const after: ReadonlyArray<ReadBackCrossing> = stateAfter
		? Arr.map(named, (n): ReadBackCrossing => ({ kind: "stateAfter", delta: n, state: s.other }))
		: []
	const crossings = [...twice, ...apart, ...after]
	if (Arr.isReadonlyArrayNonEmpty(crossings) || riding === undefined) {
		return { kind: "refused", crossings }
	}
	return {
		kind: "rides",
		relation: riding.relation,
		maker: riding.maker,
		writes: Arr.sort(
			Arr.dedupe(
				Arr.map(
					Arr.filter(writes, (w) => w.statement === riding.statement),
					(w) => w.relation
				)
			),
			Order.String
		)
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
				...installOptions(owned, "owner"),
				levels: [identity.schema(parsedSchemaName(name))]
			})
		).names,
		artifacts: succeeded(testArtifacts(value, testCompile))
	}
}

type Subject = ReturnType<typeof subjectOf>

const plain = subjectOf(S, schemaName, M, A, Z)
const drawnSubject = subjectOf(SD, drawnName, MD, AD, ZD)

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

/** A generated addition of the drawn M: a query over the relation parameter `name` of payloads alone. */
const generatedOf = (at: Subject, name: string) =>
	queryOver(at.schema).rule((r: RuleValue): FinishedValue => {
		const v = defined(varsOver(at.m, name)["v"], "the payload")
		return r.match(r.relation(name, { v: MD.fields.v }), { v }).find({ v })
	})

/** A case's ChangeSet, built through the untyped core since its members are drawn: M's insertions arrays and a query of
 * whole facts, or, M's id drawn, each a generated addition. */
const changeOf = (s: Sketch, at: Subject): ChangeSetValue => {
	const other = s.other === "A" ? at.a : at.z
	const insertM = (value: ChangeSetValue, name: string): ChangeSetValue =>
		s.drawn ? value.insert(at.m, generatedOf(at, name)) : value.insert(at.m, [])
	const firstOf = (value: ChangeSetValue): ChangeSetValue => {
		const own = s.op === "insert" ? insertM(value, "given") : value[s.op](at.m, [])
		const beside = s.beside
			? s.op === "delete"
				? insertM(own, "beside")
				: own.delete(at.m, [])
			: own
		return s.written === "first" ? beside.insert(other, []) : beside
	}
	const first = firstOf(changeSetOver.empty(at.schema))
	const againOf = (value: ChangeSetValue): ChangeSetValue =>
		!s.again
			? value
			: s.drawn
				? value.insert(at.m, generatedOf(at, "more"))
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
const compiled = (s: Sketch) => {
	const at = s.drawn ? drawnSubject : plain
	return compileWrite(at.checked, defined(changeSetDesc(changeOf(s, at)), "a ChangeSet"), {
		names: at.names,
		reads: at.names,
		claims: { kind: "every" },
		world: { kind: "reality" },
		laws: at.artifacts.laws,
		derived: at.artifacts.derived,
		level: "serializable"
	})
}

/** The kind of write a statement's result says made its delta. */
const makerOf = (result: WriteStepResult): Maker | undefined => {
	switch (result.kind) {
		case "insert":
			return result.of
		case "delete":
			return removedTag(result)
		case "upsert":
		case "update":
		case "merge":
		case "spanClassify":
			return undefined
	}
}

/** The relations the riding statement at `position` writes, and the maker of its write of `relation`. */
const ridden = (
	artifact: WriteArtifact,
	position: number,
	relation: string
): { readonly writes: ReadonlyArray<string>; readonly maker: Maker | undefined } => {
	const step = defined(artifact.statements[position], "the ridden statement").step
	assert.equal(step.kind, "single", "a read-back rides a statement of tagged parts")
	const parts = step.kind === "single" ? Arr.map(step.parts, (p) => p.step) : []
	const own = defined(
		Option.getOrUndefined(Arr.findFirst(parts, (p) => p.relation === relation)),
		`the ridden statement's write of ${relation}`
	)
	return {
		writes: Arr.sort(
			Arr.map(parts, (p): string => p.relation),
			Order.String
		),
		maker: makerOf(own.result)
	}
}

/** Whether two named sides are one. */
const sameSide = (x: NamedSide, y: NamedSide): boolean =>
	x.relation === y.relation && x.side === y.side

/** Whether `got`, a refusal's crossing, is one the model holds: two sides apart in either order. */
const holds = (crossings: ReadonlyArray<ReadBackCrossing>, got: ReadBackCrossing): boolean =>
	Arr.some(crossings, (c) => {
		switch (c.kind) {
			case "sideWrittenTwice":
				return got.kind === "sideWrittenTwice" && sameSide(c, got)
			case "sidesApart":
				return (
					got.kind === "sidesApart" &&
					((sameSide(c.first, got.first) && sameSide(c.second, got.second)) ||
						(sameSide(c.first, got.second) && sameSide(c.second, got.first)))
				)
			case "stateAfter":
				return got.kind === "stateAfter" && got.state === c.state && sameSide(c.delta, got.delta)
		}
	})

type Feature =
	| "rides an insert"
	| "rides a delete"
	| "rides a put's insert half"
	| "rides a put's displacing deletion"
	| "rides one statement of two writes"
	| "rides beside the opposite action of M in its stratum"
	| "rides a generated addition"
	| "refused: a generated addition beside the opposite action of M"
	| "rides after state written beside it, named before it"
	| "rides after state written beside it, named after it"
	| "runs after the writes"
	| "refused: a side two statements make"
	| "refused: two sides apart"
	| "refused: state after"

const ridingNotes: { readonly [K in Maker]: Feature } = {
	insert: "rides an insert",
	delete: "rides a delete",
	put: "rides a put's insert half",
	displaced: "rides a put's displacing deletion"
}

const crossingNotes: { readonly [K in ReadBackCrossing["kind"]]: Feature } = {
	sideWrittenTwice: "refused: a side two statements make",
	sidesApart: "refused: two sides apart",
	stateAfter: "refused: state after"
}

describe("a ChangeSet's read-back", () => {
	it.effect(
		"rides the one statement that makes its delta after the state it reads, runs after the writes over no delta, and is refused otherwise",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/readback-placement",
						generator: sketchGen,
						literal: Formatter.format,
						box: "M's id plain or drawn, every first-stratum action of M, the opposite action beside it or not, M again in a second stratum or not, W written in either stratum or not, and a read-back of M's added, removed or both sides with W's added facts, its state or neither",
						oracle: {
							kind: "specification",
							name: "the placement rule as a model over the statements the construction implies"
						},
						coverage: requiredInSpace<Feature>([
							"rides an insert",
							"rides a delete",
							"rides a put's insert half",
							"rides a put's displacing deletion",
							"rides one statement of two writes",
							"rides beside the opposite action of M in its stratum",
							"rides a generated addition",
							"refused: a generated addition beside the opposite action of M",
							"rides after state written beside it, named before it",
							"rides after state written beside it, named after it",
							"runs after the writes",
							"refused: a side two statements make",
							"refused: two sides apart",
							"refused: state after"
						]),
						caseHang,
						concurrency: 1
					},
					(sketch, c) =>
						Effect.sync(() => {
							const program = compiled(sketch)
							const verdict = verdictOf(sketch)
							if (verdict.kind === "refused") {
								if (program.ok) {
									return assert.fail("refused, as the model holds a crossing")
								}
								const reason = program.error.reason
								if (reason._tag !== "ReadBackCrossesStatements") {
									return assert.fail(`refused as ${reason._tag}, not crossing statements`)
								}
								assert.equal(reason.read, "r")
								assert.ok(
									holds(verdict.crossings, reason.crossing),
									`the crossing ${Formatter.format(reason.crossing)} is one of ${Formatter.format(verdict.crossings)}`
								)
								c.note(crossingNotes[reason.crossing.kind])
								if (
									sketch.drawn &&
									sketch.beside &&
									sketch.op !== "put" &&
									reason.crossing.kind === "sideWrittenTwice"
								) {
									c.note("refused: a generated addition beside the opposite action of M")
								}
								return
							}
							const artifact = succeeded(program, "the ChangeSet compiles").artifact
							assert.deepEqual(
								Arr.filter(artifact.statements, (st) => st.step.kind === "carrier"),
								[],
								"no carrier"
							)
							const carried = defined(
								Option.getOrUndefined(Arr.findFirst(artifact.readBacks, (r) => r.name === "r")),
								"the read-back"
							).carried
							if (verdict.kind === "after") {
								assert.equal(carried.kind, "sent", "runs after the writes")
								c.note("runs after the writes")
								return
							}
							if (carried.kind !== "riding") {
								return assert.fail("rides the statement that makes its delta")
							}
							assert.deepEqual(
								ridden(artifact, carried.statement, verdict.relation),
								{ writes: verdict.writes, maker: verdict.maker },
								"the statement it rides"
							)
							c.note(ridingNotes[verdict.maker])
							if (verdict.writes.length > 1) {
								c.note("rides one statement of two writes")
							}
							if (sketch.beside) {
								c.note("rides beside the opposite action of M in its stratum")
							}
							if (sketch.drawn && verdict.maker === "insert" && verdict.relation === "M") {
								c.note("rides a generated addition")
							}
							if (sketch.reads === "state" && sketch.written === "first") {
								c.note(
									sketch.other === "A"
										? "rides after state written beside it, named before it"
										: "rides after state written beside it, named after it"
								)
							}
						})
				)
			)
	)
})
