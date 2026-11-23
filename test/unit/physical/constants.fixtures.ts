/** What the properties of constants.test.ts read: its spaces, models and helpers. */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { TupleSet } from "@bjornpagen/grizzle-text/base/tuple-map"
import { assert, defined } from "@bjornpagen/testing/assert"
import { boolean, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import {
	admitLoginRoles,
	decodeRoleOver,
	type FieldDesc,
	type SchemaDesc
} from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { fullRoleDesc, type Owned, ownLogin } from "#compiler/schema/own.ts"
import type {
	Expr,
	FunctionName,
	LiteralValue,
	ObjectName,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { succeeded } from "#test/support/assert.ts"
import { textOfHex } from "#test/support/closed/bit-text.ts"
import {
	codebookOfStates,
	historiesGen,
	holesOf,
	liveOf,
	type ModelSlot,
	type RosterHistory,
	type RosterState
} from "#test/support/closed/generate.ts"
import {
	closed,
	closedRelation,
	decodedSchema,
	f,
	relation
} from "#test/support/fixtures/ir/desc.ts"
import { upTo } from "#test/support/up-to.ts"

/** A generated world: its rosters' histories, the rosters a set field of Item is typed over, and its closed relation. */
interface World {
	readonly rosters: Arr.NonEmptyReadonlyArray<RosterHistory>
	readonly sets: ReadonlyArray<boolean>
	readonly closedPayload: boolean
}

export const worldGen: Gen<World> = (source) => {
	const rosters = source.draw(
		historiesGen(
			{ min: 1, max: 3 },
			{ handles: { min: 1, max: 4 }, migrations: { min: 0, max: 4 } }
		)
	)
	const nonEmpty = defined(Arr.isReadonlyArrayNonEmpty(rosters) ? rosters : undefined, "a roster")
	return {
		rosters: nonEmpty,
		sets: Arr.map(nonEmpty, () => source.draw(boolean)),
		closedPayload: source.draw(boolean)
	}
}

export const states = (w: World): Arr.NonEmptyReadonlyArray<RosterState> =>
	Arr.map(w.rosters, (h) => h.state)

/** Item's closed-id field over roster i, and its set field. */
export const codeField = (i: number): string => `kind${i}`

export const setField = (i: number): string => `set${i}`

/** The world's schema: its rosters as their live handles declare them, Item, Tags, a set over the first roster alone,
 * and Grade, a closed relation keyed by the first roster, holding every live handle, with an integer or a closed-id
 * payload. */
export const schemaOf = (w: World): SchemaDesc => {
	const ss = states(w)
	const fields: Record<string, FieldDesc> = { id: f.uuid }
	for (const [i, s] of ss.entries()) {
		fields[codeField(i)] = f.closedId(s.closed)
		if (w.sets[i] === true) {
			fields[setField(i)] = { kind: "bits", roster: s.closed }
		}
	}
	const first = ss[0]
	const grade = closedRelation(
		"Grade",
		{
			kind: f.closedId(first.closed),
			score: w.closedPayload ? f.integer : f.closedId(first.closed)
		},
		["kind"],
		Arr.map(liveOf(first), (handle, at) => ({
			kind: handle,
			score: w.closedPayload ? at * 7 : handle
		}))
	)
	return decodedSchema({
		name: "World",
		relations: [
			...Arr.map(ss, (s) => closed.ordered(s.closed, liveOf(s))),
			relation("Item", fields, ["id"]),
			relation("Tags", { id: f.uuid, set: { kind: "bits", roster: first.closed } }, ["id"]),
			grade
		],
		statements: [],
		bases: []
	})
}

const loc = SourceLoc("constants test world", [])

/** The world's installation over its codes: a login with a full role, which writes Item, a reader, which only reads
 * it, and a tagger, which writes Tags, a set over the first roster and nothing else of it. */
export const installationOf = (owned: Owned, codes: Codebook): Installation => {
	const base = owned.desc
	const app = succeeded(fullRoleDesc(base, "app", loc))
	const reader = succeeded(
		decodeRoleOver(base, {
			name: "reader",
			relations: [{ kind: "whole", name: "Item", loc }],
			write: [],
			contexts: [],
			loc
		})
	)
	/** A role whose only use of a roster is a set: it calls live() through the bits domain's CHECK, and no names constant. */
	const tagger = succeeded(
		decodeRoleOver(base, {
			name: "tagger",
			relations: [{ kind: "whole", name: "Tags", loc }],
			write: ["Tags"],
			contexts: [],
			loc
		})
	)
	const login = succeeded(
		Result.flatMap(
			admitLoginRoles(base, { name: "desk", roles: [app, reader, tagger], loc }),
			ownLogin
		)
	)
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(owned, installationsOf(owned), [login], [], codes)
		)
	)
}

