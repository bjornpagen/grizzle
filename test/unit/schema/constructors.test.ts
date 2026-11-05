import { describe, it } from "@effect/vitest"
import { drawn, explore, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, pipe, Record as Rec, String as Str } from "effect"
import { appendAll, maxOf } from "#compiler/core/array.ts"
import { isRecord } from "#compiler/core/record.ts"
import {
	type BoundValueDesc,
	conjunctsOf,
	type ExprDesc,
	everyFact,
	type LiteralDesc,
	type SelectionDesc,
	type SideDesc,
	type StatementDesc,
	type TermDesc
} from "#compiler/ir/desc.ts"
import { natural, uuid } from "#compiler/public/fields.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { untypedTerm } from "#compiler/query/build/terms.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { literalResult } from "#compiler/schema/literal.ts"
import { own } from "#compiler/schema/own.ts"
import {
	admitClosed,
	admitDerived,
	admitRelation,
	closed,
	derived,
	relation,
	relationDescOf
} from "#compiler/schema/relation.ts"
import { admitSchema, schema, schemaDescOf } from "#compiler/schema/schema.ts"
import {
	admitCapacity,
	alternativesBuilder,
	alternativesId,
	capacityBuilder,
	checkBuilder,
	containedBuilder,
	expansionDescOf,
	keyBuilder,
	mirrorsBuilder,
	mutableBuilder,
	onBuilder,
	predBuilder,
	runtimeDuration,
	runtimeRef,
	runtimeWeigh,
	runtimeWithin,
	selectBuilder,
	sideDescOf,
	statementDescOf
} from "#compiler/schema/statements.ts"
import type { RowTerm } from "#compiler/schema/terms.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type { AnyClosed, AnyRelation } from "#compiler/types/schema/relation.ts"
import type { AnySchema } from "#compiler/types/schema/schema.ts"
import type { AnyTerm, Statement } from "#compiler/types/schema/statements.ts"
import {
	assert,
	defined,
	faulted,
	matchesObject,
	nonEmpty,
	succeeded,
	throwsRefused
} from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { argumentsOf } from "#test/support/list.ts"
import { whereIndex } from "#test/support/oracle/pick.ts"
import { pickGen, pickIndex, pickSpan } from "#test/support/pick.ts"
import {
	rawClosedId,
	rawContract,
	descOf,
	patternOnly,
	rawPg,
	rawSpan,
	type Row,
	regex,
	wildcard
} from "#test/unit/schema/support.ts"

import { regex as arkregex } from "arkregex"
/**
 * The relation, closed, derived, schema and statement constructors: each records
 * its Description, refuses a malformed JavaScript argument synchronously with MalformedDescription, and
 * returns a frozen value whose public members are exactly the public API's.
 *
 * Every property draws a well-formed declaration and plants at most one defect a JavaScript caller can write, so the
 * oracle is the constructor's documented rule (packages/engine/src/schema/relation.ts, statements.ts, schema.ts, literal.ts)
 * restated: a planted defect is refused, and a declaration without one records exactly what was written. A defect is
 * refused where the builder admits its arguments, its admission core (admitRelation, admitClosed, ...), which a
 * declaration with no defect reaches through the builder itself.
 */
const Kind = closed("Kind", ["Automatic", "Manual"], [])
const Task = relation("Task", { id: uuid, account: uuid, kind: rawClosedId(Kind) }, ["id"], [])

/**
 * A one-rule definition over `over` finding the ids of `sources`, each a relation or a derived relation matched on its
 * id, built by the query builder's untyped core as a JavaScript caller builds one.
 */
const idsOf = (over: unknown, sources: Arr.NonEmptyReadonlyArray<unknown>) =>
	queryOver(over).rule((r: RuleValue) => {
		const { id } = varsOver(sources[0], "source")
		return Arr.reduce(sources, r, (rule: RuleValue, source) => rule.match(source, { id })).find({
			id
		})
	})

/** A drawn roster, which every draw makes nonempty, as the nonempty list closed(...) takes. */
const rosterOf = (handles: ReadonlyArray<string>): Arr.NonEmptyReadonlyArray<string> => {
	const [first, ...rest] = handles
	if (first === undefined) {
		return assert.fail("a drawn roster of at least one handle")
	}
	return [first, ...rest]
}

const wordGen = matching(arkregex("^[a-z][a-zA-Z0-9]{0,7}$"))

/** A nonempty list: a first element and up to `more` others. */
const nonEmptyGen =
	<A>(item: Gen<A>, more: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => [source.draw(item), ...source.draw(array(item, { min: 0, max: more }))]

/** The first occurrence of each item, in order. */
const distinct = <A>(items: ReadonlyArray<A>): Array<A> => [...new Set(items)]

describe("relation", () => {
	/**
	 * A descriptor no builder made: str.regex's public pattern alone, a plain object, or an object spread of a built one.
	 */
	type LookAlike = "pattern only" | "plain object" | "spread copy"
	const lookAlikeOf = (kind: LookAlike): unknown =>
		kind === "pattern only"
			? patternOnly("^.*$", "su")
			: kind === "plain object"
				? { sql: "uuid" }
				: { ...uuid }
	const builtDescriptors: Arr.NonEmptyReadonlyArray<FieldBase> = [
		uuid,
		rawPg.integer,
		rawPg.bigint,
		regex("^[a-z]{1,8}$", "u")
	]

	type RelationDefect =
		| "none"
		| "an empty name"
		| "no fields"
		| "a look-alike descriptor"
		| "an empty field name"
		| "an empty key"
		| "an undeclared key field"
		| "a repeated key field"
		| "a fourth argument"
	const relationDefects: Arr.NonEmptyReadonlyArray<RelationDefect> = [
		"none",
		"an empty name",
		"no fields",
		"a look-alike descriptor",
		"an empty field name",
		"an empty key",
		"an undeclared key field",
		"a repeated key field",
		"a fourth argument"
	]
	/** The name, field names and primary key an ordinary relation's Description records. */
	const recorded = (value: unknown, label: string) => {
		const desc = relationDescOf(value, label)
		if (desc.kind !== "relation") {
			return assert.fail(`${label} is an ordinary relation`)
		}
		const primaryKey: ReadonlyArray<string> = desc.primaryKey
		return { name: desc.name, fields: Rec.keys(desc.fields), primaryKey }
	}

	/** What a caller does to its own inputs after the relation is built. */
	type Mutation = "add a field" | "extend the key" | "drop a field" | "reverse the key"

	it.effect(
		"requires a nonempty name, built descriptors and a nonempty, distinct primary key over its own fields, and keeps none of the caller's inputs",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/relation-constructor",
						draw: drawn((source) => {
							const name = source.draw(wordGen)
							const fields = source.draw(
								uniqueArray(
									(again) => ({
										name: again.draw(wordGen),
										descriptor: again.draw(element(builtDescriptors))
									}),
									(f) => f.name,
									{ min: 1, max: 4 },
									20
								)
							)
							const names = rosterOf(Arr.map(fields, (f) => f.name))
							return {
								name,
								fields,
								key: source.draw(nonEmptyGen(element(names), 2)),
								defect: source.draw(element(Arr.append(relationDefects, "none" as const))),
								lookAlike: source.draw(
									element<LookAlike>(["pattern only", "plain object", "spread copy"])
								),
								mutation: source.draw(
									element<Mutation>([
										"add a field",
										"extend the key",
										"drop a field",
										"reverse the key"
									])
								)
							}
						}),
						literal: Formatter.format,
						coverage: required<RelationDefect | Mutation>(
							[...relationDefects, "add a field", "drop a field"],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							c.note(s.defect)
							const names = Arr.map(s.fields, (f) => f.name)
							const key = distinct(s.key)
							const descriptors: Record<string, FieldBase> = Rec.fromEntries(
								Arr.map(s.fields, (f) => [f.name, f.descriptor])
							)
							/** The fields a JavaScript caller hands in, a planted defect among them. */
							const fields: Record<string, unknown> = { ...descriptors }
							const name = s.defect === "an empty name" ? "" : s.name
							if (s.defect === "no fields") {
								for (const f of names) {
									delete fields[f]
								}
							}
							if (s.defect === "a look-alike descriptor") {
								fields[defined(names[0])] = lookAlikeOf(s.lookAlike)
							}
							if (s.defect === "an empty field name") {
								fields[""] = uuid
							}
							const primaryKey: Array<string> =
								s.defect === "an empty key"
									? []
									: s.defect === "an undeclared key field"
										? [...key, "no such field"]
										: s.defect === "a repeated key field"
											? [...key, defined(key[0])]
											: [...key]
							const lookAlike = { kind: "relation", name, fields, primaryKey }
							if (s.defect !== "none") {
								throwsRefused(
									() =>
										admitRelation(
											name,
											fields,
											primaryKey,
											s.defect === "a fourth argument" ? [{}] : []
										),
									"MalformedDescription"
								)
								if (s.defect !== "a fourth argument") {
									throwsRefused(
										() => relationDescOf(lookAlike, "look-alike"),
										"MalformedDescription"
									)
								}
								return
							}
							const R = relation(name, descriptors, primaryKey, [])
							const desc = relationDescOf(R, "test")
							assert.deepEqual(recorded(R, "test"), { name, fields: names, primaryKey: key })
							assert.deepEqual(recorded(lookAlike, "look-alike"), {
								name,
								fields: names,
								primaryKey: key
							})
							c.note(s.mutation)
							switch (s.mutation) {
								case "add a field":
									descriptors["added"] = uuid
									break
								case "extend the key":
									primaryKey.push("added")
									break
								case "drop a field":
									delete descriptors[defined(names[0])]
									break
								case "reverse the key":
									primaryKey.reverse()
									break
							}
							assert.deepEqual(Rec.keys(R.fields), names)
							assert.deepEqual(R.primaryKey, key)
							assert.deepEqual(relationDescOf(R, "test"), desc)
						})
				)
			)
	)
})

