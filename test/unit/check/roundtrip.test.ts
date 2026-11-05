import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import type { Gen } from "@grizzle/testing/gen"
import {
	type Broken,
	type CorruptedFeature,
	type Corruption,
	corrupted as corruptedGen,
	corruptedFeature
} from "@grizzle/testing/lsw"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { tokenOf } from "@grizzle/testing/tape"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record } from "effect"
import { allenBit } from "#compiler/allen/mask.ts"
import type { CheckedSchema } from "#compiler/analysis/schema.ts"
import type { CheckOptions } from "#compiler/check/checker.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { catchRefusal, type Json } from "#compiler/core/canonical.ts"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import { formatLoc, SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { normalizeDag } from "#compiler/ir/dag.ts"
import { descText, type QueryDesc, type QueryStageDesc, type RuleDesc } from "#compiler/ir/desc.ts"
import { toQueryDescription } from "#compiler/ir/describe.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	numericTypmodOf,
	rosterOf,
	sameScalarType,
	type ScalarType,
	textOf,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, refusalLoc } from "#test/support/assert.ts"
import { fromQueryDescription, queryFromDesc } from "#test/support/describe.ts"
import { caseHang } from "#test/support/limits.ts"
import { messageOf } from "#test/support/message.ts"
import { scalarOfSpec } from "#test/support/oracle/gen/domain.ts"
import { unperturbed } from "#test/support/oracle/perturb.ts"
import { buildRoot, buildSchema } from "#test/support/oracle/public/build.ts"
import {
	type CaseSketch,
	caseSketchGen,
	resolveCase
} from "#test/support/oracle/public/generate.ts"
import { printCase } from "#test/support/oracle/public/print.ts"
import {
	type ProgramCase,
	type ProgramField,
	type KeyKind,
	keyKinds,
	type ProgramRead,
	type Stored,
	type Var
} from "#test/support/oracle/public/program.ts"
import { checking, checkMemberOf, checkOptions } from "#test/support/policy.ts"

type QueryRead = Extract<ProgramRead, { readonly kind: "query" }>

const ok = <A>(r: Result.Result<A, CompileError>, what: string): A => {
	if (!r.ok) {
		throw new Error(`${what}: ${r.error.message}`)
	}
	return r.value
}

/**
 * A description from anywhere as test/support/describe.ts queryFromDescription reads it: its shapes
 * (fromQueryDescription), then the complete check against the schema, scope included; the Description read when both
 * admit it.
 */
const describedQuery = (
	value: unknown,
	checked: CheckedSchema,
	options: CheckOptions
): Result.Result<QueryDesc, CompileError> =>
	Result.flatMap(fromQueryDescription(value), (desc) =>
		Result.map(checkQuery(checked, desc, options), () => desc)
	)

const text = (desc: QueryDesc): string => ok(descText(desc), "descText")

const normalized = (q: LogicalQuery) => ({
	dag: ok(normalizeDag(q.dag), "normalizeDag"),
	params: Arr.sort(
		q.params,
		Order.mapInput(Order.String, (p: { readonly name: string }) => p.name)
	)
})

type JsonRecord = { readonly [key: string]: Json }

/** A position in a JSON tree: the keys and indices that lead to it from the root. */
type Path = ReadonlyArray<string | number>

/** A record of a JSON tree and the path that leads to it: a site a corruption or a rewrite changes. */
interface Site {
	readonly path: Path
	readonly record: JsonRecord
}

const isJsonArray = (value: Json | undefined): value is ReadonlyArray<Json> => Arr.isArray(value)

const isRecord = (value: Json | undefined): value is JsonRecord =>
	typeof value === "object" && !isJsonArray(value)

/** A value a chosen site holds as a record; `what` states the precondition. */
const recordOf = (value: Json | undefined, what: string): JsonRecord => {
	if (!isRecord(value)) {
		throw new Error(what)
	}
	return value
}

/** A value a chosen site holds as an array; `what` states the precondition. */
const arrayOf = (value: Json | undefined, what: string): ReadonlyArray<Json> => {
	if (!isJsonArray(value)) {
		throw new Error(what)
	}
	return value
}

const samePath = (a: Path, b: Path): boolean =>
	a.length === b.length && Arr.every(a, (step, i) => step === b[i])

/** `record` with the record at `path` below it replaced by `edit` of it, every other value shared. */
const rewriteAt = (
	record: JsonRecord,
	path: Path,
	edit: (site: JsonRecord) => JsonRecord
): JsonRecord => {
	const [step, ...rest] = path
	return step === undefined
		? edit(record)
		: { ...record, [step]: rewriteBelow(record[step], rest, edit) }
}

/** A value on a path rewritten below it: an array at the path's index, a record at its key. */
const rewriteBelow = (
	value: Json | undefined,
	path: Path,
	edit: (site: JsonRecord) => JsonRecord
): Json => {
	if (!isJsonArray(value)) {
		return rewriteAt(recordOf(value, "a path leads through records and arrays"), path, edit)
	}
	const [index, ...rest] = path
	if (typeof index !== "number" || index >= value.length) {
		throw new Error("a path indexes an element of its array")
	}
	return Arr.map(value, (element, i) => (i === index ? rewriteBelow(element, rest, edit) : element))
}

/** A description rewritten at a path. */
const rewriteQueryAt = (
	description: Json,
	path: Path,
	edit: (site: JsonRecord) => JsonRecord
): Json => rewriteAt(recordOf(description, "a query description is a JSON object"), path, edit)

/**
 * Every record under `value` that `pick` takes, in document order, with its path from `at`; the walk enters a
 * record's value at a key where `enters` says so.
 */
const sitesUnder = (
	value: Json | undefined,
	at: Path,
	pick: (record: JsonRecord) => boolean,
	enters: (record: JsonRecord, key: string) => boolean
): ReadonlyArray<Site> => {
	if (isJsonArray(value)) {
		return Arr.flatMap(value, (element, i) => sitesUnder(element, [...at, i], pick, enters))
	}
	if (!isRecord(value)) {
		return []
	}
	const entries = Record.toEntries(value)
	const below = Arr.flatMap(entries, ([key, child]) =>
		enters(value, key) ? sitesUnder(child, [...at, key], pick, enters) : []
	)
	return pick(value) ? [{ path: at, record: value }, ...below] : below
}

const everyKey = (): boolean => true