/** Whether a value is a plain object of the AST, whose fields a walk reads. */
const isNode = (v: unknown): v is Readonly<Record<string, unknown>> =>
	typeof v === "object" && v !== null && !Arr.isArray(v)

/** Every value inside `node` that `pick` reads, in a walk of plain data: the AST is plain objects and arrays. */
const collect = <A>(
	node: unknown,
	pick: (value: Readonly<Record<string, unknown>>) => A | undefined
): ReadonlyArray<A> => {
	const out: Array<A> = []
	const walk = (v: unknown): void => {
		if (Arr.isArray(v)) {
			for (const x of v) {
				walk(x)
			}
			return
		}
		if (!isNode(v)) {
			return
		}
		const found = pick(v)
		if (found !== undefined) {
			out.push(found)
		}
		for (const x of Rec.values(v)) {
			walk(x)
		}
	}
	walk(node)
	return out
}

/** The qualified functions a node calls, by identifier, in the installed schema. */
const callsIn = (schema: string, node: unknown): ReadonlySet<string> =>
	new Set(
		collect(node, (v) => {
			const fn = v["fn"]
			return v["kind"] === "call" &&
				isNode(fn) &&
				fn["kind"] === "qualified" &&
				fn["schema"] === schema &&
				typeof fn["name"] === "string"
				? fn["name"]
				: undefined
		})
	)

/** A constant the installation creates: a function returning one literal, or a closed relation's pack. */
type InstalledConstant = Extract<SqlStatement, { readonly kind: "createConstant" | "packConstant" }>

type Constants = ReadonlyMap<string, InstalledConstant>

/** Every constant the installation creates, by its function's identifier. */
export const constantsOf = (i: Installation): Constants =>
	new Map(
		Arr.flatMap(
			i.statements,
			(
				s
			): ReadonlyArray<
				readonly [
					string,
					Extract<SqlStatement, { readonly kind: "createConstant" | "packConstant" }>
				]
			> =>
				s.kind === "createConstant"
					? [[s.name.name, s]]
					: s.kind === "packConstant"
						? [[s.function.name, s]]
						: []
		)
	)

/** Every constant `called` names and every constant their bodies call, transitively. */
const closure = (
	constants: Constants,
	schema: string,
	called: Iterable<string>
): ReadonlySet<string> => {
	const out = new Set<string>()
	const reach = (name: string): void => {
		const c = constants.get(name)
		if (c === undefined || out.has(name)) {
			return
		}
		out.add(name)
		if (c.kind === "createConstant") {
			for (const next of callsIn(schema, c.body)) {
				reach(next)
			}
		}
	}
	for (const name of called) {
		reach(name)
	}
	return out
}

/**
 * A PostgreSQL array literal's elements, as array_in reads them: `{`, elements separated by commas, `}`; a quoted
 * element with backslash escapes; an unquoted one taken as is, NULL meaning no value. Written here, not shared with the
 * printer, so the printer's quoting is judged by a reader.
 */
const readArray = (text: string): ReadonlyArray<string | null> => {
	assert.ok(Str.startsWith("{")(text) && Str.endsWith("}")(text), `an array literal: ${text}`)
	const body = Str.slice(1, -1)(text)
	const out: Array<string | null> = []
	let at = 0
	if (body.length === 0) {
		return out
	}
	while (at <= body.length) {
		if (body[at] === '"') {
			let element = ""
			at += 1
			while (body[at] !== '"') {
				const ch = defined(body[at], "a closed quote")
				if (ch === "\\") {
					element += defined(body[at + 1], "an escaped character")
					at += 2
				} else {
					element += ch
					at += 1
				}
			}
			out.push(element)
			at += 1
		} else {
			const rest = Str.slice(at)(body)
			const raw = Option.match(Str.indexOf(",")(rest), {
				onNone: () => rest,
				onSome: (end) => Str.slice(0, end)(rest)
			})
			out.push(raw === "NULL" ? null : raw)
			at += raw.length
		}
		assert.ok(at === body.length || body[at] === ",", `an element boundary at ${at} in ${text}`)
		at += 1
	}
	return out
}

export type CreateDomainStatement = Extract<SqlStatement, { readonly kind: "createDomain" }>

/** The one CREATE DOMAIN of `name`, which no installation creates twice. */
const domainNamed = (i: Installation, name: string, what: string): CreateDomainStatement => {
	const domains = Arr.filter(
		i.statements,
		(st): st is CreateDomainStatement => st.kind === "createDomain" && st.name.name === name
	)
	assert.equal(domains.length, 1, `one domain for ${what}`)
	return defined(domains[0])
}