/** A payload field of a closed relation as drawn: its type, and a value of each fact a builder admits for it. */
type PayloadType = "bigint" | "cents" | "rate" | "money" | "ratio" | "flag"

const Cents = rawContract("Cents", rawPg.bigint, {
	kind: "compare",
	op: "ge",
	left: { kind: "value" },
	right: { kind: "literal", value: 0n, type: undefined }
})

const payloadDescriptor = (type: PayloadType): FieldBase => {
	switch (type) {
		case "bigint":
			return rawPg.bigint
		case "cents":
			return Cents
		case "rate":
			return rawPg.numericOf(7, 6)
		case "money":
			return rawPg.money
		case "ratio":
			return rawPg.real
		case "flag":
			return rawPg.boolean
	}
}

/**
 * A value of each payload type: a contract's literal is its base's, whether or not it satisfies the predicate (that is
 * the checker's judgment at compilation).
 */
const payloadValueGen = (type: PayloadType): Gen<unknown> => {
	switch (type) {
		case "bigint":
		case "cents":
			return bigint(-1_000_000n, 1_000_000n)
		case "rate":
			return map(
				(source) => ({
					integer: source.draw(int(0, 8)),
					fraction: source.draw(matching(arkregex("^[0-9]{0,8}$")))
				}),
				({ integer, fraction }) => (fraction === "" ? `${integer}` : `${integer}.${fraction}`)
			)
		case "money":
			return map(bigint(-1_000_000n, 1_000_000n), (cents) => Money.of(cents))
		case "ratio":
			return map(int(-1_000_000, 1_000_000), (n) => n / 64)
		case "flag":
			return boolean
	}
}

/** A value of the wrong host kind for each payload type: a JavaScript number is never a numeric or bigint literal. */
const mistypedValue = (type: PayloadType): unknown => {
	switch (type) {
		case "bigint":
		case "cents":
		case "rate":
			return 1
		case "money":
			return 1n
		case "ratio":
			return "1"
		case "flag":
			return 1
	}
}

describe("closed", () => {
	type ClosedDefect =
		| "none"
		| "a missing fact"
		| "an extra field in a fact"
		| "a missing field in a fact"
		| "a fact off the roster"
		| "a mistyped value"
		| "a repeated handle"
		| "an empty roster"
		| "a payload field named id"
		| "a payload as a third argument"
	const closedDefects: Arr.NonEmptyReadonlyArray<ClosedDefect> = [
		"none",
		"a missing fact",
		"an extra field in a fact",
		"a missing field in a fact",
		"a fact off the roster",
		"a mistyped value",
		"a repeated handle",
		"an empty roster",
		"a payload field named id",
		"a payload as a third argument"
	]
	type ClosedFeature = ClosedDefect | "no payload" | "payload"

	const payloadFieldGen: Gen<{
		readonly name: string
		readonly type: PayloadType
		readonly values: ReadonlyArray<unknown>
	}> = (source) => {
		const name = source.draw(filter(wordGen, (w) => w !== "id", 100))
		const type = source.draw(
			element<PayloadType>(["bigint", "cents", "rate", "money", "ratio", "flag"])
		)
		return { name, type, values: source.draw(array(payloadValueGen(type), { min: 4, max: 4 })) }
	}

	it.effect(
		"records a roster in declared order and one fact per handle against its payload, types each handle, and refuses every other roster, facts or handle",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/closed-constructor",
						draw: drawn((source) => {
							const name = source.draw(wordGen)
							const handles = rosterOf(
								source.draw(
									uniqueArray(
										matching(arkregex("^[A-Z][a-z]{0,6}$")),
										(item) => item,
										{ min: 1, max: 4 },
										20
									)
								)
							)
							return {
								name,
								handles,
								payload: source.draw(
									uniqueArray(payloadFieldGen, (f) => f.name, { min: 0, max: 3 }, 20)
								),
								defect: source.draw(element(Arr.append(closedDefects, "none" as const))),
								target: source.draw(element(handles))
							}
						}),
						literal: Formatter.format,
						coverage: required<ClosedFeature>([...closedDefects, "no payload", "payload"], {
							cases: 300,
							sense: notesOnly
						}),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const { handles, target } = s
							/** A defect that needs a payload field plants one where the drawn payload has none. */
							const needsField =
								s.defect === "a missing field in a fact" || s.defect === "a mistyped value"
							const drawnPayload: ReadonlyArray<{
								readonly name: string
								readonly type: PayloadType
								readonly values: ReadonlyArray<unknown>
							}> =
								needsField && s.payload.length === 0
									? [{ name: "planted", type: "flag" as const, values: [true, false, true, false] }]
									: s.payload
							const payload: Record<string, FieldBase> = Rec.fromEntries(
								Arr.map(drawnPayload, (f) => [f.name, payloadDescriptor(f.type)])
							)
							const facts: Record<string, Record<string, unknown>> = Rec.fromEntries(
								Arr.map(handles, (h, i) => [
									h,
									Rec.fromEntries(Arr.map(drawnPayload, (f) => [f.name, f.values[i]]))
								])
							)
							const [first] = drawnPayload
							c.note(s.defect)
							switch (s.defect) {
								case "none":
									c.note(drawnPayload.length === 0 ? "no payload" : "payload")
									break
								case "a missing fact":
									delete facts[target]
									break
								case "an extra field in a fact":
									defined(facts[target])["extra"] = true
									break
								case "a missing field in a fact":
									delete defined(facts[target])[defined(first).name]
									break
								case "a fact off the roster":
									facts[`${target}Other`] = defined(facts[target])
									break
								case "a mistyped value":
									defined(facts[target])[defined(first).name] = mistypedValue(defined(first).type)
									break
								case "a payload field named id":
									payload["id"] = rawPg.bigint
									for (const h of handles) {
										defined(facts[h])["id"] = 1n
									}
									break
								case "a repeated handle":
								case "an empty roster":
								case "a payload as a third argument":
									break
							}
							if (s.defect !== "none") {
								const roster =
									s.defect === "a repeated handle"
										? [...handles, target]
										: s.defect === "an empty roster"
											? []
											: handles
								throwsRefused(
									() =>
										s.defect === "a payload as a third argument"
											? admitClosed(s.name, roster, undefined, [payload])
											: admitClosed(s.name, roster, { payload, facts }, []),
									"MalformedDescription"
								)
								return
							}
							const K =
								drawnPayload.length === 0
									? closed(s.name, handles, [])
									: closed(s.name, handles, []).with(payload, facts)
							const rosterHandles: ReadonlyArray<string> = K.handles
							assert.deepEqual(rosterHandles, handles)
							assert.deepEqual(K.facts, facts)
							const desc = relationDescOf(K, "test")
							if (desc.kind !== "closed") {
								return assert.fail("a closed relation's Description")
							}
							assert.deepEqual(desc.handles, handles)
							const keptPayload = K.payload
							assert.ok(
								isRecord(keptPayload),
								"a closed relation's payload is a record of its descriptors"
							)
							for (const f of drawnPayload) {
								assert.equal(keptPayload[f.name], payload[f.name])
								const fieldDesc = descOf(payloadDescriptor(f.type))
								assert.deepEqual(desc.payload[f.name], fieldDesc)
								for (const [i, h] of handles.entries()) {
									assert.deepEqual(
										desc.facts[h]?.[f.name],
										succeeded(literalResult(fieldDesc, f.values[i], undefined))
									)
								}
							}
							/**
							 * Either form's handle(h) is h's literal at the roster's enum, the one typed constant of a member: its
							 * column delivers exactly h. A member off the roster is refused, and so is Compute.literal over the
							 * roster's descriptor, the JavaScript caller's path the types cannot refuse.
							 */
							const rosterId = rawClosedId(K)
							for (const h of handles) {
								const term = K.handle(h)
								assert.deepEqual(term.expr, { kind: "literal", value: h, type: descOf(rosterId) })
								assert.equal(term.sql, "enum")
								assert.deepEqual(
									term.column.kind === "handle" ? term.column.handles : [],
									[h],
									"a handle's column delivers exactly its member"
								)
								throwsRefused(() => computeCore.literal(rosterId, h), "MalformedDescription")
							}
							throwsRefused(() => K.handle(`${target}Other`), "MalformedDescription")
							if (drawnPayload.length === 0) {
								const withEmpty = relationDescOf(
									closed(s.name, handles, []).with(
										{},
										Rec.fromEntries(Arr.map(handles, (h) => [h, {}]))
									),
									"test"
								)
								assert.deepEqual({ ...withEmpty, loc: desc.loc }, desc)
							}
						})
				)
			)
	)
})