/** Every record in a JSON tree satisfying `pick`, in document order. */
const collect = (
	value: Json | undefined,
	pick: (record: JsonRecord) => boolean
): ReadonlyArray<Site> => sitesUnder(value, [], pick, everyKey)

const isRule = (v: JsonRecord): boolean =>
	isJsonArray(v["vars"]) && isJsonArray(v["matches"]) && isJsonArray(v["where"])

const isMatch = (v: JsonRecord): boolean => isRecord(v["source"]) && isRecord(v["bindings"])

/** The stage of arms a stage reads, below its attachments, names, orders and takes, at its path from `at`. */
const armsStage = (stage: Json | undefined, at: Path): Site | undefined => {
	if (!isRecord(stage)) {
		return undefined
	}
	return isJsonArray(stage["arms"])
		? { path: at, record: stage }
		: armsStage(stage["input"], [...at, "input"])
}

/** The stage of arms the query's root stage reads. */
const rootStage = (q: Json | undefined): Site | undefined =>
	isRecord(q) ? armsStage(q["stage"], ["stage"]) : undefined

/** The arms of a stage that are records, each a site. */
const armSites = (stage: Site): ReadonlyArray<Site> => {
	const arms = stage.record["arms"]
	return isJsonArray(arms)
		? Arr.flatMap(arms, (arm, i) =>
				isRecord(arm) ? [{ path: [...stage.path, "arms", i], record: arm }] : []
			)
		: []
}

/** The first arm of the rules the query's root stage reads. */
const rootRule = (q: Json | undefined): Site | undefined => {
	const stage = rootStage(q)
	const arms = stage?.record["arms"]
	const first = isJsonArray(arms) ? arms[0] : undefined
	return stage !== undefined && isRecord(first)
		? { path: [...stage.path, "arms", 0], record: first }
		: undefined
}

/** A column an attachment stage's parent delivers: a head key every arm of the rules stage below it shares. */
const parentColumn = (stage: JsonRecord): Option.Option<string> => {
	const below = armsStage(stage["input"], ["input"])?.record
	if (below?.["kind"] !== "rules" || !isJsonArray(below["arms"])) {
		return Option.none()
	}
	const heads = Arr.flatMap(below["arms"], (arm) =>
		isRecord(arm) && isRecord(arm["head"]) ? [arm["head"]] : []
	)
	const [first] = heads
	return first === undefined
		? Option.none()
		: Arr.findFirst(Record.keys(first), (key) => Arr.every(heads, (head) => key in head))
}

/** The stages of one kind. */
const stagesOf = (q: Json | undefined, kind: string): ReadonlyArray<Site> =>
	collect(q, (v) => v["kind"] === kind && ("arms" in v || "input" in v))

/** A stage's input, and that stage's inputs in turn. */
const inputsOf = (stage: Site): ReadonlyArray<Site> => {
	const input = stage.record["input"]
	if (!isRecord(input)) {
		return []
	}
	const below: Site = { path: [...stage.path, "input"], record: input }
	return [below, ...inputsOf(below)]
}

/**
 * Every stage a union reads below it: its input, and that stage's inputs in turn. A column added to one of their
 * arms changes the heading the union joins, which the union refuses first.
 */
const belowUnions = (q: Json | undefined): ReadonlyArray<Site> =>
	Arr.flatMap(stagesOf(q, "union"), inputsOf)

/** A head with no aggregate and no span producer: one whose terms are each a column of the rule's bindings. */
const plainHead = (rule: JsonRecord): boolean =>
	isRecord(rule["head"]) &&
	Arr.every(
		Record.values(rule["head"]),
		(term) => !isRecord(term) || (term["kind"] !== "aggregate" && term["kind"] !== "producer")
	)

/** The first variable a head delivers, its path from the rule. */
const headVar = (rule: JsonRecord): Site | undefined => {
	const head = rule["head"]
	if (!isRecord(head)) {
		return undefined
	}
	for (const [key, term] of Record.toEntries(head)) {
		if (isRecord(term) && term["kind"] === "var") {
			return { path: ["head", key], record: term }
		}
	}
	return undefined
}

/** The single arm of each rules stage whose head is plain, outside every union's input. */
const singlePlainArms = (q: Json | undefined): ReadonlyArray<Site> => {
	const below = belowUnions(q)
	return Arr.flatMap(stagesOf(q, "rules"), (stage) => {
		const arms = stage.record["arms"]
		if (
			Arr.some(below, (b) => samePath(b.path, stage.path)) ||
			!isJsonArray(arms) ||
			arms.length !== 1
		) {
			return []
		}
		const [arm] = armSites(stage)
		return arm !== undefined && plainHead(arm.record) ? [arm] : []
	})
}

/** The matches of every recursive stage's steps, where a `self` source is the step's own. */
const stepMatches = (q: Json | undefined): ReadonlyArray<Site> =>
	Arr.flatMap(
		collect(q, (v) => v["kind"] === "recursive" && isRecord(v["recursive"])),
		(stage) => {
			const recursive = stage.record["recursive"]
			return isRecord(recursive)
				? sitesUnder(recursive["rec"], [...stage.path, "recursive", "rec"], isMatch, everyKey)
				: []
		}
	)

/** The source and bindings of a rule's first match of a stored relation, or undefined where it matches none. */
const relationMatch = (
	rule: JsonRecord
): { readonly source: JsonRecord; readonly bindings: JsonRecord } | undefined => {
	const matches = rule["matches"]
	for (const m of isJsonArray(matches) ? matches : []) {
		const source = isRecord(m) ? m["source"] : undefined
		const bindings = isRecord(m) ? m["bindings"] : undefined
		if (isRecord(source) && source["kind"] === "relation" && isRecord(bindings)) {
			return { source, bindings }
		}
	}
	return undefined
}

/**
 * The arms whose heads a stage delivers, below its names and through its unions: a plain set's, which a member writes.
 * A closure delivers its own variables and no literal, an attachment, order or take no plain set.
 */
const headArms = (stage: QueryStageDesc): ReadonlyArray<RuleDesc> => {
	switch (stage.kind) {
		case "rules":
			return stage.arms
		case "union":
			return [...headArms(stage.input), ...stage.arms]
		case "named":
			return headArms(stage.input)
		case "recursive":
		case "attach":
		case "order":
		case "take":
		case "approx":
			return []
	}
}