/**
 * A value a domain CHECK's terms take on the host, by PostgreSQL's rules for the terms these CHECKs are made of: an
 * integer, a name, an array of names, a bit string as its text of 0s and 1s, a truth value, or NULL.
 */
type HostValue =
	| { readonly kind: "int"; readonly value: number }
	| { readonly kind: "text"; readonly value: string }
	| { readonly kind: "names"; readonly value: ReadonlyArray<string | null> }
	| { readonly kind: "bits"; readonly value: string }
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "null" }

const nullValue: HostValue = { kind: "null" }

/** A constant's value as its body states it: an array literal's names, or a bit string's bits. */
const constantValueOf = (c: InstalledConstant): HostValue => {
	if (c.kind === "createConstant" && c.body.kind === "literal") {
		const value = c.body.value
		if (value.kind === "text") {
			return { kind: "names", value: readArray(value.value) }
		}
		if (value.kind === "bits") {
			return { kind: "bits", value: textOfHex(value.hex) }
		}
	}
	throw new Error(`a constant a domain CHECK reads: ${c.kind}`)
}

/** A literal's value on the host: an integer, a name, a bit string or a truth value, the literals these CHECKs hold. */
const literalValue = (literal: LiteralValue): HostValue => {
	switch (literal.kind) {
		case "int":
			return { kind: "int", value: Number(literal.value) }
		case "text":
			return { kind: "text", value: literal.value }
		case "bits":
			return { kind: "bits", value: textOfHex(literal.hex) }
		case "bool":
			return { kind: "bool", value: literal.value }
		case "decimal":
		case "float":
		case "floatSpecial":
			throw new Error(`a ${literal.kind} literal, which no roster or set domain's CHECK holds`)
	}
}

/**
 * A domain CHECK's term evaluated on the host at VALUE = `value`, by PostgreSQL's rules for the terms it is made of:
 * a literal, VALUE, a constant's call, get_bit of a bit string at a position from 0 (an error past either end, as
 * PostgreSQL's), a cast (which changes no value here), a subscript counted from 1 (NULL past either end), `+`, `&` of
 * two bit strings of one length, `=`, `<>`, `>=` and `<`, NULL where an operand is, AND, and a CASE that reads its
 * branches in order. Its own interpreter, sharing no code with the installer, so a CHECK is judged by what it admits,
 * whatever its shape.
 */
const evaluate = (e: Expr, value: HostValue, constants: Constants, schema: string): HostValue => {
	const recur = (x: Expr): HostValue => evaluate(x, value, constants, schema)
	switch (e.kind) {
		case "literal":
			return literalValue(e.value)
		case "domainValue":
			return value
		case "call": {
			if (e.fn.kind === "qualified" && e.fn.schema === schema) {
				return constantValueOf(defined(constants.get(e.fn.name), `the constant ${e.fn.name}`))
			}
			const [bits, at] = Arr.map(e.args, recur)
			if (
				e.fn.kind === "builtin" &&
				e.fn.name === "get_bit" &&
				bits?.kind === "bits" &&
				at?.kind === "int"
			) {
				const bit = bits.value[at.value]
				if (at.value < 0 || bit === undefined) {
					throw new Error(
						`get_bit at ${at.value} of a bit string of ${bits.value.length}, which PostgreSQL refuses`
					)
				}
				return { kind: "int", value: bit === "1" ? 1 : 0 }
			}
			throw new Error("a call of no constant of the installation")
		}
		case "case": {
			for (const w of e.whens) {
				const when = recur(w.when)
				if (when.kind === "bool" && when.value) {
					return recur(w.result)
				}
			}
			return recur(e.else)
		}
		case "and": {
			const args: ReadonlyArray<HostValue> = Arr.map(e.args, recur)
			const someFalse = Arr.some(args, (a) => a.kind === "bool" && !a.value)
			const someNull = Arr.some(args, (a) => a.kind === "null")
			return someFalse
				? { kind: "bool", value: false }
				: someNull
					? nullValue
					: { kind: "bool", value: true }
		}
		case "cast":
			return recur(e.expr)
		case "subscript": {
			const array = recur(e.array)
			const index = recur(e.index)
			return array.kind === "names" && index.kind === "int"
				? Option.match(Option.fromNullishOr(array.value[index.value - 1]), {
						onNone: () => nullValue,
						onSome: (name): HostValue => ({ kind: "text", value: name })
					})
				: nullValue
		}
		case "binary": {
			const l = recur(e.left)
			const r = recur(e.right)
			if (l.kind === "null" || r.kind === "null") {
				return nullValue
			}
			if (e.op === "+" && l.kind === "int" && r.kind === "int") {
				return { kind: "int", value: l.value + r.value }
			}
			if (
				e.op === "&" &&
				l.kind === "bits" &&
				r.kind === "bits" &&
				l.value.length === r.value.length
			) {
				return {
					kind: "bits",
					value: Arr.join(
						Arr.map(Str.split(l.value, ""), (bit, at) =>
							bit === "1" && r.value[at] === "1" ? "1" : "0"
						),
						""
					)
				}
			}
			if ((e.op === "=" || e.op === "<>") && l.kind === r.kind && l.kind !== "names") {
				const equal = l.value === r.value
				return { kind: "bool", value: e.op === "=" ? equal : !equal }
			}
			if ((e.op === ">=" || e.op === "<") && l.kind === "int" && r.kind === "int") {
				return { kind: "bool", value: e.op === ">=" ? l.value >= r.value : l.value < r.value }
			}
			throw new Error(`a ${l.kind} ${e.op} ${r.kind} a domain CHECK holds`)
		}
		case "column":
		case "excluded":
		case "returning":
		case "param":
		case "collate":
		case "negate":
		case "or":
		case "not":
		case "isTrue":
		case "between":
		case "inList":
		case "inQuery":
		case "equalsAny":
		case "exists":
		case "subquery":
		case "array":
		case "row":
		case "greatest":
		case "least":
		case "coalesce":
		case "mergeAction":
		case "plSpecial":
		case "field":
		case "complement":
		case "lowerAscii":
		case "nullif":
		case "plVar":
		case "regclass":
		case "user":
		case "clock":
			break
	}
	throw new Error(`a ${e.kind} term, which no roster or set domain's CHECK holds`)
}

