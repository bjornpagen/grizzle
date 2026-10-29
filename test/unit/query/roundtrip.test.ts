import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string
} from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order, Schema } from "effect"
import { ALLEN } from "#compiler/allen/mask.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { CompileReasonTag } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import { decodeDesc, descText, type QueryDesc } from "#compiler/ir/desc.ts"
import { fromQueryDescription, toQueryDescription } from "#compiler/ir/describe.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import {
	isOrderedValue,
	isQueryValue,
	type OrderedValue,
	type QueryValue,
	queryOver as query,
	queryFromDesc,
	queryValueHeading,
	varsOver as v
} from "#compiler/query/build/query.ts"
import type { FinishedValue, RuleValue } from "#compiler/query/build/rule.ts"
import { computeCore as Compute } from "#compiler/scalar/compute/builders.ts"
import { assert } from "#test/support/assert.ts"
import { AutomaticTask, Kind, Task, TaskNote, Work } from "#test/support/fixtures/api/work.ts"
import { decodeJson } from "#test/support/json.ts"
import { at, Booking, descOf, Schedule } from "#test/unit/query/fixtures.ts"

/**
 * A Description rebuilds the same query: a query value rebuilt from its QueryDesc records the same Description,
 * carries the same heading and supports the same combinators; and the builder's output is deterministic, valid,
 * canonical and stable over generated queries.
 */
const text = (q: unknown): string => {
	const t = descText(descOf(q))
	if (!t.ok) {
		throw t.error
	}
	return t.value
}

const rebuilt = (desc: QueryDesc, schema: unknown): QueryValue | OrderedValue => {
	const value = queryFromDesc(desc, schema)
	if (!value.ok) {
		throw value.error
	}
	return value.value
}

/** A rebuilt Query, checked to be one. */
const rebuiltQuery = (desc: QueryDesc, schema: unknown): QueryValue => {
	const value = rebuilt(desc, schema)
	if (!isQueryValue(value)) {
		throw new Error("not a Query")
	}
	return value
}

/** The parent variables an attachment passes its child, as the builder's untyped core reads them. */
type ParentVars = Readonly<Record<string, unknown>>

/** JSON text parsed back as plain JSON, which fromQueryDescription admits as it would any untrusted value. */
const transportText = decodeJson(Schema.Unknown)

const viaDescription = (desc: QueryDesc): QueryDesc => {
	const description = toQueryDescription(desc)
	if (!description.ok) {
		throw description.error
	}
	/** Transported as JSON text, as a caller stores and sends it. */
	const parsed = fromQueryDescription(transportText(JSON.stringify(description.value)))
	if (!parsed.ok) {
		throw parsed.error
	}
	const decoded = fromQueryDescription(description.value)
	if (!decoded.ok) {
		throw decoded.error
	}
	assert.deepEqual(descText(parsed.value), descText(decoded.value))
	return parsed.value
}

/** The names a heading carries: its fields in heading order, and its attachments. */
const names = (q: unknown) => {
	const h = queryValueHeading(q)
	if (h === undefined) {
		throw new Error("not a query value")
	}
	return { fields: [...h.fields.keys()], attached: Arr.sort([...h.attached], Order.String) }
}

/** Generated queries: arms over a schema, then a chain of combinators, then an ending. */
type Op =
	| { readonly op: "rule"; readonly arm: number }
	| { readonly op: "named" }
	| { readonly op: "attach" }
	| {
			readonly op: "take"
			readonly k: number
			readonly dir: "asc" | "desc"
			readonly param: boolean
	  }
	| { readonly op: "import" }

/** The chain may end ordered: an Ordered is no Query, so the ending is drawn apart from the ops and applied last. */
type Ending = { readonly kind: "set" } | { readonly kind: "ordered"; readonly dir: "asc" | "desc" }

/** A schema's generated queries: the arms drawn over it, how each builds a rule, a key to order by, and a child. */
interface Grammar<A> {
	readonly schema: unknown
	readonly arms: Gen<A>
	readonly rule: (arm: A) => (r: RuleValue) => FinishedValue
	/** A field every arm's head has, to order by. */
	readonly key: string
	readonly child: (p: ParentVars) => QueryValue
}