/**
 * The parameters a stage reads itself: every parameter of its rules but those an imported query reads, which the
 * import's bind map binds; the bind map's operands are the stage's own.
 */
const ownParams = (stage: JsonRecord): ReadonlyArray<Site> =>
	sitesUnder(
		stage,
		[],
		(v) => v["kind"] === "param",
		(v, key) => v["kind"] !== "query" || key !== "query"
	)

/**
 * The live artifact: a query read's description, the relation its member check writes into, and the schema's stored
 * relations, whose field kinds a corruption reads.
 */
interface Live {
	readonly description: Json
	readonly read: QueryRead
	readonly relation: Stored
	readonly stored: ReadonlyArray<Stored>
	/** The schema value the read is built over, whose checked form types a member's head literals. */
	readonly schema: unknown
}

/**
 * What the boundary must answer: the reason, read by describedQuery, by describedQuery as a page's query
 * (whose rules may name a parent variable, the checker refusing it as AttachedPage), or for a member by checkMember.
 */
interface Refusal {
	readonly reason: CompileReasonTag
	readonly boundary: "description" | "page" | "member"
}

const malformed: Refusal = { reason: "MalformedDescription", boundary: "description" }
const attachedPage: Refusal = { reason: "AttachedPage", boundary: "page" }

/** Every rule a corruption breaks. */
type RuleName =
	| "stageKind"
	| "dropHead"
	| "dropMatches"
	| "dropVars"
	| "wrongType"
	| "compareOp"
	| "ghostVar"
	| "duplicateVar"
	| "selfSource"
	| "deltaSource"
	| "rowSource"
	| "unknownRelation"
	| "undeclaredInterior"
	| "parentVar"
	| "pageParentVar"
	| "foreignVar"
	| "fieldReference"
	| "valueReference"
	| "unknownField"
	| "orderColumn"
	| "takeBound"
	| "takeBoundPastInt4"
	| "emptyRelationParam"
	| "relationParamRetyped"
	| "scalarParamAsRelation"
	| "paramWithoutType"
	| "missingDiscriminant"
	| "allenEmptyMask"
	| "allenLiteralSpan"
	| "allenParamSpan"
	| "twoSpanProducers"
	| "attachedLikeParent"
	| "attachedTwice"
	| "negationInDisjunction"
	| "incompleteBindMap"
	| "extraBindEntry"
	| "memberHeading"

/** The faithful rewrites of a live description, each named by what it rewrites. */
type Rewritten =
	| "live literal holding U+0001"
	| "live negation conjoined with a comparison"
	| "live head param a comparison types"

/** The live case, its faithful rewrites, and the corruptions by the rule each breaks. */
type Feature = CorruptedFeature<RuleName> | Rewritten

/**
 * Where an edit applies in a description's query, and what it makes of each site: a pure rewrite of the site's record.
 * Both read the schema's stored relations, whose field kinds a planted edit chooses by.
 */
interface Edit {
	readonly sites: (query: Json | undefined, stored: ReadonlyArray<Stored>) => ReadonlyArray<Site>
	readonly edit: (site: JsonRecord, stored: ReadonlyArray<Stored>) => JsonRecord
}

/** A description rewritten at each site of an edit, in site order. */
const rewrittenAt = (
	description: Json,
	stored: ReadonlyArray<Stored>,
	at: Edit
): ReadonlyArray<Json> => {
	const sites = at.sites(description, stored)
	return Arr.map(sites, (site) =>
		rewriteQueryAt(description, site.path, (record) => at.edit(record, stored))
	)
}

/** A corruption whose sites are the records `sites` finds in the description, each rewritten by `breaks`. */
const atSites = (
	rule: RuleName,
	from: "stale" | "wild",
	sites: Edit["sites"],
	breaks: Edit["edit"],
	what: string,
	refusal: Refusal
): Corruption<Live, Refusal, RuleName> => ({
	rule,
	from,
	weight: 1,
	sites: (live) =>
		Arr.map(
			rewrittenAt(live.description, live.stored, { sites, edit: breaks }),
			(value, i): Broken<Refusal> => ({
				value,
				refusal,
				at: `${what} ${i}`
			})
		)
})

const rules = (q: Json | undefined): ReadonlyArray<Site> => collect(q, isRule)

/** A match of a relation parameter that binds none of its fields. */
const relationParamMatch = (name: string, heading: JsonRecord): JsonRecord => ({
	source: { kind: "param", name, heading },
	bindings: {}
})

/** A record whose array at `key` holds `items` after its own. */
const appendAt = (record: JsonRecord, key: string, items: ReadonlyArray<Json>): JsonRecord => ({
	...record,
	[key]: [...arrayOf(record[key], `a chosen site's ${key} are an array`), ...items]
})

/** A rule that also matches `matches`. */
const withMatches = (rule: JsonRecord, matches: ReadonlyArray<JsonRecord>): JsonRecord =>
	appendAt(rule, "matches", matches)

/** A variable a match binds to a field of a key kind: the variable, the field's kind and its type. */
interface KeyVar {
	readonly variable: string
	readonly kind: KeyKind
	readonly type: ScalarType
}

/** The variables a match of a stored relation binds to fields of a key kind, in its bindings' order. */
const keyVarsOf = (match: Json, stored: ReadonlyArray<Stored>): ReadonlyArray<KeyVar> => {
	const source = isRecord(match) ? match["source"] : undefined
	const bindings = isRecord(match) ? match["bindings"] : undefined
	if (!isRecord(source) || source["kind"] !== "relation" || !isRecord(bindings)) {
		return []
	}
	const relation = Arr.findFirst(stored, (r) => r.name === source["name"])
	const entries = Record.toEntries(bindings)
	return Arr.flatMap(entries, ([name, term]) => {
		const field = Option.flatMap(relation, (r) => Arr.findFirst(r.fields, (f) => f.name === name))
		const kind = Option.flatMap(field, (f) => Arr.findFirst(keyKinds, (k) => k === f.kind))
		return isRecord(term) &&
			term["kind"] === "var" &&
			typeof term["var"] === "string" &&
			Option.isSome(field) &&
			Option.isSome(kind)
			? [{ variable: term["var"], kind: kind.value, type: field.value.type }]
			: []
	})
}

/**
 * A variable a rule binds to a field of a key kind (program.ts keyKinds), which equality compares with a parameter of
 * the field's type, from its matches of stored relations; undefined where it binds none.
 */
