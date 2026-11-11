/**
 * The roster and closed objects an installation holds (physical/ddl/constants.ts), over generated worlds: rosters with
 * holes and growth drawn by construction (test/support/closed/generate.ts), a relation typed by every roster's closed
 * id and by a set over some of them, a closed relation keyed by a roster, and roles that read or write it.
 *
 * - **A roster's domain admits exactly its live codes:** one CREATE DOMAIN over smallint per roster, whose CHECKs,
 *   evaluated on the host by an interpreter written here, admit exactly the live codes among -1 to one past every code
 *   minted, and never 400, the mixed-radix alias a former encoding admitted.
 * - **A set's domain admits exactly sets of live codes:** a bits domain exactly where a set is typed over the roster,
 *   over bit(n), n every code minted rounded up to whole hex digits, whose CHECKs, evaluated likewise, admit the empty
 *   set, each live code alone, every live code together, and no set holding a hole's or a padding position.
 * - **The names constant is the codes:** each names constant the roster domain's CHECKs read, its `'{…}'::name[]`
 *   literal read back by an array-literal reader written here (PostgreSQL's array_in rules: double-quoted elements,
 *   backslash escapes), is the roster's names in code order, a hole the empty name, every awkward handle (`NULL`, a
 *   comma, a quote, a backslash, braces, spaces, 63 bytes) intact.
 * - **Names are content (metamorphic):** two installations whose codes are equal name every constant alike whatever
 *   else differs; a roster that loses a handle to a hole reads other names, from a constant named anew.
 * - **The EXECUTE rule, as a checker over the installed AST:** every role is granted EXECUTE on every function a
 *   statement it runs calls, through function bodies: the CHECK of each domain it holds USAGE on, the CREATE TABLE of
 *   each table it writes, each of its views, and each closed relation's constants, which its queries read; and on no
 *   other function of the installation's constants. (test/unit/physical/executes.test.ts states the rule over worlds
 *   of contracts and laws, which hold no closed relation; this file's closed relation keeps that clause judged.)
 * - **Decoded columns:** every closed-id column of every role view is followed by exactly one `<field>_name`
 *   column; a set has none.
 *
 * Oracles: the codes model's codec (codebookFor) for the names and live codes; a host interpreter of the domains'
 * CHECKs and an array-literal reader, sharing no code with the installer; the EXECUTE rule restated over the
 * statements, sharing no code with the installer's call tracking.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): constants-hole-admitted.patch (a roster's domain admits a hole's code),
 * constants-live-padding.patch (a roster's live constant sets its padding bits).
 *
 * Features: a roster with a hole, one a set is typed over, one with an awkward handle; a closed relation with an open
 * payload and one with a closed payload.
 */
import { describe, it } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record as Rec,
	String as Str
} from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
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
import { assert, deepEquals, defined, succeeded } from "#test/support/assert.ts"
import { setText, textOfHex, wholeDigits } from "#test/support/closed/bit-text.ts"
import {
	codebookOfStates,
	codecFor,
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
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import { upTo } from "#test/support/up-to.ts"

/** A generated world: its rosters' histories, the rosters a set field of Item is typed over, and its closed relation. */
interface World {
	readonly rosters: Arr.NonEmptyReadonlyArray<RosterHistory>
	readonly sets: ReadonlyArray<boolean>
	readonly closedPayload: boolean
}

const worldGen: Gen<World> = (source) => {
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

const states = (w: World): Arr.NonEmptyReadonlyArray<RosterState> =>
	Arr.map(w.rosters, (h) => h.state)

/** Item's closed-id field over roster i, and its set field. */
const codeField = (i: number): string => `kind${i}`
const setField = (i: number): string => `set${i}`

/** The world's schema: its rosters as their live handles declare them, Item, Tags, a set over the first roster alone,
 * and Grade, a closed relation keyed by the first roster, holding every live handle, with an integer or a closed-id
 * payload. */
const schemaOf = (w: World): SchemaDesc => {
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
			...Arr.map(ss, (s) => closed(s.closed, liveOf(s))),
			relation("Item", fields, ["id"]),
			relation("Tags", { id: f.uuid, set: { kind: "bits", roster: first.closed } }, ["id"]),
			grade
		],
		statements: [],
		extends: undefined
	})
}