const opGen = (armCount: number): Gen<Op> =>
	oneOf<Op>([
		map(int(0, armCount - 1), (arm): Op => ({ op: "rule", arm })),
		constant({ op: "named" }),
		constant({ op: "attach" }),
		(source) => ({
			op: "take",
			k: source.draw(int(1, 5)),
			dir: source.draw(element(["asc", "desc"] as const)),
			param: source.draw(boolean)
		}),
		constant({ op: "import" })
	])

const endingGen: Gen<Ending> = element<Ending>([
	{ kind: "set" },
	{ kind: "ordered", dir: "asc" },
	{ kind: "ordered", dir: "desc" }
])

/** One op applied to the chain so far; `i` numbers its names. */
const applyOp = <A>(
	gen: Grammar<A>,
	out: QueryValue,
	arms: ReadonlyArray<A>,
	op: Op,
	i: number
): QueryValue => {
	switch (op.op) {
		case "rule":
			return out.rule(gen.rule(at(arms, op.arm)))
		case "named":
			return out.named(`stage${i}`)
		case "attach":
			return out.attach(`a${i}`, gen.child, "array")
		case "take":
			return out.orderBy([gen.key, op.dir]).take(op.param ? "batch" : op.k)
		case "import":
			return query(gen.schema).rule((r: RuleValue) => {
				const vars = v(out)
				return r.match(out, vars).find(vars)
			})
	}
}

/** Applies `ops` to `q`, numbering names from `offset` so a split chain names its stages as the whole chain does. */
const applyOps = <A>(
	gen: Grammar<A>,
	q: QueryValue,
	arms: ReadonlyArray<A>,
	ops: ReadonlyArray<Op>,
	offset: number
): QueryValue => Arr.reduce(ops, q, (out, op, j) => applyOp(gen, out, arms, op, offset + j))

/** The chain's ending, applied after every op. */
const ended = <A>(gen: Grammar<A>, q: QueryValue, ending: Ending): QueryValue | OrderedValue =>
	ending.kind === "set" ? q : q.orderBy([gen.key, ending.dir])

const generated =
	<A>(gen: Grammar<A>): Gen<readonly [ReadonlyArray<A>, ReadonlyArray<Op>, Ending, number]> =>
	(source) =>
		[
			source.draw(array(gen.arms, { min: 1, max: 3 })),
			source.draw(array(opGen(3), { min: 0, max: 4 })),
			source.draw(endingGen),
			source.draw(int(0, 2 ** 31 - 1))
		] as const

const property =
	<A>(gen: Grammar<A>) =>
	([armsIn, ops, ending, cut]: readonly [
		ReadonlyArray<A>,
		ReadonlyArray<Op>,
		Ending,
		number
	]): Effect.Effect<void> =>
		Effect.sync(() => {
			const arms = [...armsIn, ...armsIn, ...armsIn]
			const chain = (part: ReadonlyArray<Op>, offset: number): QueryValue =>
				applyOps(gen, query(gen.schema).rule(gen.rule(at(arms, 0))), arms, part, offset)
			const q = ended(gen, chain(ops, 0), ending)
			/** descOf asserts the Description canonical: no provisional spelling, every clause variable listed. */
			const desc = descOf(q)
			assert.equal(decodeDesc("query", desc).ok, true)
			assert.equal(text(ended(gen, chain(ops, 0), ending)), text(q))
			const back = rebuilt(desc, gen.schema)
			assert.equal(text(back), text(q))
			assert.equal(text(rebuilt(viaDescription(desc), gen.schema)), text(q))
			assert.equal(isOrderedValue(back), ending.kind === "ordered")
			assert.deepEqual(names(back), names(q))
			assert.deepEqual(names(rebuilt(desc, undefined)), names(q))
			/**
			 * Rebuilding a prefix of the chain and applying the rest, then the ending, gives the whole chain's Description.
			 */
			const k = cut % (ops.length + 1)
			const prefix = rebuiltQuery(descOf(chain(ops.slice(0, k), 0)), gen.schema)
			const resumed = ended(gen, applyOps(gen, prefix, arms, ops.slice(k), k), ending)
			assert.equal(text(resumed), text(q))
			assert.deepEqual(names(resumed), names(q))
		})