const comparableVar = (rule: JsonRecord, stored: ReadonlyArray<Stored>): KeyVar | undefined => {
	const matches = rule["matches"]
	return isJsonArray(matches) ? Arr.flatMap(matches, (m) => keyVarsOf(m, stored))[0] : undefined
}

/** The field descriptor, as a Description spells it, of a field of a key kind: a compared parameter's declared type. */
const keyFieldDesc = (key: KeyVar): JsonRecord => {
	switch (key.kind) {
		case "int4":
			return { kind: "pg", type: "integer" }
		case "int8":
			return { kind: "pg", type: "bigint" }
		case "bool":
			return { kind: "pg", type: "boolean" }
		case "float8":
			return { kind: "pg", type: "double precision" }
		case "uuid":
			return { kind: "uuid" }
		case "fixed": {
			const typmod = defined(numericTypmodOf(key.type), "a fixed field's typmod")
			return { kind: "numeric", precision: typmod.precision, scale: typmod.scale }
		}
		case "text": {
			const regex = defined(textOf(key.type), "a text field's refinement").regex
			return regex === "wildcard"
				? { kind: "text", source: "^.*$", flags: "su" }
				: { kind: "text", source: regex.source, flags: regex.flags }
		}
		case "handle":
			return { kind: "closedId", roster: defined(rosterOf(key.type), "a handle's roster").closed }
		case "vector":
			return {
				kind: "vector",
				dimensions: defined(vectorTypmodOf(key.type), "a vector field's dimensions").dims
			}
	}
}

/** A parameter compared with `key`'s variable, declared at the field's type. */
const keyParam = (key: KeyVar, name: string): JsonRecord => ({
	kind: "param",
	name,
	type: keyFieldDesc(key)
})

/** The arms of the root's own rules stage that bind a variable a comparison with a parameter can read. */
const comparableRootArms = (
	q: Json | undefined,
	stored: ReadonlyArray<Stored>
): ReadonlyArray<Site> => {
	const stage = rootStage(q)
	return stage?.record["kind"] === "rules"
		? Arr.filter(armSites(stage), (arm) => comparableVar(arm.record, stored) !== undefined)
		: []
}

/**
 * A rule with `variable = name` planted in its where, a parameter of the variable's field type compared on the right: the
 * precondition of a break or rewrite that reads a compared parameter, planted rather than left to the generator's rate
 * of drawing one.
 */
const withComparison = (
	rule: JsonRecord,
	stored: ReadonlyArray<Stored>,
	name: string
): JsonRecord => {
	const key = defined(
		comparableVar(rule, stored),
		"a chosen rule binds a variable a comparison can read"
	)
	return appendAt(rule, "where", [
		{
			kind: "compare",
			op: "eq",
			left: { kind: "var", var: key.variable },
			right: keyParam(key, name)
		}
	])
}

/** A rules stage whose first arm also matches the imported query `imported`, binding none of its columns. */
const withImport = (stage: JsonRecord, imported: JsonRecord): JsonRecord => {
	const [first, ...rest] = arrayOf(stage["arms"], "a rules stage's arms are an array")
	return {
		...stage,
		arms: [
			withMatches(recordOf(first, "a rules stage has an arm"), [
				{ source: imported, bindings: {} }
			]),
			...rest
		]
	}
}

/** The variables a rule declares. */
const declaredVars = (rule: JsonRecord): ReadonlyArray<string> => {
	const vars = rule["vars"]
	return isJsonArray(vars)
		? Arr.flatMap(vars, (v) => (isRecord(v) && typeof v["id"] === "string" ? [v["id"]] : []))
		: []
}

/** Whether a stored relation's field holds a span. */
const isSpanField = (
	stored: ReadonlyArray<Stored>,
	relation: Json | undefined,
	field: Json | undefined
): boolean =>
	Arr.some(
		stored,
		(r) =>
			r.name === relation &&
			Arr.some(r.fields, (f) => f.name === field && (f.kind === "span4" || f.kind === "span8"))
	)

/** The first variable a rule declares over a stored span field. */
const spanVar = (rule: JsonRecord, stored: ReadonlyArray<Stored>): string | undefined => {
	const vars = rule["vars"]
	for (const v of isJsonArray(vars) ? vars : []) {
		const origin = isRecord(v) ? v["origin"] : undefined
		if (
			isRecord(v) &&
			typeof v["id"] === "string" &&
			isRecord(origin) &&
			isSpanField(stored, origin["relation"], origin["field"])
		) {
			return v["id"]
		}
	}
	return undefined
}