/** A host value a caller writes against a real, double precision or numeric(p, s) field. */
type HostValue =
	| { readonly kind: "number"; readonly value: number }
	| {
			readonly kind: "decimal"
			readonly negative: boolean
			readonly integer: string
			readonly fraction: string
	  }
	| { readonly kind: "special"; readonly text: "Infinity" | "-Infinity" | "NaN" }
	| { readonly kind: "bigint"; readonly value: bigint }

const hostValue = (v: HostValue): unknown => {
	switch (v.kind) {
		case "number":
		case "bigint":
			return v.value
		case "decimal":
			return `${v.negative ? "-" : ""}${v.integer}${v.fraction === "" ? "" : `.${v.fraction}`}`
		case "special":
			return v.text
	}
}

type LiteralField =
	| { readonly kind: "real" }
	| { readonly kind: "double precision" }
	| { readonly kind: "numeric(p, s)"; readonly precision: number; readonly scale: number }

/** What the literal rule makes of a value: the float literal, the numeric's text, or the fault. */
type Expected =
	| { readonly kind: "float"; readonly literal: LiteralDesc }
	| { readonly kind: "numeric"; readonly text: string }
	| {
			readonly kind: "fault"
			readonly fault:
				| "floatType"
				| "realOverflow"
				| "realUnderflow"
				| "numericOverflow"
				| "numericInfinity"
				| "decimalNumber"
	  }

type LiteralOutcome =
	| "rounded"
	| "kept"
	| "special"
	| "overflow"
	| "underflow"
	| "infinity"
	| "wrong host kind"

/**
 * The literal rule restated (literal.ts): a float field takes a JavaScript number, its special values wrapped; a real
 * is its binary32 rounding (Math.fround), refused when a finite value rounds to an infinity (overflow) or a nonzero
 * value to zero (underflow), and -0 is +0 in either. A numeric field never takes a JavaScript number; numeric(p, s)
 * rounds a decimal to s fractional digits, half away from zero, refuses one that then needs more than p digits and
 * refuses an infinity. Zero has no sign.
 */
const expectedLiteral = (
	field: LiteralField,
	v: HostValue
): { readonly expected: Expected; readonly outcome: LiteralOutcome } => {
	if (field.kind === "real" || field.kind === "double precision") {
		if (v.kind !== "number") {
			return { expected: { kind: "fault", fault: "floatType" }, outcome: "wrong host kind" }
		}
		const x = v.value
		if (Number.isNaN(x)) {
			return { expected: { kind: "float", literal: { float: "NaN" } }, outcome: "special" }
		}
		if (x === Number.POSITIVE_INFINITY) {
			return { expected: { kind: "float", literal: { float: "Infinity" } }, outcome: "special" }
		}
		if (x === Number.NEGATIVE_INFINITY) {
			return { expected: { kind: "float", literal: { float: "-Infinity" } }, outcome: "special" }
		}
		if (field.kind === "double precision") {
			return { expected: { kind: "float", literal: x === 0 ? 0 : x }, outcome: "kept" }
		}
		const f = Math.fround(x)
		if (!Number.isFinite(f)) {
			return { expected: { kind: "fault", fault: "realOverflow" }, outcome: "overflow" }
		}
		if (f === 0 && x !== 0) {
			return { expected: { kind: "fault", fault: "realUnderflow" }, outcome: "underflow" }
		}
		return {
			expected: { kind: "float", literal: f === 0 ? 0 : f },
			outcome: f === x ? "kept" : "rounded"
		}
	}
	switch (v.kind) {
		case "number":
			return { expected: { kind: "fault", fault: "decimalNumber" }, outcome: "wrong host kind" }
		case "special":
			if (v.text !== "NaN") {
				return { expected: { kind: "fault", fault: "numericInfinity" }, outcome: "infinity" }
			}
			return { expected: { kind: "numeric", text: v.text }, outcome: "special" }
		case "bigint":
		case "decimal": {
			const negative = v.kind === "bigint" ? v.value < 0n : v.negative
			const integer = v.kind === "bigint" ? (negative ? -v.value : v.value).toString() : v.integer
			const fraction = v.kind === "bigint" ? "" : v.fraction
			const digits = BigInt(`${integer}${fraction}`)
			/** The value's one text, units · 10^-scale with every trailing fractional zero dropped and no -0. */
			const oneText = (magnitude: bigint, at: number): string => {
				let units = magnitude
				let scale = at
				while (scale > 0 && units % 10n === 0n) {
					units /= 10n
					scale--
				}
				const padded = pipe(units.toString(), Str.padStart(scale + 1, "0"))
				const text =
					scale === 0 ? padded : `${Str.slice(0, -scale)(padded)}.${Str.slice(-scale)(padded)}`
				return negative && units > 0n ? `-${text}` : text
			}
			const { precision, scale } = field
			const units =
				fraction.length <= scale
					? digits * 10n ** BigInt(scale - fraction.length)
					: roundedHalfUp(digits, 10n ** BigInt(fraction.length - scale))
			if (units >= 10n ** BigInt(precision)) {
				return { expected: { kind: "fault", fault: "numericOverflow" }, outcome: "overflow" }
			}
			return {
				expected: { kind: "numeric", text: oneText(units, scale) },
				outcome: fraction.length > scale ? "rounded" : "kept"
			}
		}
	}
}

/** `digits` divided by `drop`, a power of ten, rounded half away from zero as numeric rounds a magnitude. */
const roundedHalfUp = (digits: bigint, drop: bigint): bigint =>
	digits / drop + ((digits % drop) * 2n >= drop ? 1n : 0n)

const literalFieldDescriptor = (field: LiteralField): FieldBase => {
	switch (field.kind) {
		case "real":
			return rawPg.real
		case "double precision":
			return rawPg.doublePrecision
		case "numeric(p, s)":
			return rawPg.numericOf(field.precision, field.scale)
	}
}

/** The literal's value as the rule states it: a float literal itself, a numeric by its text. */
const agrees = (literal: LiteralDesc, expected: Expected): void => {
	if (expected.kind === "float") {
		assert.deepEqual(literal, expected.literal)
	} else if (expected.kind === "numeric") {
		assert.ok(literal instanceof Decimal, "a numeric literal is a Decimal")
		assert.equal(literal.toString(), expected.text)
	} else {
		assert.fail(`the fault ${expected.fault}`)
	}
}