const loc = SourceLoc("constants test world", [])

/** The world's installation over its codes: a login with a full role, which writes Item, a reader, which only reads
 * it, and a tagger, which writes Tags, a set over the first roster and nothing else of it. */
const installationOf = (owned: Owned, codes: Codebook): Installation => {
	const base = owned.desc
	const app = succeeded(fullRoleDesc(base, "app", loc))
	const reader = succeeded(
		decodeRoleOver(base, {
			name: "reader",
			relations: [{ kind: "whole", name: "Item", loc }],
			write: [],
			refresh: [],
			loc
		})
	)
	/** A role whose only use of a roster is a set: it calls live() through the bits domain's CHECK, and no names constant. */
	const tagger = succeeded(
		decodeRoleOver(base, {
			name: "tagger",
			relations: [{ kind: "whole", name: "Tags", loc }],
			write: ["Tags"],
			refresh: [],
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
const constantsOf = (i: Installation): Constants =>
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

type CreateDomain = Extract<SqlStatement, { readonly kind: "createDomain" }>

/** The one CREATE DOMAIN of `name`, which no installation creates twice. */
const domainNamed = (i: Installation, name: string, what: string): CreateDomain => {
	const domains = Arr.filter(
		i.statements,
		(st): st is CreateDomain => st.kind === "createDomain" && st.name.name === name
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
 * a literal, VALUE, a constant's call, a cast (which changes no value here), a subscript counted from 1 (NULL past
 * either end), `+`, `&` of two bit strings of one length, and `=` and `<>`, NULL where an operand is. Its own
 * interpreter, sharing no code with the installer, so a CHECK is judged by what it admits, whatever its shape.
 */
const evaluate = (e: Expr, value: HostValue, constants: Constants, schema: string): HostValue => {
	const recur = (x: Expr): HostValue => evaluate(x, value, constants, schema)
	switch (e.kind) {
		case "literal":
			return literalValue(e.value)
		case "domainValue":
			return value
		case "call":
			if (e.fn.kind === "qualified" && e.fn.schema === schema) {
				return constantValueOf(defined(constants.get(e.fn.name), `the constant ${e.fn.name}`))
			}
			throw new Error("a call of no constant of the installation")
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
			throw new Error(`a ${l.kind} ${e.op} ${r.kind} a domain CHECK holds`)
		}
		case "column":
		case "excluded":
		case "returning":
		case "param":
		case "collate":
		case "negate":
		case "and":
		case "or":
		case "not":
		case "isTrue":
		case "between":
		case "inList":
		case "inQuery":
		case "exists":
		case "subquery":
		case "array":
		case "row":
		case "case":
		case "greatest":
		case "least":
		case "coalesce":
		case "mergeAction":
		case "plSpecial":
		case "field":
		case "complement":
		case "nullif":
		case "plVar":
		case "regclass":
		case "user":
			break
	}
	throw new Error(`a ${e.kind} term, which no roster or set domain's CHECK holds`)
}

/** Whether a domain admits VALUE = `value`: every one of its CHECKs is TRUE there. */
const admits = (d: CreateDomain, value: HostValue, constants: Constants, schema: string): boolean =>
	Arr.every(d.constraints, (c) => {
		const judged = evaluate(c.predicate, value, constants, schema)
		return judged.kind === "bool" && judged.value
	})

/** The names constants a domain's CHECKs read: every constant they call whose body is an array of names. */
const namesRead = (
	d: CreateDomain,
	constants: Constants,
	schema: string
): ReadonlyMap<string, ReadonlyArray<string | null>> =>
	new Map(
		Arr.flatMap([...callsIn(schema, d.constraints)], (fn) => {
			const read = constantValueOf(defined(constants.get(fn), `the constant ${fn}`))
			return read.kind === "names" ? [[fn, read.value] as const] : []
		})
	)

/**
 * A roster's domain, the codes it admits from one below 0 to one past every code minted and at 400, the mixed-radix
 * alias, and the names constants its CHECKs read.
 */
const rosterObjects = (i: Installation, s: RosterState) => {
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
	return { names: namesRead(domain, constants, schema), admitted }
}

/** What each role holds, read from the grants the installation states. */
interface RoleGrants {
	readonly role: string
	readonly execute: ReadonlySet<string>
	readonly domains: ReadonlySet<string>
	readonly writes: ReadonlySet<string>
}

const grantsOf = (i: Installation): ReadonlyArray<RoleGrants> =>
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
			return {
				role: r.role,
				execute: names("FUNCTION"),
				domains: names("DOMAIN"),
				writes: new Set([...tableWrites, ...columnWrites])
			}
		})
	)

/** The rule restated: the constants a role's statements call, through function bodies. */
const requiredExecutes = (
	i: Installation,
	g: RoleGrants,
	roleSchema: string
): ReadonlySet<string> => {
	const schema = i.names.schema
	const constants = constantsOf(i)
	const statements = Arr.filter(
		i.statements,
		(s) =>
			(s.kind === "createDomain" && g.domains.has(s.name.name)) ||
			(s.kind === "createTable" && g.writes.has(s.table.name)) ||
			(s.kind === "createView" && s.name.schema === roleSchema)
	)
	return closure(constants, schema, callsIn(schema, statements))
}

/** Every closed relation's constants, which a role's queries may read. */
const closedConstants = (i: Installation): ReadonlySet<string> => {
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

const features: Arr.NonEmptyReadonlyArray<ConstantsFeature> = [
	"a roster with a hole",
	"a roster a set is typed over",
	"a roster with an awkward handle",
	"a closed relation with an open payload",
	"a closed relation with a closed payload"
]

/** A handle of ASCII letters alone, which no array literal, identifier or byte bound needs to quote. */
const plain = (handle: string): boolean =>
	Arr.every(Str.split("")(handle), (ch) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"))

const noteWorld = (w: World, c: Case<ConstantsFeature>): void => {
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
const withHole = (
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

describe("roster and closed constants", () => {
	it.effect(
		"domains that admit exactly the live codes, names that are content, EXECUTE by rule, decoded view columns",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the codes model's codec, a host interpreter of the domains' CHECKs, and the EXECUTE rule"
						},
						suite: "unit/physical/constants",
						draw: drawn(worldGen),
						literal: Formatter.format,
						coverage: required(features, { cases: 120, sense: notesOnly }),
						kept: [],
						runs: 120,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(w, c) =>
						Effect.sync(() => {
							noteWorld(w, c)
							const owned = owning(schemaOf(w))
							const codes = codebookOfStates(states(w))
							const i = installationOf(owned, codes)
							const schema = i.names.schema
							const constants = constantsOf(i)

							for (const [at, s] of states(w).entries()) {
								const { names, admitted } = rosterObjects(i, s)
								const live = Arr.flatMap(s.slots, (slot, code) =>
									slot.kind === "live" ? [code] : []
								)
								assert.deepEqual(
									admitted,
									live,
									`roster ${s.closed}'s domain admits exactly its live codes`
								)
								assert.ok(names.size > 0, `roster ${s.closed}'s domain reads its names`)
								for (const read of names.values()) {
									assert.deepEqual(
										read,
										codecFor(s).names,
										`roster ${s.closed}'s names in code order`
									)
								}
								const bitsName = i.names.bitsDomain(s.closed).name
								const bits = Arr.filter(
									i.statements,
									(st): st is CreateDomain =>
										st.kind === "createDomain" && st.name.name === bitsName
								)
								assert.equal(
									bits.length,
									w.sets[at] === true || at === 0 ? 1 : 0,
									"a bits domain exactly where a set is typed: Tags' over the first roster, Item's where drawn"
								)
								const width = wholeDigits(s.slots.length)
								for (const d of bits) {
									assert.ok(
										d.base.kind === "builtin" && d.base.name === "bit" && d.base.length === width,
										"bit(n), n every code minted rounded up to whole hex digits"
									)
									const probes = [[], ...upTo(width, (code) => [code]), live, upTo(width, (i) => i)]
									for (const members of probes) {
										assert.equal(
											admits(
												d,
												{ kind: "bits", value: setText(s.slots.length, members) },
												constants,
												schema
											),
											Arr.every(members, (code) => Arr.contains(live, code)),
											`roster ${s.closed}'s bits domain admits exactly sets of its live codes: ${Formatter.format(members)}`
										)
									}
								}
							}

							const closedNames = closedConstants(i)
							for (const g of grantsOf(i)) {
								const roleSchema = defined(
									Option.getOrUndefined(
										Arr.findFirst(
											Arr.flatMap(i.worlds, (l) => l.roles),
											(r) => r.role === g.role
										)
									)
								).schema
								const need = requiredExecutes(i, g, roleSchema)
								for (const name of need) {
									assert.ok(
										g.execute.has(name),
										`${g.role} holds EXECUTE on ${name}, which it calls`
									)
								}
								for (const name of closedNames) {
									assert.ok(
										g.execute.has(name),
										`${g.role} holds EXECUTE on the closed constant ${name}`
									)
								}
								for (const name of g.execute) {
									assert.ok(
										!constants.has(name) || need.has(name) || closedNames.has(name),
										`${g.role}'s EXECUTE on ${name} has a reason`
									)
								}
							}

							const itemColumns = new Map<string, string>(
								Arr.map(
									states(w),
									(s, at) => [i.names.column("Item", codeField(at)), s.closed] as const
								)
							)
							for (const view of i.statements) {
								if (view.kind !== "createView" || view.name.schema === schema) {
									continue
								}
								for (const [at, column] of view.columns.entries()) {
									const roster = itemColumns.get(column)
									if (roster === undefined) {
										continue
									}
									const decoded = `${column}_name`
									assert.equal(
										view.columns[at + 1],
										decoded,
										`${column} is followed by its decoded name`
									)
									assert.equal(
										Arr.filter(view.columns, (c) => c === decoded).length,
										1,
										`one decoded column for ${column}`
									)
								}
								for (const set of Arr.filter(states(w), (_, at) => w.sets[at] === true)) {
									const column = i.names.column("Item", setField(states(w).indexOf(set)))
									assert.ok(
										!Arr.contains(view.columns, `${column}_name`),
										"a set has no decoded column"
									)
								}
							}

							const again = installationOf(owning(schemaOf(w)), codes)
							assert.deepEqual(
								Arr.sort([...constantsOf(again).keys()], Order.String),
								Arr.sort([...constants.keys()], Order.String),
								"equal codes and content name every constant alike"
							)
							const holed = withHole(w)
							if (holed !== undefined) {
								const changed = installationOf(owning(holed.schema), holed.codes)
								const before = defined(states(w)[0])
								const was = rosterObjects(i, before).names
								const now = rosterObjects(changed, before).names
								assert.ok(
									Arr.every([...now.values()], (names) =>
										Arr.every([...was.values()], (before) => !deepEquals(names, before))
									),
									"a hole changes the names every names constant holds"
								)
								assert.ok(
									Arr.every([...now.keys()], (fn) => !was.has(fn)),
									"a hole names the names constant anew"
								)
							}
						})
				)
			)
	)
})