/** Whether a domain admits VALUE = `value`: every one of its CHECKs is TRUE there. */
export const admits = (
	d: CreateDomainStatement,
	value: HostValue,
	constants: Constants,
	schema: string
): boolean =>
	Arr.every(d.constraints, (c) => {
		const judged = evaluate(c.predicate, value, constants, schema)
		return judged.kind === "bool" && judged.value
	})

/** The constants a domain's CHECKs read whose body is a bit string, by name: its roster's live-codes constant. */
const bitsRead = (
	d: CreateDomainStatement,
	constants: Constants,
	schema: string
): ReadonlyMap<string, string> =>
	new Map(
		Arr.flatMap([...callsIn(schema, d.constraints)], (fn) => {
			const read = constantValueOf(defined(constants.get(fn), `the constant ${fn}`))
			return read.kind === "bits" ? [[fn, read.value] as const] : []
		})
	)

/** Every names constant of an installation, by name: each constant whose body is an array of names. */
const namesConstants = (constants: Constants): ReadonlyMap<string, ReadonlyArray<string | null>> =>
	new Map(
		Arr.flatMap([...constants], ([fn, c]) => {
			const read =
				c.kind === "createConstant" && c.body.kind === "literal" && c.body.value.kind === "text"
					? constantValueOf(c)
					: nullValue
			return read.kind === "names" ? [[fn, read.value] as const] : []
		})
	)

/**
 * A roster's domain, the codes it admits from one below 0 to one past every code minted and at 400, the mixed-radix
 * alias; the live-codes constants its CHECKs read; and the installation's names constants holding the roster's names in
 * code order, which a view's decoded column reads.
 */
export const rosterObjects = (i: Installation, s: RosterState) => {
	const schema = i.names.schema
	const constants = constantsOf(i)
	const domain = domainNamed(i, i.names.rosterDomain(s.closed).name, `roster ${s.closed}`)
	assert.ok(
		domain.base.kind === "builtin" && domain.base.name === "smallint",
		"a roster domain over smallint"
	)
	const admitted = Arr.filter([...upTo(s.slots.length + 2, (i) => i - 1), 400], (code) =>
		admits(domain, { kind: "int", value: code }, constants, schema)
	)
	return { live: bitsRead(domain, constants, schema), names: namesConstants(constants), admitted }
}

/** What each role holds, read from the grants the installation states. */
interface RoleGrants {
	readonly role: string
	readonly execute: ReadonlySet<string>
	readonly domains: ReadonlySet<string>
	readonly writes: ReadonlySet<string>
	/** Each view it reads, by schema and name: its relations' whole views and its query entries' own. */
	readonly views: TupleSet<readonly [string, string]>
}