describe("literals take their field's value", () => {
	/**
	 * Doubles of every magnitude, with binary32's edges planted: its largest finite value, the first double that rounds
	 * past it, its smallest subnormal and the doubles on either side of half of it.
	 */
	const floatGen: Gen<HostValue> = weighted([
		[
			3,
			map(double(-Number.MAX_VALUE, Number.MAX_VALUE), (value): HostValue => ({
				kind: "number",
				value
			}))
		],
		[
			2,
			map(
				element([
					Number.NaN,
					Number.POSITIVE_INFINITY,
					Number.NEGATIVE_INFINITY,
					-0,
					0.1,
					1e300,
					-1e300,
					1e-50,
					3.4028234663852886e38,
					3.4028235677973366e38,
					3.402823669209385e38,
					1.401298464324817e-45,
					7.006492321624085e-46,
					7.006492321624087e-46
				]),
				(value): HostValue => ({ kind: "number", value })
			)
		],
		[1, map(bigint(-10n, 10n), (value): HostValue => ({ kind: "bigint", value }))]
	])

	/**
	 * Decimals with up to a few digits beyond the field's precision and scale, exact halves planted, the specials and a
	 * JavaScript number.
	 */
	const numericGen = (precision: number, scale: number): Gen<HostValue> =>
		weighted([
			[
				4,
				map(
					(source) => ({
						negative: source.draw(boolean),
						integer: source.draw((source) => {
							const n = source.draw(int(0, precision - scale + 1))
							return source.draw(
								n === 0 ? constant("0") : matching(arkregex.as(`^[1-9][0-9]{${n - 1}}$`))
							)
						}),
						fraction: source.draw(matching(arkregex.as(`^[0-9]{0,${scale + 3}}$`)))
					}),
					(d): HostValue => ({ kind: "decimal", ...d })
				)
			],
			[
				2,
				map(
					(source) => ({
						negative: source.draw(boolean),
						integer: source.draw(element(["0", Str.repeat(Math.max(1, precision - scale))("9")])),
						kept: source.draw(matching(arkregex.as(`^[0-9]{${scale}}$`)))
					}),
					({ negative, integer, kept }): HostValue => ({
						kind: "decimal",
						negative,
						integer,
						fraction: `${kept}5`
					})
				)
			],
			[
				1,
				map(
					element<"Infinity" | "-Infinity" | "NaN">(["Infinity", "-Infinity", "NaN"]),
					(text): HostValue => ({ kind: "special", text })
				)
			],
			[1, map(bigint(-100n, 100n), (value): HostValue => ({ kind: "bigint", value }))],
			[
				1,
				map(
					weighted([
						[9, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
						[1, element([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
					]),
					(value): HostValue => ({ kind: "number", value })
				)
			]
		])

	const caseGen = oneOf<{ readonly field: LiteralField; readonly value: HostValue }>([
		(source) => ({ field: { kind: "real" }, value: source.draw(floatGen) }),
		(source) => ({ field: { kind: "double precision" }, value: source.draw(floatGen) }),
		(source) => {
			const precision = source.draw(int(1, 12))
			const scale = Math.min(source.draw(int(0, 12)), precision)
			return {
				field: { kind: "numeric(p, s)", precision, scale },
				value: source.draw(numericGen(precision, scale))
			}
		}
	])

	type Site = "closed fact" | "selection" | "check operand"
	type LiteralFeature = `${LiteralField["kind"]}: ${LiteralOutcome}` | Site

	it.effect(
		"rounds a real to binary32 and a numeric(p, s) to its scale, half away from zero, refusing what the column refuses, at every construction site",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/literal-rule",
						/**
						 * Planted: a special value of each float field and an infinite and a NaN numeric(p, s), which the drawn
						 * values reach a few times a run.
						 */
						draw: sketched(
							(source) => ({
								case: source.draw(caseGen),
								site: source.draw(element<Site>(["closed fact", "selection", "check operand"]))
							}),
							(c) => c
						),
						literal: Formatter.format,
						coverage: required<LiteralFeature>(
							[
								"real: rounded",
								"real: special",
								"real: overflow",
								"real: underflow",
								"real: wrong host kind",
								"double precision: kept",
								"double precision: special",
								"numeric(p, s): rounded",
								"numeric(p, s): kept",
								"numeric(p, s): overflow",
								"numeric(p, s): infinity",
								"numeric(p, s): wrong host kind",
								"numeric(p, s): special",
								"closed fact",
								"selection",
								"check operand"
							],
							{ cases: 600, sense: notesOnly }
						),
						kept: [
							{
								note: "NaN for a real",
								sketch: {
									case: { field: { kind: "real" }, value: { kind: "number", value: Number.NaN } },
									site: "closed fact"
								},
								draws: "",
								reaches: ["real: special"]
							},
							{
								note: "Infinity for a double precision",
								sketch: {
									case: {
										field: { kind: "double precision" },
										value: { kind: "number", value: Number.POSITIVE_INFINITY }
									},
									site: "selection"
								},
								draws: "",
								reaches: ["double precision: special"]
							},
							{
								note: "Infinity for a numeric(6, 2)",
								sketch: {
									case: {
										field: { kind: "numeric(p, s)", precision: 6, scale: 2 },
										value: { kind: "special", text: "Infinity" }
									},
									site: "check operand"
								},
								draws: "",
								reaches: ["numeric(p, s): infinity"]
							},
							{
								note: "NaN for a numeric(6, 2)",
								sketch: {
									case: {
										field: { kind: "numeric(p, s)", precision: 6, scale: 2 },
										value: { kind: "special", text: "NaN" }
									},
									site: "selection"
								},
								draws: "",
								reaches: ["numeric(p, s): special"]
							}
						],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ case: { field, value }, site }, c) =>
						Effect.sync(() => {
							const { expected, outcome } = expectedLiteral(field, value)
							c.note(`${field.kind}: ${outcome}`)
							c.note(site)
							const descriptor = literalFieldDescriptor(field)
							const host = hostValue(value)
							const result = literalResult(descOf(descriptor), host, undefined)
							if (expected.kind === "fault") {
								faulted(result, expected.fault)
							} else {
								agrees(succeeded(result), expected)
							}
							const Rated = relation("Rated", { id: uuid, value: descriptor }, ["id"], [])
							const recorded = (): LiteralDesc => {
								switch (site) {
									case "closed fact": {
										const desc = relationDescOf(
											closed("P", ["H"], []).with({ value: descriptor }, { H: { value: host } }),
											"test"
										)
										if (desc.kind !== "closed") {
											return assert.fail("a closed relation's Description")
										}
										return defined(desc.facts["H"]?.["value"])
									}
									case "selection": {
										const side = sideDescOf(
											onBuilder(
												selectBuilder(Rated, (r: { readonly value: RowTerm }) => r.value.eq(host)),
												["id"]
											)
										)
										const [predicate, ...more] = defined(side).selection.conjuncts
										if (
											more.length > 0 ||
											predicate?.kind !== "compare" ||
											predicate.right.kind !== "literal"
										) {
											return assert.fail("a selection comparing the field with a literal")
										}
										return predicate.right.value
									}
									case "check operand": {
										const desc = statementDescOf(
											checkBuilder("Bounded", Rated, (r: { readonly value: RowTerm }) =>
												r.value.le(host)
											)
										)
										if (
											desc?.kind !== "check" ||
											desc.predicate.kind !== "compare" ||
											desc.predicate.right.kind !== "literal"
										) {
											return assert.fail("a check comparing the field with a literal")
										}
										return desc.predicate.right.value
									}
								}
							}
							if (expected.kind === "fault") {
								throwsRefused(recorded, "MalformedDescription")
							} else {
								agrees(recorded(), expected)
							}
						})
				)
			)
	)
})

/** A side's terms when each is a field, as on(...) records them. */
const fieldTerms = (fields: ReadonlyArray<string>): ReadonlyArray<TermDesc> =>
	Arr.map(fields, (field): TermDesc => ({ kind: "field", field }))