const corruptions: Arr.NonEmptyReadonlyArray<Corruption<Live, Refusal, RuleName>> = [
	atSites(
		"stageKind",
		"wild",
		(q) => collect(q, (v) => typeof v["kind"] === "string" && ("arms" in v || "input" in v)),
		(stage) => ({ ...stage, kind: "bogus" }),
		"stage",
		malformed
	),
	atSites("dropHead", "wild", rules, (rule) => Record.remove(rule, "head"), "rule", malformed),
	atSites(
		"dropMatches",
		"wild",
		rules,
		(rule) => Record.remove(rule, "matches"),
		"rule",
		malformed
	),
	atSites("dropVars", "wild", rules, (rule) => Record.remove(rule, "vars"), "rule", malformed),
	atSites("wrongType", "wild", rules, (rule) => ({ ...rule, matches: 7 }), "rule", malformed),
	atSites(
		"compareOp",
		"wild",
		(q) => collect(q, (v) => v["kind"] === "compare"),
		(compare) => ({ ...compare, op: "like" }),
		"comparison",
		malformed
	),
	atSites(
		"ghostVar",
		"stale",
		(q) => collect(q, (v) => v["kind"] === "var" && typeof v["var"] === "string"),
		(use) => ({ ...use, var: "ghost" }),
		"variable use",
		malformed
	),
	atSites(
		"duplicateVar",
		"wild",
		(q) =>
			Arr.filter(rules(q), (r) => isJsonArray(r.record["vars"]) && r.record["vars"].length > 0),
		(rule) => {
			const vars = arrayOf(rule["vars"], "a chosen rule's vars are an array")
			const [first] = vars
			if (first === undefined) {
				throw new Error("a chosen rule declares a variable")
			}
			return { ...rule, vars: [...vars, first] }
		},
		"rule",
		malformed
	),
	...Arr.map(
		[
			["selfSource", { kind: "self" }],
			["deltaSource", { kind: "delta", side: "added", relation: "Relation" }],
			["rowSource", { kind: "row", heading: { f: { kind: "uuid" } } }],
			["unknownRelation", { kind: "relation", name: "NoSuchRelation" }],
			["undeclaredInterior", { kind: "interior", id: "nope" }]
		] as const,
		([rule, source]) =>
			atSites(
				rule,
				rule === "unknownRelation" || rule === "undeclaredInterior" ? "wild" : "stale",
				(q) => {
					const steps = rule === "selfSource" ? stepMatches(q) : []
					return Arr.filter(
						collect(q, isMatch),
						(m) => !Arr.some(steps, (s) => samePath(s.path, m.path))
					)
				},
				(match) => ({ ...match, source }),
				"match",
				malformed
			)
	),
	...Arr.map(
		[
			["parentVar", malformed],
			["pageParentVar", attachedPage]
		] as const,
		([rule, refusal]) =>
			atSites(
				rule,
				"stale",
				(q) => {
					const top = rootRule(q)
					const read =
						refusal.boundary !== "page" ||
						(isRecord(q) && isRecord(q["stage"]) && q["stage"]["kind"] === "order")
					return top === undefined || !read ? [] : [top]
				},
				(top) =>
					rewriteAt(top, ["head"], (head) => ({
						...head,
						parentRead: { kind: "parent", column: "column" }
					})),
				"the root rule",
				refusal
			)
	),
	{
		rule: "foreignVar",
		from: "stale",
		weight: 1,
		sites: (live) => {
			const all = rules(live.description)
			return Arr.flatMap(all, (rule, i): ReadonlyArray<Broken<Refusal>> => {
				const own = new Set(declaredVars(rule.record))
				const [foreign] = Arr.flatMap(all, (other, j) =>
					j === i ? [] : Arr.filter(declaredVars(other.record), (v) => !own.has(v))
				)
				const use = headVar(rule.record)
				if (foreign === undefined || use === undefined) {
					return []
				}
				return [
					{
						value: rewriteQueryAt(live.description, [...rule.path, ...use.path], (term) => ({
							...term,
							var: foreign
						})),
						refusal: malformed,
						at: `the head of rule ${i}`
					}
				]
			})
		}
	},
	...Arr.map(
		[
			["fieldReference", { kind: "field", field: "id" }],
			["valueReference", { kind: "value" }]
		] as const,
		([rule, term]) =>
			atSites(
				rule,
				"wild",
				(q) => collect(q, (v) => v["kind"] === "compare" && isRecord(v["right"])),
				(compare) => ({ ...compare, right: term }),
				"comparison",
				malformed
			)
	),
	atSites(
		"unknownField",
		"wild",
		(q) =>
			collect(
				q,
				(v) =>
					isRecord(v["source"]) && v["source"]["kind"] === "relation" && isRecord(v["bindings"])
			),
		(match) =>
			rewriteAt(match, ["bindings"], (bindings) => ({
				...bindings,
				noSuchField: { kind: "literal", value: 1 }
			})),
		"match",
		malformed
	),
	atSites(
		"orderColumn",
		"wild",
		(q) => collect(q, (v) => v["kind"] === "order" && isJsonArray(v["order"])),
		(order) => ({ ...order, order: [{ column: "noSuchColumn", dir: "asc" }] }),
		"order",
		malformed
	),
	...Arr.map([0, -3], (k) =>
		atSites(
			"takeBound",
			"wild",
			(q) => collect(q, (v) => v["kind"] === "take" && isRecord(v["take"])),
			(take) => ({ ...take, take: { kind: "literal", k } }),
			`take of ${k}`,
			malformed
		)
	),
	atSites(
		"takeBoundPastInt4",
		"wild",
		(q) => collect(q, (v) => v["kind"] === "take" && isRecord(v["take"])),
		(take) => ({ ...take, take: { kind: "literal", k: 2147483648 } }),
		"take",
		malformed
	),
	atSites(
		"emptyRelationParam",
		"wild",
		rules,
		(rule) => withMatches(rule, [relationParamMatch("nothing", {})]),
		"rule",
		malformed
	),
	atSites(
		"relationParamRetyped",
		"wild",
		rules,
		(rule) =>
			withMatches(rule, [
				relationParamMatch("rp", { f: { kind: "uuid" } }),
				relationParamMatch("rp", { f: { kind: "pg", type: "bigint" } })
			]),
		"rule",
		malformed
	),
	atSites(
		"scalarParamAsRelation",
		"stale",
		comparableRootArms,
		(arm, stored) =>
			withMatches(withComparison(arm, stored, "p9003"), [
				relationParamMatch("p9003", { id: { kind: "uuid" } })
			]),
		"arm",
		malformed
	),
	atSites(
		"paramWithoutType",
		"wild",
		(q) =>
			Arr.filter(
				singlePlainArms(q),
				(arm) => isRecord(arm.record["head"]) && !("p9001" in arm.record["head"])
			),
		(arm) =>
			rewriteAt(arm, ["head"], (head) => ({ ...head, p9001: { kind: "param", name: "p9001" } })),
		"arm",
		malformed
	),
	atSites(
		"missingDiscriminant",
		"wild",
		(q) =>
			Arr.filter(stagesOf(q, "rules"), (stage) => {
				const arms = stage.record["arms"]
				const first = isJsonArray(arms) ? arms[0] : undefined
				return (
					isRecord(first) &&
					plainHead(first) &&
					headVar(first) !== undefined &&
					isRecord(first["head"]) &&
					!("extra" in first["head"])
				)
			}),
		(stage) => {
			const [first] = arrayOf(stage["arms"], "a chosen stage's arms are an array")
			const term = isRecord(first) ? headVar(first) : undefined
			if (!isRecord(first) || term === undefined) {
				throw new Error("a chosen stage's first arm delivers a variable")
			}
			const other = rewriteAt(first, ["head"], (head) => ({ ...head, extra: term.record }))
			return { ...stage, arms: [first, other] }
		},
		"rules stage",
		{ reason: "MissingDiscriminant", boundary: "description" }
	),
	atSites(
		"allenEmptyMask",
		"wild",
		(q) => collect(q, (v) => v["kind"] === "allen"),
		(allen) => ({ ...allen, mask: 0 }),
		"Allen relation",
		malformed
	),
	atSites(
		"allenLiteralSpan",
		"wild",
		(q) => collect(q, (v) => v["kind"] === "allen"),
		(allen) => ({ ...allen, left: { kind: "literal", value: 1 } }),
		"Allen relation",
		malformed
	),
	atSites(
		"allenParamSpan",
		"wild",
		(q) => collect(q, (v) => v["kind"] === "allen"),
		(allen) => ({ ...allen, left: { kind: "param", name: "w", type: { kind: "uuid" } } }),
		"Allen relation",
		malformed
	),
	{
		rule: "twoSpanProducers",
		from: "wild",
		weight: 1,
		sites: (live) =>
			Arr.flatMap(singlePlainArms(live.description), (arm, i): ReadonlyArray<Broken<Refusal>> => {
				const v = spanVar(arm.record, live.stored)
				if (v === undefined) {
					return []
				}
				const pack: JsonRecord = { kind: "producer", fn: "pack", args: [{ kind: "var", var: v }] }
				return [
					{
						value: rewriteQueryAt(live.description, [...arm.path, "head"], (head) => ({
							...head,
							packed: pack,
							packedAgain: pack
						})),
						refusal: { reason: "UnsupportedOperation", boundary: "description" },
						at: `the head of arm ${i}`
					}
				]
			})
	},
	atSites(
		"attachedLikeParent",
		"wild",
		(q) => Arr.filter(stagesOf(q, "attach"), (stage) => Option.isSome(parentColumn(stage.record))),
		(stage) => {
			const column = parentColumn(stage)
			if (Option.isNone(column)) {
				throw new Error("a chosen attachment's parent delivers a column")
			}
			return rewriteAt(stage, ["attach"], (attach) => ({ ...attach, name: column.value }))
		},
		"attach stage",
		malformed
	),
	atSites(
		"attachedTwice",
		"wild",
		(q) => stagesOf(q, "attach"),
		(stage) => ({ ...stage, input: stage }),
		"attach stage",
		malformed
	),
	atSites(
		"negationInDisjunction",
		"wild",
		(q) => Arr.filter(rules(q), (rule) => relationMatch(rule.record) !== undefined),
		(rule) => {
			const m = relationMatch(rule)
			if (m === undefined) {
				throw new Error("a chosen rule matches a stored relation")
			}
			const negation: JsonRecord = { kind: "absent", source: m.source, bindings: m.bindings }
			return appendAt(rule, "where", [{ kind: "or", args: [negation, negation] }])
		},
		"rule",
		{ reason: "UnsupportedOperation", boundary: "description" }
	),
	atSites(
		"incompleteBindMap",
		"stale",
		(q) => {
			const stage = rootStage(q)
			return stage?.record["kind"] === "rules" && ownParams(stage.record).length > 0 ? [stage] : []
		},
		(stage) => withImport(stage, { kind: "query", query: { stage }, bind: {} }),
		"the root's rules",
		malformed
	),
	atSites(
		"extraBindEntry",
		"wild",
		(q) => {
			const stage = rootStage(q)
			return stage?.record["kind"] === "rules" && ownParams(stage.record).length === 0
				? [stage]
				: []
		},
		(stage) =>
			withImport(stage, {
				kind: "query",
				query: { stage },
				bind: { p9002: { kind: "literal", value: 1 } }
			}),
		"the root's rules",
		malformed
	),
	{
		rule: "memberHeading",
		from: "stale",
		weight: 1,
		/**
		 * A plain set's description written into a relation whose fields are not its heading: names or types differ.
		 * The member's rules are checked first, typed against the relation (check/index.ts checkMember runs them before
		 * checkMemberHeading): an untyped literal the head writes takes its field's type (check/member.ts), and
		 * CheckedSchema.literal (analysis/schema.ts) refuses it there as MalformedDescription (no value of the base, as a
		 * bigint for int4), UnsupportedOperation (membership not evaluable) or ContractLiteral (the field's regex or
		 * contract refuses it). A member none of whose head literals is refused reaches the heading.
		 */
		sites: (live) => {
			const q = live.read.query
			const fields = live.relation.fields
			const same =
				q.heading.length === fields.length &&
				Arr.every(q.heading, (c) =>
					Arr.some(fields, (f) => f.name === c.name && sameScalarType(f.type, c.type))
				)
			const plain =
				q.attachments.length === 0 && q.delivery.kind === "set" && q.bound.kind === "set"
			if (!plain || same) {
				return []
			}
			const desc = ok(fromQueryDescription(live.description), "the live description")
			/**
			 * The first refusal the member's head literals meet, in the checker's order (arms below unions first, then
			 * head keys in order): CheckedSchema.literal (analysis/schema.ts) types an untyped head literal by its target
			 * field and refuses it MalformedDescription (no value of the base), UnsupportedOperation (membership not
			 * evaluable) or ContractLiteral (the field's regex or contract refuses it), all before the heading comparison.
			 */
			const checkedSchema = checking(live.schema)
			const headTerms = Arr.flatMap(headArms(desc.stage), (arm) => Record.toEntries(arm.head))
			const literalRefusal = Arr.flatMap(headTerms, ([name, term]) => {
				const field = Arr.findFirst(fields, (f) => f.name === name)
				if (Option.isNone(field) || term.kind !== "literal" || term.type !== undefined) {
					return []
				}
				const typed = catchRefusal(() =>
					checkedSchema.literal(term.value, field.value.type, SourceLoc(name, []))
				)
				return !typed.ok ? [typed.error.reason._tag] : []
			})[0]
			return [
				{
					value: live.description,
					refusal: {
						reason: literalRefusal ?? "DescribedHeadingMismatch",
						boundary: "member"
					},
					at: `a member of ${live.relation.name}`
				}
			]
		}
	}
]