/**
 * Over the worked example's schema: matches, negations, parameter filters, between with variable bounds, Compute cast, cond and
 * base, inSet, an interior stage, a bound import, and aggregate heads. A cond's first branch is a term, never a literal
 * or a parameter, since it types the conditional (scalar/compute/builders.ts cond): condLiteral states its literal
 * second.
 */
interface WorkArm {
	/** The task's kind bound to a literal, or left free. */
	readonly kind: "Automatic" | "Manual" | "free"
	readonly budget: boolean
	readonly note: boolean
	readonly noNote: boolean
	readonly byAccount: boolean
	readonly between: boolean
	readonly compute: "none" | "cast" | "cond" | "condLiteral" | "base"
	readonly inSet: boolean
	readonly interior: boolean
	readonly bind: boolean
	readonly head: "plain" | "count" | "sum"
}

const notesOf = query(Work).rule((r: RuleValue) => {
	const { note } = v(TaskNote)
	return r.match(TaskNote, { task: r.param("task", TaskNote.fields.task), note }).find({ note })
})

const work: Grammar<WorkArm> = {
	schema: Work,
	arms: (source) => ({
		kind: source.draw(element(["Automatic", "Manual", "free"] as const)),
		budget: source.draw(boolean),
		note: source.draw(boolean),
		noNote: source.draw(boolean),
		byAccount: source.draw(boolean),
		between: source.draw(boolean),
		compute: source.draw(element(["none", "cast", "cond", "condLiteral", "base"] as const)),
		inSet: source.draw(boolean),
		interior: source.draw(boolean),
		bind: source.draw(boolean),
		head: source.draw(element(["plain", "count", "sum"] as const))
	}),
	rule: (arm) => (r: RuleValue) => {
		const { id, account } = v(Task)
		const { budget } = v(AutomaticTask)
		const { note } = v(TaskNote)
		let rule = r.match(
			Task,
			arm.kind === "free" ? { id, account } : { id, account, kind: arm.kind }
		)
		const needsBudget = arm.budget || arm.head === "sum" || arm.between || arm.compute !== "none"
		if (needsBudget) {
			rule = rule.match(AutomaticTask, { task: id, budget })
		}
		if (arm.note) {
			rule = rule.match(TaskNote, { task: id, note })
		}
		if (arm.interior) {
			const automatic = r.interior((r2: RuleValue) => {
				const { task, budget: b } = v(AutomaticTask)
				return r2.match(AutomaticTask, { task, budget: b }).find({ task, budget: b })
			})
			const { budget: staged } = v(automatic)
			rule = rule.match(automatic, { task: id, budget: staged })
		}
		if (arm.bind) {
			const bound = notesOf.bind({ task: id })
			const { note: imported } = v(bound)
			rule = rule.match(bound, { note: imported })
		}
		if (arm.noNote) {
			rule = rule.where(r.not(TaskNote, { task: id }))
		}
		if (arm.byAccount) {
			rule = rule.where(r.eq(account, r.param("account", Task.fields.account)))
		}
		if (arm.between) {
			rule = rule.where(r.between(budget, budget, budget))
		}
		if (arm.inSet) {
			rule = rule.where(r.inSet(id, ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"]))
		}
		const extra =
			arm.compute === "cast"
				? { x: Compute.cast(Compute.base(budget), pg.numeric) }
				: arm.compute === "cond"
					? {
							x: Compute.cond(
								r.eq(account, r.param("account", Task.fields.account)),
								Compute.base(budget),
								0n
							)
						}
					: arm.compute === "condLiteral"
						? { x: Compute.cond(r.le(budget, 1n), Compute.base(budget), 0n) }
						: arm.compute === "base"
							? { x: Compute.base(budget) }
							: {}
		switch (arm.head) {
			case "plain":
				return rule.find({ id, account, ...extra })
			case "count":
				return rule.find({ account, n: r.count(), ...extra })
			case "sum":
				return rule.find({ account, total: r.sum(budget), ...extra })
		}
	},
	key: "account",
	child: (p: ParentVars) =>
		query(Work).rule((r: RuleValue) => {
			const { id } = v(Task)
			return r.match(Task, { id, account: p["account"] }).find({ id })
		})
}

/** Over the span example's schedule: Allen masks and point membership between two span variables, and the producers. */
interface SpanArm {
	readonly allen: boolean
	readonly pointIn: boolean
	readonly producer: "none" | "intersection" | "difference" | "pack"
}

const spans: Grammar<SpanArm> = {
	schema: Schedule,
	arms: (source) => ({
		allen: source.draw(boolean),
		pointIn: source.draw(boolean),
		producer: source.draw(element(["none", "intersection", "difference", "pack"] as const))
	}),
	rule: (arm) => (r: RuleValue) => {
		const a = v(Booking)
		const b = v(Booking)
		let rule = r.match(Booking, { room: a["room"], during: a["during"] })
		const pair =
			arm.allen || arm.pointIn || arm.producer === "intersection" || arm.producer === "difference"
		if (pair) {
			rule = rule.match(Booking, { room: a["room"], during: b["during"] })
		}
		if (arm.allen) {
			rule = rule.where(r.allen(a["during"], ALLEN.intersects, b["during"]))
		}
		if (arm.pointIn) {
			rule = rule.where(r.pointIn(Compute.lower(b["during"], pg.bigint), a["during"]))
		}
		switch (arm.producer) {
			case "none":
				return rule.find({ room: a["room"], during: a["during"] })
			case "intersection":
				return rule.find({ room: a["room"], overlap: r.intersection(a["during"], b["during"]) })
			case "difference":
				return rule.find({ room: a["room"], rest: r.difference(a["during"], b["during"]) })
			case "pack":
				return rule.find({ room: a["room"], covered: r.pack(a["during"]) })
		}
	},
	key: "room",
	child: (p: ParentVars) =>
		query(Schedule).rule((r: RuleValue) => {
			const { during, guest } = v(Booking)
			return r.match(Booking, { room: p["room"], during, guest }).find({ guest })
		})
}

describe("rebuilding from a Description", () => {
	const automatic = () =>
		query(Work).rule((r: RuleValue) => {
			const { id, account } = v(Task)
			const { budget } = v(AutomaticTask)
			return r
				.match(Task, { id, account, kind: "Automatic" })
				.match(AutomaticTask, { task: id, budget })
				.find({ id, account, budget })
		})

	const noteChild = (t: ParentVars) =>
		query(Work).rule((r: RuleValue) => {
			const { note } = v(TaskNote)
			return r.match(TaskNote, { task: t["id"], note }).find({ note })
		})

	/**
	 * A query with the note attachment, from an attach stage or from an arm's attach, and an operation on it once
	 * rebuilt: the rebuilt query knows its attachment's name as the original did.
	 */
	type Attached = "an attach stage" | "an arm's attach"
	type Operation = "attach the name again" | "attach another name" | "order by the attachment"
	const attachedQuery = (from: Attached): QueryValue =>
		from === "an attach stage"
			? automatic().attach("note", noteChild, "array")
			: query(Work).rule((r: RuleValue) => {
					const { id } = v(Task)
					return r.match(Task, { id }).find({ id }).attach("note", noteChild, "array")
				})
	const operate = (q: QueryValue, operation: Operation) => () => {
		switch (operation) {
			case "attach the name again":
				return q.attach("note", noteChild, "array")
			case "attach another name":
				return q.attach("other", noteChild, "array")
			case "order by the attachment":
				return q.orderBy(["note", "asc"])
		}
	}

	it.effect(
		"keeps the attachment names of a rebuilt query, refusing what the original refuses",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/query/roundtrip-attached",
						generator: (source) =>
							[
								source.draw(element<Attached>(["an attach stage", "an arm's attach"])),
								source.draw(
									element<Operation>([
										"attach the name again",
										"attach another name",
										"order by the attachment"
									])
								)
							] as const,
						literal: Formatter.format,
						limit: 6,
						features: noFeatures,
						caseHang: Duration.minutes(2)
					},
					([from, operation]) =>
						Effect.sync(() => {
							const original = attachedQuery(from)
							const back = rebuiltQuery(descOf(original), Work)
							assert.deepEqual(names(back), names(original))
							/** An attachment's name is a field of the result: attached again or ordered by, it is refused. */
							const refusal: CompileReasonTag = "MalformedDescription"
							const expected = operation === "attach another name" ? "built" : refusal
							const outcome = (f: () => unknown): CompileReasonTag | "built" => {
								const r = catchCompileError(f)
								return r.ok ? "built" : r.error.reason._tag
							}
							assert.equal(outcome(operate(original, operation)), expected, `${from}: ${operation}`)
							assert.equal(
								outcome(operate(back, operation)),
								expected,
								`${from}, rebuilt: ${operation}`
							)
						})
				)
			)
	)

	/** Task's kinds as a recursive row typed by the roster, whose literal handles are checked against the roster. */
	const kinds = () =>
		query(Work).recursive("Kinds", {
			row: { task: Task.fields.id, kind: closedId(Kind) },
			base: [
				(r: RuleValue) => {
					const { id, kind } = v(Task)
					return r.match(Task, { id, kind }).find({ task: id, kind })
				}
			],
			rec: [
				(r: RuleValue, s: object) =>
					r
						.match(s, {})
						.find({ task: r.param("t", Task.fields.id), kind: r.param("k", closedId(Kind)) })
			]
		})
	const matchingKind = (q: unknown, handle: string) => () =>
		query(Work).rule((r: RuleValue) => {
			const { task } = v(q)
			return r.match(q, { task, kind: handle }).find({ task })
		})

	it.effect(
		"types a rebuilt recursive row under the schema's rosters, as the original was typed",
		(ctx) => {
			const original = kinds()
			const back = rebuilt(descOf(original), Work)
			assert.deepEqual(
				queryValueHeading(back)?.fields.get("kind"),
				queryValueHeading(original)?.fields.get("kind")
			)
			type Handle = "a roster handle" | "no handle"
			return searched(
				ctx,
				explore(
					{
						suite: "unit/query/roundtrip-roster",
						draw: drawn(
							oneOf([
								element(["Automatic", "Manual"]),
								string(codePoint(0x20, 0x7e), { min: 0, max: 8 })
							])
						),
						literal: Formatter.format,
						features: features<Handle>(["a roster handle", "no handle"]),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					(handle, c) =>
						Effect.sync(() => {
							/**
							 * A literal against the rebuilt row's handle is checked against the roster, as against the original's.
							 */
							const outcome = (q: unknown) =>
								Result.map(catchCompileError(matchingKind(q, handle)), () => "built")
							const expected = outcome(original)
							assert.deepEqual(
								Result.mapError(outcome(back), (e) => e.reason),
								Result.mapError(expected, (e) => e.reason)
							)
							assert.equal(expected.ok, handle === "Automatic" || handle === "Manual", handle)
							c.note(expected.ok ? "a roster handle" : "no handle")
						})
				)
			)
		}
	)
})

/**
 * Each property builds, encodes, decodes and rebuilds hundreds of queries: several seconds of work, more under load,
 * so each gets a timeout of its own that covers it, and the gate does not depend on machine load.
 */
const generatedTimeout = 60_000

describe("generated queries", () => {
	it.effect(
		"over the worked example's schema decode, are canonical and deterministic, and rebuild to the same query",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/query/roundtrip-58",
						draw: drawn(generated(work)),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					property(work)
				)
			),
		generatedTimeout
	)

	it.effect(
		"over spans decode, are canonical and deterministic, and rebuild to the same query",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/query/roundtrip-109",
						draw: drawn(generated(spans)),
						literal: Formatter.format,
						features: noFeatures,
						kept: [],
						runs: 150,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "none" },
						caseHang: Duration.minutes(2)
					},
					property(spans)
				)
			),
		generatedTimeout
	)
})