describe("statements", () => {
	/**
	 * Where a side's terms or a selection is written, and the defects a JavaScript caller can plant there: on's terms,
	 * over a relation or a selection, are a nonempty list of distinct terms, each a field of the heading or pred of a
	 * natural one; key takes a side built by on and nothing else; select takes a callback over the row that returns a
	 * predicate of its own fields, and nothing else.
	 */
	type TermsDefect =
		| "none"
		| "an empty list"
		| "an undeclared field"
		| "a repeated term"
		| "pred of a field that is not natural"
	type KeyDefect = "none" | "no side"
	type SelectDefect = "no callback" | "an undeclared field" | "no predicate"
	type FieldListCase =
		| { readonly site: "key"; readonly defect: KeyDefect }
		| { readonly site: "on" | "on a selection"; readonly defect: TermsDefect }
		| { readonly site: "pred"; readonly defect: "none" }
		| { readonly site: "select"; readonly defect: SelectDefect }
	const termsDefects: Arr.NonEmptyReadonlyArray<TermsDefect> = [
		"none",
		"an empty list",
		"an undeclared field",
		"a repeated term",
		"pred of a field that is not natural"
	]
	const fieldListCases: Arr.NonEmptyReadonlyArray<FieldListCase> = [
		{ site: "key", defect: "none" },
		{ site: "key", defect: "no side" },
		...Arr.map(termsDefects, (defect): FieldListCase => ({ site: "on", defect })),
		...Arr.map(termsDefects, (defect): FieldListCase => ({ site: "on a selection", defect })),
		{ site: "pred", defect: "none" },
		{ site: "select", defect: "no callback" },
		{ site: "select", defect: "an undeclared field" },
		{ site: "select", defect: "no predicate" }
	]
	type FieldListFeature = `${FieldListCase["site"]}: ${FieldListCase["defect"]}`
	const featureOf = (k: FieldListCase): FieldListFeature => `${k.site}: ${k.defect}`
	const taskFields: Arr.NonEmptyReadonlyArray<string> = ["id", "account", "kind"]
	/** A relation with a count, the one type a pred term reads. */
	const Counted = relation("Counted", { id: uuid, n: natural }, ["id"], [])
	/** Task's facts of one kind, as a JavaScript caller writes the callback. */
	const ofKind = (handle: string) => (r: Row & { readonly kind: Row["id"] }) => r.kind.eq(handle)
	/** The predicate a check records for `callback` over Task: what a selection over the same callback records. */
	const predicateOf = (callback: unknown) => {
		const desc = statementDescOf(checkBuilder("Selected", Task, callback))
		return desc?.kind === "check" ? desc.predicate : assert.fail("a check statement")
	}

	it.effect(
		"on names a nonempty list of distinct terms of the heading in the order written, key a side, and select a predicate",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/field-lists",
						/** Planted: every site with every defect, each pair drawn about a sixteenth of the time. */
						draw: sketched(
							(source) => ({
								fields: source.draw(
									shuffled([...taskFields], { min: 1, max: [...taskFields].length })
								),
								planted: source.draw(element(fieldListCases)),
								handle: source.draw(element(["Automatic", "Manual"]))
							}),
							(c) => c
						),
						literal: Formatter.format,
						coverage: required<FieldListFeature>(Arr.map(fieldListCases, featureOf), {
							cases: 200,
							sense: notesOnly
						}),
						kept: Arr.map(fieldListCases, (planted) => ({
							note: featureOf(planted),
							sketch: { fields: ["id", "account"], planted, handle: "Automatic" as const },
							draws: "",
							reaches: [featureOf(planted)] as const
						})),
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							const planted = s.planted
							c.note(featureOf(planted))
							const selection = selectBuilder(Task, ofKind(s.handle))
							const selected: SelectionDesc = {
								conjuncts: conjunctsOf(predicateOf(ofKind(s.handle)))
							}
							switch (planted.site) {
								case "key": {
									if (planted.defect === "no side") {
										return void throwsRefused(() => keyBuilder(Task), "MalformedDescription")
									}
									const side = onBuilder(Task, s.fields)
									const k = keyBuilder(side)
									matchesObject(k, { kind: "key", side })
									const desc = statementDescOf(k)
									if (desc?.kind !== "key") {
										return assert.fail("a key statement")
									}
									return assert.deepEqual<SideDesc>(desc.side, {
										relation: "Task",
										terms: nonEmpty(fieldTerms(s.fields)),
										selection: everyFact
									})
								}
								case "on":
								case "on a selection": {
									const source = planted.site === "on" ? Task : selection
									const terms: ReadonlyArray<AnyTerm> =
										planted.defect === "an empty list"
											? []
											: planted.defect === "an undeclared field"
												? [...s.fields, "nope"]
												: planted.defect === "a repeated term"
													? [...s.fields, defined(s.fields[0])]
													: planted.defect === "pred of a field that is not natural"
														? [...s.fields, predBuilder("account")]
														: s.fields
									if (planted.defect !== "none") {
										return void throwsRefused(
											() => onBuilder(source, terms),
											"MalformedDescription"
										)
									}
									return assert.deepEqual<SideDesc | undefined>(
										sideDescOf(onBuilder(source, terms)),
										{
											relation: "Task",
											terms: nonEmpty(fieldTerms(s.fields)),
											selection: planted.site === "on" ? everyFact : selected
										}
									)
								}
								case "pred":
									return assert.deepEqual<SideDesc | undefined>(
										sideDescOf(onBuilder(Counted, [predBuilder("n"), "id"])),
										{
											relation: "Counted",
											terms: [
												{ kind: "pred", field: "n" },
												{ kind: "field", field: "id" }
											],
											selection: everyFact
										}
									)
								case "select":
									return void throwsRefused(
										() =>
											selectBuilder(
												Task,
												planted.defect === "no callback"
													? { kind: s.handle }
													: planted.defect === "an undeclared field"
														? (r: Row & { readonly nope: Row["id"] }) => r.eq(r.nope, s.handle)
														: () => true
											),
										"MalformedDescription"
									)
							}
						})
				)
			)
	)

	type SideStatement = "contained" | "mirrors" | "capacity"
	const Triple = relation("Triple", { a: uuid, b: uuid, c: uuid }, ["a", "b", "c"], [])
	const tripleFields: Arr.NonEmptyReadonlyArray<string> = ["a", "b", "c"]

	it.effect("contained, mirrors and capacity relate two sides built by on, of one width", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/schema/law-sides",
					draw: drawn((source) => ({
						statement: source.draw(element<SideStatement>(["contained", "mirrors", "capacity"])),
						left: source.draw(int(1, 3)),
						right: source.draw(int(1, 3)),
						bare: source.draw(element<"none" | "left" | "right">(["none", "none", "left", "right"]))
					})),
					literal: Formatter.format,
					coverage:
						required<`${SideStatement}: ${"related" | "widths differ" | "a bare relation"}`>(
							Arr.flatMap(["contained", "mirrors", "capacity"] as const, (st) =>
								Arr.map(
									["related", "widths differ", "a bare relation"] as const,
									(o) => `${st}: ${o}` as const
								)
							),
							{ cases: 200, sense: notesOnly }
						),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(s, c) =>
					Effect.sync(() => {
						const left = onBuilder(Task, taskFields.slice(0, s.left))
						const right = onBuilder(Triple, tripleFields.slice(0, s.right))
						const l = s.bare === "left" ? Task : left
						const r = s.bare === "right" ? Triple : right
						const build = () =>
							s.statement === "contained"
								? containedBuilder(l, r)
								: s.statement === "mirrors"
									? mirrorsBuilder(l, r)
									: capacityBuilder(l, { from: r, within: runtimeWithin(0n, "*") })
						const related = s.bare === "none" && s.left === s.right
						c.note(
							`${s.statement}: ${related ? "related" : s.bare === "none" ? "widths differ" : "a bare relation"}`
						)
						if (!related) {
							return void throwsRefused(build, "MalformedDescription")
						}
						const built = build()
						const [l0, r0] = [defined(sideDescOf(left)), defined(sideDescOf(right))]
						/** mirrors is sugar: no statement of its own, the expansion of its two containments. */
						const stated = (st: StatementDesc | undefined) =>
							st?.kind === "contained"
								? [st.left, st.right]
								: st?.kind === "capacity"
									? [st.target, st.from]
									: assert.fail(`a ${s.statement} statement`)
						if (s.statement === "mirrors") {
							assert.equal(statementDescOf(built), undefined, "mirrors states no statement itself")
							return assert.deepEqual(Arr.map(defined(expansionDescOf(built)).statements, stated), [
								[l0, r0],
								[r0, l0]
							])
						}
						const desc = statementDescOf(built)
						assert.equal(desc?.kind, s.statement)
						assert.deepEqual(stated(desc), [l0, r0])
					})
			)
		)
	)

	/**
	 * A bound as a caller writes it: a nonnegative or negative bigint, ref(field), "*" (high only), a JavaScript number,
	 * or nothing (within(n)).
	 */
	type BoundArg =
		| { readonly kind: "bigint"; readonly value: bigint }
		| { readonly kind: "ref" }
		| { readonly kind: "unbounded" }
		| { readonly kind: "number" }
		| { readonly kind: "omitted" }
	type WeightArg =
		| "none"
		| "a field"
		| "a duration"
		| "a weight weigh did not build"
		| "an unknown rule member"
	const boundGen = (high: boolean): Gen<BoundArg> =>
		weighted([
			[4, map(bigint(-2n, 6n), (value): BoundArg => ({ kind: "bigint", value }))],
			[1, constant<BoundArg>({ kind: "ref" })],
			[1, constant<BoundArg>({ kind: high ? "unbounded" : "number" })],
			[1, constant<BoundArg>({ kind: high ? "omitted" : "number" })]
		])
	const boundValue = (b: BoundArg): unknown =>
		b.kind === "bigint"
			? b.value
			: b.kind === "ref"
				? runtimeRef("budget")
				: b.kind === "unbounded"
					? "*"
					: 1
	/** The bound a drawn argument records, or its refusal by within. */
	type Admitted<V> = { readonly kind: "admitted"; readonly bound: V } | { readonly kind: "refused" }
	const lowDesc = (b: BoundArg): Admitted<BoundValueDesc> =>
		b.kind === "bigint" && b.value >= 0n
			? { kind: "admitted", bound: b.value }
			: b.kind === "ref"
				? { kind: "admitted", bound: { ref: "budget" } }
				: { kind: "refused" }
	const highDesc = (b: BoundArg, low: Admitted<BoundValueDesc>): Admitted<BoundValueDesc | "*"> =>
		b.kind === "omitted"
			? low
			: b.kind === "unbounded"
				? { kind: "admitted", bound: "*" }
				: lowDesc(b)

	const Pool = relation("Pool", { id: uuid, budget: rawPg.bigint }, ["id"], [])
	const Claim = relation(
		"Claim",
		{ id: uuid, pool: uuid, units: rawPg.bigint, during: rawSpan(rawPg.bigint) },
		["id"],
		[]
	)

	it.effect(
		"within takes nonnegative bigint or ref bounds, low not above high, and capacity records its sides, weight and bound",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/capacity-bounds",
						draw: drawn((source) => ({
							low: source.draw(boundGen(false)),
							high: source.draw(boundGen(true)),
							third: source.draw(element([false, false, false, true])),
							weight: source.draw(
								element<WeightArg>([
									"none",
									"a field",
									"a duration",
									"a weight weigh did not build",
									"an unknown rule member"
								])
							)
						})),
						literal: Formatter.format,
						coverage: required<
							"bounded" | "exact" | "no upper bound" | "refused bound" | "refused rule" | WeightArg
						>(
							[
								"bounded",
								"exact",
								"no upper bound",
								"refused bound",
								"refused rule",
								"a field",
								"a duration"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							/** A third argument follows a high bound, the low one repeated when none is drawn. */
							const args = s.third
								? [boundValue(s.low), boundValue(s.high.kind === "omitted" ? s.low : s.high), 3n]
								: [boundValue(s.low), ...(s.high.kind === "omitted" ? [] : [boundValue(s.high)])]
							const [lowArg, ...rest] = args
							const call = () => runtimeWithin(lowArg, ...argumentsOf(rest))
							const lowArgument = lowDesc(s.low)
							const highArgument = highDesc(s.high, lowArgument)
							if (s.third || lowArgument.kind === "refused" || highArgument.kind === "refused") {
								c.note("refused bound")
								return void throwsRefused(call, "MalformedDescription")
							}
							const [low, high] = [lowArgument.bound, highArgument.bound]
							if (typeof low === "bigint" && typeof high === "bigint" && low > high) {
								c.note("refused bound")
								return void throwsRefused(call, "MalformedDescription")
							}
							c.note(
								s.high.kind === "omitted" ? "exact" : high === "*" ? "no upper bound" : "bounded"
							)
							const bound = call()
							assert.deepEqual(bound, { low, high })
							if (
								s.weight === "a weight weigh did not build" ||
								s.weight === "an unknown rule member"
							) {
								c.note("refused rule")
								/** A malformed rule is refused where capacity(...) admits its arguments, its admission core. */
								const malformedRule =
									s.weight === "a weight weigh did not build"
										? { weight: { units: true } }
										: { limit: 3n }
								return void throwsRefused(
									() =>
										admitCapacity(onBuilder(Pool, ["id"]), {
											from: onBuilder(Claim, ["pool"]),
											within: bound,
											...malformedRule
										}),
									"MalformedDescription"
								)
							}
							const weight =
								s.weight === "a field"
									? { weight: runtimeWeigh("units") }
									: s.weight === "a duration"
										? { weight: runtimeWeigh(runtimeDuration("during")) }
										: {}
							c.note(s.weight)
							const desc = statementDescOf(
								capacityBuilder(onBuilder(Pool, ["id"]), {
									from: onBuilder(Claim, ["pool"]),
									within: bound,
									...weight
								})
							)
							if (desc?.kind !== "capacity") {
								return assert.fail("a capacity statement")
							}
							assert.deepEqual<SideDesc>(desc.target, {
								relation: "Pool",
								terms: [{ kind: "field", field: "id" }],
								selection: everyFact
							})
							assert.deepEqual<SideDesc>(desc.from, {
								relation: "Claim",
								terms: [{ kind: "field", field: "pool" }],
								selection: everyFact
							})
							assert.deepEqual(
								desc.weight,
								s.weight === "a field"
									? { kind: "field", field: "units" }
									: s.weight === "a duration"
										? { kind: "duration", field: "during" }
										: { kind: "count" }
							)
							assert.deepEqual(desc.within, { low, high })
						})
				)
			)
	)

	/**
	 * A row check's predicate as drawn over Election: comparisons of integer fields, Compute sums (a term its builder
	 * registered, or the same expression as an untyped term of the query builder), and charLength of the text field, with
	 * integer literals, under and, or and not.
	 */
	type Operand =
		| { readonly kind: "field"; readonly field: "limit" | "maximum" }
		| {
				readonly kind: "sum"
				readonly typed: boolean
				readonly field: "limit" | "maximum"
				readonly addend: number
		  }
	type Op = "eq" | "ne" | "lt" | "le" | "gt" | "ge"
	type CheckPredicate =
		| {
				readonly kind: "fields"
				readonly op: Op
				readonly left: Operand
				readonly right: "limit" | "maximum"
		  }
		| {
				readonly kind: "literal"
				readonly op: Op
				readonly left: Operand
				readonly value: number
				readonly helper: boolean
		  }
		| { readonly kind: "length"; readonly op: Op; readonly n: number }
		| { readonly kind: "and" | "or"; readonly args: Arr.NonEmptyReadonlyArray<CheckPredicate> }
		| { readonly kind: "not"; readonly arg: CheckPredicate }
	type CheckDefect =
		| "none"
		| "a fraction for an integer field"
		| "a bigint for an integer field"
		| "an integer beyond int4"
		| "a parameter"
		| "charLength of an integer field"
		| "a callback returning no predicate"
		| "a look-alike term"
		| "a spread copy of a term"
		| "a symbol operand"
		| "a derived relation"
	const checkDefects: Arr.NonEmptyReadonlyArray<CheckDefect> = [
		"none",
		"a fraction for an integer field",
		"a bigint for an integer field",
		"an integer beyond int4",
		"a parameter",
		"charLength of an integer field",
		"a callback returning no predicate",
		"a look-alike term",
		"a spread copy of a term",
		"a symbol operand",
		"a derived relation"
	]

	const opGen = element<Op>(["eq", "ne", "lt", "le", "gt", "ge"])
	const intField = element<"limit" | "maximum">(["limit", "maximum"])
	const operandGen: Gen<Operand> = weighted([
		[3, map(intField, (field): Operand => ({ kind: "field", field }))],
		[
			1,
			map(
				(source) => ({
					typed: source.draw(boolean),
					field: source.draw(intField),
					addend: source.draw(int(-100, 100))
				}),
				(r): Operand => ({ kind: "sum", ...r })
			)
		]
	])
	const atomGen: Gen<CheckPredicate> = oneOf([
		map(
			(source) => ({
				op: source.draw(opGen),
				left: source.draw(operandGen),
				right: source.draw(intField)
			}),
			(r): CheckPredicate => ({ kind: "fields", ...r })
		),
		map(
			(source) => ({
				op: source.draw(opGen),
				left: source.draw(operandGen),
				value: source.draw(int(-1000, 1000)),
				helper: source.draw(boolean)
			}),
			(r): CheckPredicate => ({ kind: "literal", ...r })
		),
		map(
			(source) => ({ op: source.draw(opGen), n: source.draw(int(0, 2000)) }),
			(r): CheckPredicate => ({ kind: "length", ...r })
		)
	])
	const predicateGen = (depth: number): Gen<CheckPredicate> =>
		depth === 0
			? atomGen
			: weighted([
					[2, atomGen],
					[
						1,
						map(
							(source) => ({
								kind: source.draw(element<"and" | "or">(["and", "or"])),
								args: source.draw(nonEmptyGen(predicateGen(depth - 1), 2))
							}),
							(r): CheckPredicate => r
						)
					],
					[1, map(predicateGen(depth - 1), (arg): CheckPredicate => ({ kind: "not", arg }))]
				])

	const Election = relation(
		"Election",
		{ id: uuid, limit: rawPg.integer, maximum: rawPg.integer, label: wildcard },
		["id"],
		[]
	)
	const literalExpr = (value: LiteralDesc): ExprDesc => ({
		kind: "literal",
		value,
		type: undefined
	})

	/** The term an operand builds over the row, and the ExprDesc it records. */
	const operandTerm = (e: Row, o: Operand): unknown => {
		if (o.kind === "field") {
			return e[o.field]
		}
		const sum = computeCore.add(e[o.field], o.addend)
		return o.typed ? sum : untypedTerm(sum.expr)
	}
	const operandExpr = (o: Operand): ExprDesc =>
		o.kind === "field"
			? { kind: "field", field: o.field }
			: {
					kind: "compute",
					fn: "add",
					args: [{ kind: "field", field: o.field }, literalExpr(o.addend)]
				}

	const built = (e: Row, p: CheckPredicate): unknown => {
		switch (p.kind) {
			case "fields":
				return e[p.op](operandTerm(e, p.left), e[p.right])
			case "literal": {
				const term = operandTerm(e, p.left)
				return p.helper || p.left.kind === "sum"
					? e[p.op](term, p.value)
					: e[p.left.field][p.op](p.value)
			}
			case "length":
				return e.charLength(e.label)[p.op](p.n)
			case "and":
			case "or":
				return e[p.kind](...argumentsOf(Arr.map(p.args, (a) => built(e, a))))
			case "not":
				return e.not(built(e, p.arg))
		}
	}
	const recordedExpr = (p: CheckPredicate): ExprDesc => {
		switch (p.kind) {
			case "fields":
				return {
					kind: "compare",
					op: p.op,
					left: operandExpr(p.left),
					right: { kind: "field", field: p.right }
				}
			case "literal":
				return { kind: "compare", op: p.op, left: operandExpr(p.left), right: literalExpr(p.value) }
			case "length":
				return {
					kind: "compare",
					op: p.op,
					left: { kind: "compute", fn: "charLength", args: [{ kind: "field", field: "label" }] },
					right: literalExpr(p.n)
				}
			case "and":
			case "or": {
				/** A connective of one predicate is that predicate. */
				const [only, ...more] = p.args
				return more.length === 0
					? recordedExpr(only)
					: { kind: p.kind, args: Arr.map(p.args, recordedExpr) }
			}
			case "not":
				return { kind: "not", arg: recordedExpr(p.arg) }
		}
	}

	/** Every operand of a drawn predicate. */
	const operandsOf = (p: CheckPredicate): ReadonlyArray<Operand> => {
		switch (p.kind) {
			case "fields":
			case "literal":
				return [p.left]
			case "length":
				return []
			case "and":
			case "or":
				return Arr.flatMap(p.args, operandsOf)
			case "not":
				return operandsOf(p.arg)
		}
	}

	/** The conjunct a defect plants beside the drawn predicate. */
	const plantedConjunct = (e: Row, defect: CheckDefect): unknown => {
		const sum = computeCore.add(e.limit, 1)
		switch (defect) {
			case "a fraction for an integer field":
				return e.limit.ge(1.5)
			case "a bigint for an integer field":
				return e.limit.ge(1n)
			case "an integer beyond int4":
				return e.limit.ge(2 ** 31)
			case "a parameter":
				return e.limit.ge({ param: "x" })
			case "charLength of an integer field":
				return e.charLength(e.limit).le(3)
			case "a look-alike term":
				return e.le({ expr: sum.expr }, e.maximum)
			case "a spread copy of a term":
				return e.le({ ...sum }, e.maximum)
			case "a symbol operand":
				return e.lt(untypedTerm(sum.expr), Symbol("x"))
			case "none":
			case "a callback returning no predicate":
			case "a derived relation":
				return e.limit.ge(0)
		}
	}

	it.effect(
		"check records the row predicate over its own row, literals adopting the field's type, terms admitted by identity",
		(ctx) =>
			Effect.gen(function* () {
				const D = derived(
					"ElectionIds",
					idsOf(schema("Votes", { Election }, [], []), [Election]),
					[]
				)
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/schema/check-constructor",
							/** Planted: a typed and an untyped sum, which a fourth of the operands draw a few times a run. */
							draw: sketched(
								(source) => ({
									predicate: source.draw(predicateGen(2)),
									defect: source.draw(
										element(Arr.append(Arr.append(checkDefects, "none" as const), "none" as const))
									)
								}),
								(c) => c
							),
							literal: Formatter.format,
							coverage: required<CheckDefect | "a sum" | "an untyped sum">(
								[...checkDefects, "a sum", "an untyped sum"],
								{ cases: 300, sense: notesOnly }
							),
							kept: [
								{
									note: "a typed and an untyped sum",
									sketch: {
										predicate: {
											kind: "and",
											args: [
												{
													kind: "fields",
													op: "le",
													left: { kind: "sum", typed: true, field: "limit", addend: 1 },
													right: "maximum"
												},
												{
													kind: "literal",
													op: "ge",
													left: { kind: "sum", typed: false, field: "limit", addend: 2 },
													value: 0,
													helper: false
												}
											]
										},
										defect: "none"
									},
									draws: "",
									reaches: ["a sum", "an untyped sum"]
								}
							],
							runs: 300,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ predicate, defect }, c) =>
							Effect.sync(() => {
								c.note(defect)
								const build = () =>
									checkBuilder(
										defect === "a derived relation" ? "OnDerived" : "Bounded",
										defect === "a derived relation" ? D : Election,
										(e: Row) =>
											defect === "a callback returning no predicate"
												? true
												: defect === "none"
													? built(e, predicate)
													: e.and(built(e, predicate), plantedConjunct(e, defect))
									)
								if (defect === "a derived relation") {
									return void throwsRefused(build, "LawOnDerived")
								}
								if (defect !== "none") {
									return void throwsRefused(build, "MalformedDescription")
								}
								const sums = operandsOf(predicate)
								if (Arr.some(sums, (o) => o.kind === "sum" && o.typed)) {
									c.note("a sum")
								}
								if (Arr.some(sums, (o) => o.kind === "sum" && !o.typed)) {
									c.note("an untyped sum")
								}
								const value = build()
								matchesObject(value, { kind: "check", name: "Bounded", relation: Election })
								const desc = statementDescOf(value)
								if (desc?.kind !== "check") {
									return assert.fail("a check statement")
								}
								assert.deepEqual(desc, {
									...desc,
									name: "Bounded",
									relation: "Election",
									predicate: recordedExpr(predicate)
								})
							})
					)
				)
			})
	)
})