const rulesRequired: ReadonlyArray<Feature> = [
	...new Set(Arr.map(corruptions, (c): Feature => `${c.from} ${c.rule}`))
]

/**
 * A faithful rewrite of a live description, which its boundary must still admit at every site where it applies: the
 * checker's (describedQuery), or the builder's, which also records the Description it read.
 */
interface Rewrite extends Edit {
	readonly feature: Rewritten
	readonly boundary: "description" | "builder"
}

/** The arms of every rules stage. */
const ruleArms = (q: Json | undefined): ReadonlyArray<Site> =>
	Arr.flatMap(stagesOf(q, "rules"), armSites)

/** The index of a rule's first relational negation among its filters, if it has one. */
const negationAt = (rule: JsonRecord): Option.Option<number> => {
	const where = rule["where"]
	return isJsonArray(where)
		? Arr.findFirstIndex(where, (w) => isRecord(w) && w["kind"] === "absent")
		: Option.none()
}

const rewrites: ReadonlyArray<Rewrite> = [
	{
		feature: "live literal holding U+0001",
		boundary: "builder",
		sites: (q) => collect(q, (v) => v["kind"] === "literal" && typeof v["value"] === "string"),
		edit: (literal) => ({ ...literal, value: "\u0001" })
	},
	{
		feature: "live negation conjoined with a comparison",
		boundary: "description",
		sites: (q) =>
			Arr.filter(
				ruleArms(q),
				(arm) => Option.isSome(negationAt(arm.record)) && headVar(arm.record) !== undefined
			),
		edit: (arm) => {
			const term = headVar(arm)
			const at = negationAt(arm)
			if (term === undefined || Option.isNone(at)) {
				throw new Error("a chosen arm negates and delivers a variable")
			}
			return rewriteAt(arm, ["where", at.value], (negation) => ({
				kind: "and",
				args: [negation, { kind: "compare", op: "eq", left: term.record, right: term.record }]
			}))
		}
	},
	{
		feature: "live head param a comparison types",
		boundary: "description",
		sites: (q, stored) => {
			const [arm] = comparableRootArms(q, stored)
			const arms = rootStage(q)?.record["arms"]
			const single = isJsonArray(arms) && arms.length === 1
			return single &&
				arm !== undefined &&
				plainHead(arm.record) &&
				isRecord(arm.record["head"]) &&
				!("echoed" in arm.record["head"])
				? [arm]
				: []
		},
		edit: (arm, stored) =>
			rewriteAt(withComparison(arm, stored, "p9004"), ["head"], (head) => ({
				...head,
				echoed: keyParam(defined(comparableVar(arm, stored), "a comparable variable"), "p9004")
			}))
	}
]