export const grantsOf = (i: Installation): ReadonlyArray<RoleGrants> =>
	Arr.flatMap(i.worlds, (l) =>
		Arr.map(l.roles, (r): RoleGrants => {
			const mine = Arr.filter(
				i.statements,
				(s): s is Extract<SqlStatement, { readonly kind: "grant" }> =>
					s.kind === "grant" && Arr.some(s.to, (g) => g.kind === "role" && g.name === r.role)
			)
			const names = (kind: "FUNCTION" | "DOMAIN"): ReadonlySet<string> =>
				new Set(
					Arr.flatMap(mine, (g) =>
						g.on.kind === kind ? Arr.map(g.on.names, (n: ObjectName | FunctionName) => n.name) : []
					)
				)
			const tableWrites = Arr.flatMap(mine, (g) =>
				g.on.kind === "TABLE" && Arr.contains(g.privileges, "INSERT")
					? Arr.map(g.on.names, (n) => n.name)
					: []
			)
			const columnWrites = Arr.flatMap(i.statements, (s) =>
				s.kind === "grantColumns" && s.to === r.role && s.privilege === "INSERT"
					? [s.table.name]
					: []
			)
			const views = new TupleSet<readonly [string, string]>()
			for (const g of mine) {
				if (g.on.kind === "TABLE" && Arr.contains(g.privileges, "SELECT")) {
					for (const n of g.on.names) {
						views.add([n.schema, n.name])
					}
				}
			}
			return {
				role: r.role,
				execute: names("FUNCTION"),
				domains: names("DOMAIN"),
				writes: new Set([...tableWrites, ...columnWrites]),
				views
			}
		})
	)

/** The rule restated: the constants a role's statements call, through function bodies. */
export const requiredExecutes = (i: Installation, g: RoleGrants): ReadonlySet<string> => {
	const schema = i.names.schema
	const constants = constantsOf(i)
	const statements = Arr.filter(
		i.statements,
		(s) =>
			(s.kind === "createDomain" && g.domains.has(s.name.name)) ||
			(s.kind === "createTable" && g.writes.has(s.table.name)) ||
			(s.kind === "createView" && g.views.has([s.name.schema, s.name.name]))
	)
	return closure(constants, schema, callsIn(schema, statements))
}

/** Every closed relation's constants, which a role's queries may read. */
export const closedConstants = (i: Installation): ReadonlySet<string> => {
	const c = i.names.closed("Grade")
	return new Set([
		c.function.name,
		c.keys.name,
		...Arr.flatMap(c.payload, (p) => (p.dictionary === undefined ? [] : [p.dictionary.name]))
	])
}

type ConstantsFeature =
	| "a roster with a hole"
	| "a roster a set is typed over"
	| "a roster with an awkward handle"
	| "a closed relation with an open payload"
	| "a closed relation with a closed payload"

export const features: Arr.NonEmptyReadonlyArray<ConstantsFeature> = [
	"a roster with a hole",
	"a roster a set is typed over",
	"a roster with an awkward handle",
	"a closed relation with an open payload",
	"a closed relation with a closed payload"
]

/** A handle of ASCII letters alone, which no array literal, identifier or byte bound needs to quote. */
const plain = (handle: string): boolean =>
	Arr.every(Str.split("")(handle), (ch) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"))

export const noteWorld = (w: World, c: Case<ConstantsFeature>): void => {
	for (const [at, s] of states(w).entries()) {
		if (holesOf(s).length > 0) {
			c.note("a roster with a hole")
		}
		if (w.sets[at] === true || at === 0) {
			c.note("a roster a set is typed over")
		}
		if (Arr.some(liveOf(s), (h) => !plain(h))) {
			c.note("a roster with an awkward handle")
		}
	}
	c.note(
		w.closedPayload
			? "a closed relation with an open payload"
			: "a closed relation with a closed payload"
	)
}

/** The world with roster 0's first live handle removed, leaving its code a hole: its names change, nothing else's. */
export const withHole = (
	w: World
): { readonly codes: Codebook; readonly schema: SchemaDesc } | undefined => {
	const [first, ...rest] = states(w)
	const live = liveOf(first)
	if (live.length < 2) {
		return undefined
	}
	const gone = live[0]
	const holed: RosterState = {
		...first,
		slots: Arr.map(first.slots, (slot): ModelSlot =>
			slot.kind === "live" && slot.handle === gone ? { kind: "hole", was: gone } : slot
		)
	}
	const world: World = {
		...w,
		rosters: Arr.map(w.rosters, (h, at) => (at === 0 ? { ...h, state: holed } : h))
	}
	return { codes: codebookOfStates([holed, ...rest]), schema: schemaOf(world) }
}