describe("alternatives", () => {
	type AlternativesDefect =
		| "none"
		| "a discriminator of another type"
		| "a discriminator of another roster"
		| "an arm off the roster"
		| "no arms"
		| "an arm keyed unlike the parent"
		| "the parent as an arm"
	const alternativesDefects: Arr.NonEmptyReadonlyArray<AlternativesDefect> = [
		"none",
		"a discriminator of another type",
		"a discriminator of another roster",
		"an arm off the roster",
		"no arms",
		"an arm keyed unlike the parent",
		"the parent as an arm"
	]
	type AlternativesFeature =
		| AlternativesDefect
		| "a Key as the parent"
		| "a Key as an arm"
		| "an unarmed handle"
		| "a two-field key"
	const Alien = closed("Alien", ["X"], [])

	it.effect(
		"is one statement expanding to the two containments of each armed handle, in roster order, each marked",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/alternatives-constructor",
						draw: drawn((source) => ({
							handles: source.draw(
								uniqueArray(
									matching(arkregex("^[A-Z][a-z]{0,6}$")),
									(item) => item,
									{ min: 1, max: 4 },
									20
								)
							),
							armed: source.draw(array(boolean, { min: 4, max: 4 })),
							arming: source.draw(array(boolean, { min: 4, max: 4 })),
							wide: source.draw(boolean),
							parentKey: source.draw(boolean),
							defect: source.draw(element(Arr.append(alternativesDefects, "none" as const))),
							at: source.draw(pickGen)
						})),
						literal: Formatter.format,
						coverage: required<AlternativesFeature>(
							[
								...alternativesDefects,
								"a Key as the parent",
								"a Key as an arm",
								"an unarmed handle",
								"a two-field key"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							c.note(s.defect)
							const Mode = closed("Mode", rosterOf(s.handles), [])
							const Job = relation(
								"Job",
								{ id: uuid, mode: rawClosedId(Mode), other: uuid, alien: rawClosedId(Alien) },
								["id"],
								[]
							)
							/** The parent's key: Job's primary key, a one-field Key, or a two-field Key. */
							const parentFields = s.wide ? ["id", "other"] : s.parentKey ? ["other"] : ["id"]
							const parent = s.wide || s.parentKey ? keyBuilder(onBuilder(Job, parentFields)) : Job
							if (s.wide) {
								c.note("a two-field key")
							} else if (s.parentKey) {
								c.note("a Key as the parent")
							}
							/** The armed handles, at least one: the first is armed when the draw arms none. */
							const drawnArmed = whereIndex(s.handles, (i) => s.armed[i] === true)
							const armedHandles = drawnArmed.length > 0 ? drawnArmed : s.handles.slice(0, 1)
							if (armedHandles.length < s.handles.length) {
								c.note("an unarmed handle")
							}
							const target = defined(armedHandles[pickIndex(s.at, armedHandles.length)])
							const arms: Record<string, unknown> = {}
							const armKeys: Record<
								string,
								{ readonly relation: string; readonly fields: ReadonlyArray<string> }
							> = {}
							for (const h of armedHandles) {
								const i = s.handles.indexOf(h)
								const Arm = relation(`Arm${i}`, { job: uuid, extra: uuid }, ["job"], [])
								const unlike = s.defect === "an arm keyed unlike the parent" && h === target
								const two = s.wide !== unlike
								const viaKey = two || s.arming[i] === true
								const fields = two ? ["job", "extra"] : viaKey ? ["extra"] : ["job"]
								if (viaKey && !two) {
									c.note("a Key as an arm")
								}
								arms[h] = viaKey ? keyBuilder(onBuilder(Arm, fields)) : Arm
								armKeys[h] = { relation: `Arm${i}`, fields }
							}
							if (s.defect === "an arm off the roster") {
								arms[`${target}Off`] = arms[target]
							}
							if (s.defect === "the parent as an arm") {
								arms[target] = parent
							}
							const discriminator =
								s.defect === "a discriminator of another type"
									? "other"
									: s.defect === "a discriminator of another roster"
										? "alien"
										: "mode"
							const armMap = s.defect === "no arms" ? {} : arms
							const build = () => alternativesBuilder(parent, discriminator, Mode, armMap)
							if (s.defect !== "none") {
								return void throwsRefused(build, "MalformedDescription")
							}
							const law = build()
							assert.equal(Object.isFrozen(law), true)
							matchesObject(law, {
								kind: "alternatives",
								parent,
								discriminator: "mode",
								roster: Mode
							})
							assert.deepEqual(law.arms, arms)
							const origin = { alternatives: alternativesId("Job", "mode") }
							/**
							 * No head containment: the roster's domain types the discriminator. Each armed handle's parents, selected by
							 * their discriminator, are contained in its arm, and the arm in them.
							 */
							const expansion = Arr.flatMap(s.handles, (h) => {
								const arm = armKeys[h]
								if (arm === undefined) {
									return []
								}
								const selected = {
									relation: "Job",
									terms: fieldTerms(parentFields),
									selection: {
										conjuncts: [
											{
												kind: "compare" as const,
												op: "eq" as const,
												left: { kind: "field" as const, field: "mode" },
												right: { kind: "literal" as const, value: h }
											}
										]
									}
								}
								const armSide = {
									relation: arm.relation,
									terms: fieldTerms(arm.fields),
									selection: everyFact
								}
								return [
									{ kind: "contained" as const, left: selected, right: armSide, origin },
									{ kind: "contained" as const, left: armSide, right: selected, origin }
								]
							})
							matchesObject(defined(expansionDescOf(law)).statements, expansion)
						})
				)
			)
	)
})