/** A rewritten live description, admitted by `boundary`. */
const admitted = (
	boundary: Rewrite["boundary"],
	value: Json,
	schema: unknown,
	label: string
): void => {
	switch (boundary) {
		case "description":
			ok(describedQuery(value, checking(schema), checkOptions("query")), label)
			return
		case "builder": {
			const read = ok(fromQueryDescription(value), label)
			const rebuilt = ok(queryFromDesc(read, schema), label)
			assert.equal(
				text(defined(queryValueDesc(rebuilt), `${label} records a Description`)),
				text(read)
			)
			return
		}
	}
}

/** Every rewrite of a live description at every site, admitted by its boundary. */
const admitsRewrites = (
	description: Json,
	schema: unknown,
	stored: ReadonlyArray<Stored>,
	note: Case<Feature>["note"]
): void => {
	for (const rewrite of rewrites) {
		for (const [i, rewritten] of rewrittenAt(description, stored, rewrite).entries()) {
			note(rewrite.feature)
			admitted(rewrite.boundary, rewritten, schema, `${rewrite.feature} at site ${i}`)
		}
	}
}

/** What a boundary answers for a corrupted description. */
const refusedAt = (
	boundary: Refusal["boundary"],
	value: unknown,
	schema: unknown,
	relation: Stored
): Result.Result<unknown, CompileError> => {
	switch (boundary) {
		case "description":
			return describedQuery(value, checking(schema), checkOptions("query"))
		case "page":
			return describedQuery(value, checking(schema), { ...checkOptions("query"), read: "page" })
		case "member":
			return Result.flatMap(fromQueryDescription(value), (query) =>
				checkMemberOf(
					checking(schema),
					{ op: "insert", relation: relation.name, member: { kind: "query", query } },
					{}
				)
			)
	}
}

/** The live artifact of one query read of a case, and the Description the builder records for it. */
const liveOf = (
	c: ProgramCase,
	read: QueryRead
): { readonly live: Live; readonly desc: QueryDesc } => {
	const built = buildSchema(c.schema)
	const input = ok(queryInput(buildRoot(built, built.schema, read.query)), "the builder")
	const description = ok(toQueryDescription(input.desc), "toQueryDescription")
	return {
		live: {
			description,
			read,
			relation: c.schema.relations[0],
			stored: c.schema.relations,
			schema: built.schema
		},
		desc: input.desc
	}
}

/**
 * One query read: the live description round-trips to the same IR, and a corrupted one is refused with its rule's reason.
 * Whether the read is live or broken, and at which rule and site, is drawn from the case's decisions against the
 * read's own sites.
 */
const roundTrip = (
	c: ProgramCase,
	read: QueryRead,
	draw: Case<Feature>["draw"],
	note: Case<Feature>["note"]
): void => {
	const { live, desc } = liveOf(c, read)
	const { description, relation, schema } = live
	const first = ok(checkQuery(checking(schema), desc, checkOptions("query")), "check")
	const corrupted = draw(corruptedGen(live, corruptions))
	note(corruptedFeature(corrupted))
	if (corrupted.kind === "live") {
		const transported = trustedJson<Json>(jsonText(description))
		const back = ok(
			describedQuery(transported, checking(schema), checkOptions("query")),
			"describedQuery"
		)
		assert.equal(text(back), text(desc))
		const rebuilt = ok(queryFromDesc(back, schema), "queryFromDesc")
		assert.equal(
			text(defined(queryValueDesc(rebuilt), "the rebuilt query records a Description")),
			text(desc)
		)
		assert.deepEqual(
			normalized(ok(checkQuery(checking(schema), back, checkOptions("query")), "the second check")),
			normalized(first)
		)
		admitsRewrites(description, schema, c.schema.relations, note)
		return
	}
	const label = `${corrupted.kind} ${corrupted.rule} at ${corrupted.at}`
	const refused = refusedAt(corrupted.refusal.boundary, corrupted.value, schema, relation)
	assert.ok(!refused.ok, `${label} was accepted`)
	assert.equal(
		refused.error.reason._tag,
		corrupted.refusal.reason,
		`${label}: ${refused.error.message}`
	)
	assert.ok(formatLoc(refusalLoc(refused.error)).length > 0, `${label} has no location`)
}

/** A case of the draw: one the public generator resolves from its sketch, or one written by hand. */
type CaseSource =
	| { readonly kind: "drawn"; readonly sketch: CaseSketch }
	| { readonly kind: "planted"; readonly case: ProgramCase }

/** The case a source stands for: a drawn sketch resolved from the case's decisions, or the planted case itself. */
const caseOf = (source: CaseSource, draw: Case<Feature>["draw"]): ProgramCase =>
	source.kind === "drawn" ? draw(resolveCase(source.sketch)) : source.case

const makeField = (
	name: string,
	kind: ProgramField["kind"],
	type: ProgramField["type"]
): ProgramField => ({
	name,
	kind,
	type
})

/**
 * A schema of one relation, Slot(k integer, during span over integer) keyed by k, and one ordered read over it: Slot{k,
 * during} and Slot{during}, k equal to a literal and the two spans in an Allen relation, finding k. The generated cases
 * hold a span field, an Allen relation and a single plain arm over a span variable together a few times a run, so the
 * corruptions of those sites are rare there.
 */
const spanCase: ProgramCase = (() => {
	const k = makeField("k", "int4", scalarOfSpec({ carrier: "int4" }))
	const during = makeField("during", "span4", scalarOfSpec({ carrier: "range4" }))
	const slot: Stored = {
		kind: "stored",
		name: "Slot",
		fields: [k, during],
		primaryKey: [k],
		candidates: []
	}
	const handles = ["Low", "High"] as const
	const level = makeField(
		"id",
		"handle",
		scalarOfSpec({ carrier: "enum", roster: { closed: "Level", handles: [...handles] } })
	)
	const key: Var = { id: 0, field: k }
	const first: Var = { id: 1, field: during }
	const second: Var = { id: 2, field: during }
	const column = { name: "k", type: k.type }
	const read: ProgramRead = {
		kind: "query",
		query: {
			heading: [column],
			arms: [
				{
					matches: [
						{
							source: slot,
							bindings: [
								{ field: k, operand: { kind: "var", var: key } },
								{ field: during, operand: { kind: "var", var: first } }
							]
						},
						{ source: slot, bindings: [{ field: during, operand: { kind: "var", var: second } }] }
					],
					where: [
						{ op: "eq", left: key, right: { kind: "literal", literal: { kind: "int", value: 1n } } }
					],
					between: [],
					inSets: [],
					allens: [{ left: first, mask: allenBit("overlaps"), right: second }],
					pointIns: [],
					connectives: [],
					negations: [],
					head: [{ kind: "var", name: column.name, var: key }]
				}
			],
			bound: { kind: "set" },
			stage: { kind: "unnamed" },
			attachments: [],
			delivery: { kind: "ordered", order: [{ column, dir: "asc" }], pageSize: 10 }
		},
		params: [],
		relations: [],
		probe: { kind: "none" }
	}
	return {
		schema: {
			relations: [slot],
			roster: { kind: "roster", name: "Level", handles: [...handles], id: level },
			nameKinds: new Set()
		},
		facts: new Map(),
		perturbation: unperturbed,
		ambient: ordinarySession,
		restorage: { shift: 0, respell: 0 },
		reads: [read]
	}
})()

/**
 * The draws that break `rule` at its first site in a case's first query read, as the library's corrupted draws them:
 * the broken arm's first decision, the rule's place among the rules with a site there, and the first site, each
 * decision with one possible value drawing nothing.
 */
const breaking = (c: ProgramCase, rule: RuleName): string => {
	const [read] = c.reads
	if (read.kind !== "query") {
		throw new Error("a planted case's first read is a query")
	}
	const { live } = liveOf(c, read)
	const applicable = Arr.filter(corruptions, (k) => k.sites(live).length > 0)
	const at = Option.getOrThrowWith(
		Arr.findFirstIndex(applicable, (k) => k.rule === rule),
		() => new Error(`no applicable corruption ${rule}`)
	)
	const sites = defined(applicable[at], `the corruption ${rule}`).sites(live)
	const values = [1, ...(applicable.length > 1 ? [at] : []), ...(sites.length > 1 ? [0] : [])]
	return tokenOf(Float64Array.from(values), values.length)
}

/**
 * Planted: the span case live, so its description round-trips and each refusal below is its break's alone, and broken
 * at each rule its span, Allen, comparison and ordered root sites admit. The live case draws the corruption's live arm.
 */
const keptBreaks: ReadonlyArray<Kept<CaseSource, Feature>> = [
	{
		note: "the span case live",
		sketch: { kind: "planted", case: spanCase },
		draws: "0",
		reaches: ["live"]
	},
	...Arr.map(
		[
			"twoSpanProducers",
			"allenLiteralSpan",
			"allenParamSpan",
			"allenEmptyMask",
			"compareOp",
			"pageParentVar"
		] as const,
		(rule): Kept<CaseSource, Feature> => {
			const { from } = Option.getOrThrowWith(
				Arr.findFirst(corruptions, (k) => k.rule === rule),
				() => new Error(`no corruption ${rule}`)
			)
			return {
				note: `the span case broken at ${rule}`,
				sketch: { kind: "planted", case: spanCase },
				draws: breaking(spanCase, rule),
				reaches: [`${from} ${rule}`]
			}
		}
	)
]

/** A drawn case, by the public generator's sketch. */
const drawnCase: Gen<CaseSource> = (source) => ({
	kind: "drawn",
	sketch: source.draw(caseSketchGen)
})

/** Every query read of a case round-trips, or is refused with its corruption's reason. */
const roundTrips = (
	c: ProgramCase,
	draw: Case<Feature>["draw"],
	note: Case<Feature>["note"]
): void => {
	for (const read of c.reads) {
		if (read.kind === "query") {
			roundTrip(c, read, draw, note)
		}
	}
}

describe("generated queries round-trip through their descriptions", () => {
	it.effect(
		"a live description reads back as the same Description and IR, and a broken one is refused with its rule's reason",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/check/roundtrip",
						draw: drawn(drawnCase),
						literal: Formatter.format,
						coverage: required<Feature>(
							["live", ...Arr.map(rewrites, (r) => r.feature), ...rulesRequired],
							{ cases: 800, sense: notesOnly }
						),
						kept: keptBreaks,
						runs: 800,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(source, k) =>
						Effect.sync(() => {
							const c = caseOf(source, k.draw)
							try {
								roundTrips(c, k.draw, k.note)
							} catch (e) {
								throw new Error(`${messageOf(e)}\n${printCase(c)}`, { cause: e })
							}
						})
				)
			)
	)
})