describe("schema and schema.extend", () => {
	const Account = relation("Account", { id: uuid, name: regex("^[a-z]{1,40}$", "u") }, ["id"], [])
	const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: Cents }, ["task"], [])
	const TaskRebuilt = relation(
		"Task",
		{ id: uuid, account: uuid, kind: rawClosedId(Kind) },
		["id"],
		[]
	)
	type Entry = "Kind" | "Task" | "Account" | "Task rebuilt"
	const entryValue = (e: Entry): AnyRelation | AnyClosed =>
		e === "Kind" ? Kind : e === "Task" ? Task : e === "Account" ? Account : TaskRebuilt
	const entryName = (e: Entry): string => (e === "Task rebuilt" ? "Task" : e)
	const statementValues: Arr.NonEmptyReadonlyArray<Statement> = [
		mutableBuilder(Task),
		keyBuilder(onBuilder(Account, ["name"])),
		alternativesBuilder(Task, "kind", Kind, { Automatic: AutomaticTask })
	]
	type SchemaDefect =
		| "none"
		| "a relation under another name"
		| "a list as a statement"
		| "a statement no builder made"
		| "a derived relation"
		| "statements that are no list"
	const schemaDefects: Arr.NonEmptyReadonlyArray<SchemaDefect> = [
		"none",
		"a relation under another name",
		"a list as a statement",
		"a statement no builder made",
		"a derived relation",
		"statements that are no list"
	]

	it.effect(
		"records each relation under its own name and statements in order, expanding alternatives in place, and refuses a relation under another name or a malformed declaration",
		(ctx) =>
			Effect.gen(function* () {
				const D = derived("TaskIds", idsOf(schema("Edu", { Kind, Task }, [], []), [Task]), [])
				yield* searched(
					ctx,
					explore(
						{
							suite: "unit/schema/schema-constructor",
							draw: drawn((source) => ({
								entries: source.draw(
									nonEmptyGen(element<Entry>(["Kind", "Task", "Account", "Task rebuilt"]), 4)
								),
								statements: source.draw(shuffled([0, 1, 2], { min: 0, max: [0, 1, 2].length })),
								defect: source.draw(element(Arr.append(schemaDefects, "none" as const)))
							})),
							literal: Formatter.format,
							coverage: required<SchemaDefect | "alternatives expanded">(
								[...schemaDefects, "alternatives expanded"],
								{ cases: 200, sense: notesOnly }
							),
							kept: [],
							runs: 200,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(s, c) =>
							Effect.sync(() => {
								c.note(s.defect)
								/** The record is the schema index by name: each entry under its own name, a later entry of a name in place of an earlier one. */
								const relations: Record<string, AnyRelation | AnyClosed> = Rec.fromEntries(
									Arr.map(s.entries, (e) => [entryName(e), entryValue(e)])
								)
								const statements = Arr.map(s.statements, (i) => defined(statementValues[i]))
								/**
								 * The relations a JavaScript caller hands in, where a defect plants one no schema(...) declares; a defect
								 * is refused by schema(...)'s admission core.
								 */
								const given: Record<string, unknown> = { ...relations }
								switch (s.defect) {
									case "a relation under another name":
										given["task"] = Task
										return void throwsRefused(
											() => admitSchema("Work", given, statements, []),
											"MalformedDescription"
										)
									case "a list as a statement":
										return void throwsRefused(
											() => admitSchema("Work", given, [...statements, [statementValues[2]]], []),
											"MalformedDescription"
										)
									case "a statement no builder made":
										return void throwsRefused(
											() => admitSchema("Work", given, [...statements, { kind: "key" }], []),
											"MalformedDescription"
										)
									case "a derived relation":
										given["derived"] = D
										return void throwsRefused(
											() => admitSchema("Work", given, statements, []),
											"MalformedDescription"
										)
									case "statements that are no list":
										return void throwsRefused(
											() => admitSchema("Work", given, "statements", []),
											"MalformedDescription"
										)
									case "none":
										break
								}
								const names = Arr.map(s.entries, entryName)
								const W = schema("Work", relations, statements, [])
								const desc = defined(schemaDescOf(W))
								assert.deepEqual(
									Arr.map(desc.relations, (r) => r.name),
									distinct(names)
								)
								const expanded = Arr.flatMap(statements, (st): ReadonlyArray<StatementDesc> => {
									const expansion = expansionDescOf(st)
									return expansion === undefined
										? [defined(statementDescOf(st))]
										: expansion.statements
								})
								if (expanded.length > statements.length) {
									c.note("alternatives expanded")
								}
								assert.deepEqual(desc.statements, expanded)
								matchesObject(W, { name: "Work", relations, statements })
								assert.equal("extends" in W ? W.extends : "no base member", undefined)
							})
					)
				)
			})
	)

	/**
	 * A derived relation as drawn: the relations of the levels below it its definition reads (picks into them, at least
	 * one), on their ids.
	 */
	type LevelDefect =
		| "none"
		| "a read of its own level"
		| "a parameter"
		| "a definition that is no query"
	const levelDefects: Arr.NonEmptyReadonlyArray<LevelDefect> = [
		"none",
		"a read of its own level",
		"a parameter",
		"a definition that is no query"
	]

	it.effect(
		"extends under the base's name and computes derived levels from what definitions read",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/schema/derived-levels",
						/**
						 * Planted: a view of level 3 reading one of level 2 named before one of level 1, which the drawn towers
						 * reach a few times a run. Its picks select, among the relations below each level, ZView1x0 at level 2
						 * and both AView2x0 and ZView1x0 at level 3.
						 */
						draw: sketched(
							(source) => ({
								levels: source.draw(
									nonEmptyGen(
										nonEmptyGen(
											(source) => ({
												reads: source.draw(nonEmptyGen(pickGen, 1)),
												prefix: source.draw(element(["A", "M", "Z"]))
											}),
											1
										),
										2
									)
								),
								defect: source.draw(
									element(Arr.append(Arr.append(levelDefects, "none" as const), "none" as const))
								)
							}),
							(c) => c
						),
						literal: Formatter.format,
						coverage: required<
							LevelDefect | "level 2" | "level 3" | "two reads" | "a deeper read named first"
						>([...levelDefects, "level 2", "level 3", "two reads", "a deeper read named first"], {
							cases: 300,
							sense: notesOnly
						}),
						kept: [
							{
								note: "a level-3 view reading AView2x0 and ZView1x0",
								sketch: {
									levels: [
										[{ reads: [0], prefix: "Z" }],
										[{ reads: [pickSpan / 2], prefix: "A" }],
										[
											{
												reads: [Math.ceil((2 * pickSpan) / 3), Math.ceil(pickSpan / 3)],
												prefix: "M"
											}
										]
									],
									defect: "none"
								},
								draws: "",
								reaches: ["a deeper read named first" as const, "level 3" as const]
							}
						],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(s, c) =>
						Effect.sync(() => {
							c.note(s.defect)
							interface Declared {
								readonly name: string
								readonly value: AnyRelation | AnyDerived
								/** 0 for a base relation. */
								readonly derivedLevel: number
							}
							const tower = () => {
								const base = schema("Edu", { Kind, Task }, [], [])
								const below: Array<Declared> = [{ name: "Task", value: Task, derivedLevel: 0 }]
								const chain: Array<AnySchema> = [base]
								const expected: Array<{
									readonly name: string
									readonly level: number
									readonly schemaLevel: number
									readonly reads: ReadonlyArray<string>
								}> = []
								let current: AnySchema = base
								for (const [k, level] of s.levels.entries()) {
									const declared: Array<Declared> = []
									const record: Record<string, AnyDerived> = {}
									for (const [j, view] of level.entries()) {
										const reads = distinct(
											Arr.map(view.reads, (p) => defined(below[pickIndex(p, below.length)]))
										)
										/**
										 * The prefix varies where a view sorts by name among the relations a later definition reads.
										 */
										const name = `${view.prefix}View${k + 1}x${j}`
										const value = derived(
											name,
											idsOf(current, [
												defined(reads[0]).value,
												...Arr.map(reads.slice(1), (r) => r.value)
											]),
											[]
										)
										const derivedLevel = maxOf(
											Arr.map(reads, (r) => r.derivedLevel + 1),
											Number.NEGATIVE_INFINITY
										)
										if (reads.length > 1) {
											c.note("two reads")
										}
										const byName = Arr.sort(
											Arr.filter(reads, (r) => r.derivedLevel > 0),
											Order.mapInput(Order.String, (r: { readonly name: string }) => r.name)
										)
										const lastByName = byName[byName.length - 1]
										if (lastByName !== undefined && lastByName.derivedLevel + 1 < derivedLevel) {
											c.note("a deeper read named first")
										}
										if (derivedLevel === 2) {
											c.note("level 2")
										}
										if (derivedLevel === 3) {
											c.note("level 3")
										}
										declared.push({ name, value, derivedLevel })
										record[name] = value
										expected.push({
											name,
											level: derivedLevel,
											schemaLevel: k + 1,
											reads: Arr.sort(
												Arr.map(reads, (r) => r.name),
												Order.String
											)
										})
									}
									if (k === s.levels.length - 1) {
										const first = defined(declared[0])
										switch (s.defect) {
											case "a read of its own level":
												record["OwnLevel"] = derived(
													"OwnLevel",
													idsOf(schema.extend(current, { [first.name]: first.value }, [], []), [
														first.value
													]),
													[]
												)
												break
											case "a parameter":
												record["ByAccount"] = derived(
													"ByAccount",
													queryOver(current).rule((r: RuleValue) => {
														const { id } = varsOver(Task, "task")
														return r
															.match(Task, { id, account: r.param("account", uuid) })
															.find({ id })
													}),
													[]
												)
												break
											case "a definition that is no query":
												admitDerived("Bad", {}, [])
												break
											case "none":
												break
										}
									}
									current = schema.extend(current, record, [], [])
									chain.push(current)
									appendAll(below, declared)
								}
								return { current, chain, expected }
							}
							if (s.defect !== "none") {
								return void throwsRefused(tower, "MalformedDescription")
							}
							const { current, chain, expected } = tower()
							for (const [k, value] of chain.entries()) {
								const desc = defined(schemaDescOf(value))
								assert.equal(desc.name, "Edu")
								assert.equal(
									"extends" in value ? value.extends : "no base member",
									k === 0 ? undefined : chain[k - 1]
								)
								if (k > 0) {
									matchesObject(
										desc.relations,
										Arr.map(
											Arr.filter(expected, (e) => e.schemaLevel === k),
											(e) => ({ kind: "derived" as const, name: e.name, level: e.level })
										)
									)
								}
							}
							const owned = succeeded(own(defined(schemaDescOf(current))))
							for (const e of expected) {
								const r = defined(owned.relations[e.name])
								if (r.kind !== "derived") {
									return assert.fail(`${e.name} is a derived relation`)
								}
								assert.deepEqual(
									[r.level, r.desc.level, r.reads],
									[e.schemaLevel, e.level, e.reads]
								)
							}
						})
				)
			)
	)
})
