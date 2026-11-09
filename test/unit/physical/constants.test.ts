/**
 * The roster and closed objects an installation holds (physical/ddl/constants.ts), over generated worlds: rosters with
 * holes and growth drawn by construction (test/support/closed/generate.ts), a relation typed by every roster's closed
 * id and by a set over some of them, a closed relation keyed by a roster, and roles that read or write it.
 *
 * - **One domain per roster:** exactly one CREATE DOMAIN over smallint names each roster's domain, with exactly one
 *   CHECK, which calls exactly one function: the roster's names constant. A roster some set is typed over has its bits
 *   domain over bit(n), n every code minted rounded up to whole hex digits, whose one CHECK calls its live-codes
 *   constant, whose body is one hex literal, the live codes' bits with every hole and padding bit 0, and calls nothing.
 * - **The range proof:** the roster domain's CHECK, evaluated on the host by an interpreter written here, admits exactly
 *   the live codes among -1 to one past every code minted, and never the mixed-radix alias 400.
 * - **The names constant is the codes:** its `'{…}'::name[]` literal, read back by an array-literal reader written
 *   here (PostgreSQL's array_in rules: double-quoted elements, backslash escapes), is the roster's names in code order,
 *   a hole the empty name, every awkward handle (`NULL`, a comma, a quote, a backslash, braces, spaces, 63 bytes)
 *   intact, and never empty.
 * - **Names are content (metamorphic):** two installations whose codes are equal name every constant alike whatever
 *   else differs; a roster that loses a handle to a hole names its names constant anew.
 * - **The EXECUTE rule, as a checker over the installed AST:** every role is granted EXECUTE on every function a
 *   statement it runs calls, through function bodies: the CHECK of each domain it holds USAGE on, the CREATE TABLE of
 *   each table it writes, each of its views, and each closed relation's constants, which its queries read; and on no
 *   other function of the installation's constants.
 * - **Decoded columns:** every closed-id column of every role view is followed by exactly one `<field>_name`
 *   column, the names constant's element at the code plus one, cast to text; a set has none.
 *
 * Oracles: the codes model's codec (codebookFor) for the names; the rules restated over the statements, sharing no code
 * with the installer's call tracking. Features: (role kind, uses a domain, reads a view) and the hole and set shapes.
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
import { decodeDesc, type FieldDesc, type SchemaDesc } from "#compiler/ir/desc.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { installationsOf } from "#compiler/schema/own.ts"
import { fullRoleDesc, type Owned, ownLogin } from "#compiler/schema/own.ts"
import type { Expr, FunctionName, ObjectName, SqlStatement } from "#compiler/sql/ast.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { hexOfText, setText, wholeDigits } from "#test/support/closed/bit-text.ts"
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
		decodeDesc("role", {
			name: "reader",
			base,
			relations: [{ kind: "whole", name: "Item", loc }],
			write: [],
			refresh: [],
			loc
		})
	)
	/** A role whose only use of a roster is a set: it calls live() through the bits domain's CHECK, and no names constant. */
	const tagger = succeeded(
		decodeDesc("role", {
			name: "tagger",
			base,
			relations: [{ kind: "whole", name: "Tags", loc }],
			write: ["Tags"],
			refresh: [],
			loc
		})
	)
	const login = succeeded(
		Result.flatMap(
			decodeDesc("login", { name: "desk", base, roles: [app, reader, tagger], loc }),
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

type Constants = ReadonlyMap<
	string,
	Extract<SqlStatement, { readonly kind: "createConstant" | "packConstant" }>
>

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

/** The text of a constant's body, a text literal cast to the constant's type; none for another body. */
const literalText = (e: Expr): string | undefined =>
	e.kind === "literal" && e.value.kind === "text" ? e.value.value : undefined

/** A roster's domain, the one names constant its CHECK reads, and the names that constant holds, read back. */
const rosterObjects = (i: Installation, s: RosterState) => {
	const schema = i.names.schema
	const domainName = i.names.rosterDomain(s.closed).name
	const domains = Arr.filter(
		i.statements,
		(st): st is Extract<SqlStatement, { readonly kind: "createDomain" }> =>
			st.kind === "createDomain" && st.name.name === domainName
	)
	assert.equal(domains.length, 1, `one domain for roster ${s.closed}`)
	const domain = defined(domains[0])
	assert.ok(
		domain.base.kind === "builtin" && domain.base.name === "smallint",
		"a roster domain over smallint"
	)
	assert.equal(domain.constraints.length, 1, "a roster domain's one CHECK")
	const calls = [...callsIn(schema, domain.constraints)]
	assert.equal(calls.length, 1, "a roster domain's CHECK reads one constant")
	const namesFunction = defined(calls[0])
	const names = defined(constantsOf(i).get(namesFunction), "the names constant is installed")
	const text = names.kind === "createConstant" ? literalText(names.body) : undefined
	const read = readArray(defined(text, "a names constant's body is its array literal"))
	/** The codes the CHECK admits, from one below 0 to one past every code minted, and the alias 400. */
	const admitted = Arr.filter([...Arr.range(-1, read.length), 400], (code) => {
		const constraint = defined(domain.constraints[0])
		return evaluate(constraint.predicate, code, () => read) === 1
	})
	return { namesFunction, names: read, admitted }
}

/** A value a domain CHECK's terms take on the host: an integer, a name, a constant's names, or NULL. */
type HostValue = number | string | ReadonlyArray<string | null> | null

/**
 * A roster domain's CHECK evaluated on the host at VALUE = `code`, by PostgreSQL's rules for the terms it is made of: an
 * integer literal, a text literal, VALUE, `+`, a names constant's call, a subscript counted from 1 (NULL past either
 * end), and `<>`, NULL where an operand is. Its own interpreter, sharing no code with the installer, so the CHECK's
 * shape is judged by what it admits: a code is admitted exactly when the CHECK is TRUE.
 */
const evaluate = (
	e: Expr,
	code: number,
	names: (fn: string) => ReadonlyArray<string | null>
): HostValue => {
	if (e.kind === "literal") {
		return e.value.kind === "int"
			? Number(e.value.value)
			: e.value.kind === "text"
				? e.value.value
				: null
	}
	if (e.kind === "domainValue") {
		return code
	}
	if (e.kind === "call") {
		return e.fn.kind === "qualified" ? names(e.fn.name) : null
	}
	if (e.kind === "subscript") {
		const array = evaluate(e.array, code, names)
		const index = evaluate(e.index, code, names)
		return typeof array === "object" && array !== null && typeof index === "number"
			? (array[index - 1] ?? null)
			: null
	}
	if (e.kind === "binary") {
		const l = evaluate(e.left, code, names)
		const r = evaluate(e.right, code, names)
		if (l === null || r === null) {
			return null
		}
		if (e.op === "+" && typeof l === "number" && typeof r === "number") {
			return l + r
		}
		if (e.op === "<>" && typeof l === "string" && typeof r === "string") {
			return l === r ? 0 : 1
		}
	}
	throw new Error(`a term the roster CHECK holds: ${e.kind}`)
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
	| "a role that writes and holds a domain"
	| "a role that only reads a view"
	| "a closed relation with an open payload"
	| "a closed relation with a closed payload"

const features: Arr.NonEmptyReadonlyArray<ConstantsFeature> = [
	"a roster with a hole",
	"a roster a set is typed over",
	"a roster with an awkward handle",
	"a role that writes and holds a domain",
	"a role that only reads a view",
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
	c.note("a role that writes and holds a domain")
	c.note("a role that only reads a view")
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
		"one domain per roster over its names constant, names that are content, EXECUTE by rule, decoded view columns",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
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
								assert.deepEqual(
									admitted,
									Arr.flatMap(s.slots, (slot, code) => (slot.kind === "live" ? [code] : [])),
									`roster ${s.closed}'s domain admits exactly its live codes`
								)
								assert.deepEqual(
									names,
									codecFor(s).names,
									`roster ${s.closed}'s names in code order`
								)
								assert.ok(names.length > 0, "a names constant holds one name at least")
								const bitsName = i.names.bitsDomain(s.closed).name
								const bits = Arr.filter(
									i.statements,
									(st): st is Extract<SqlStatement, { readonly kind: "createDomain" }> =>
										st.kind === "createDomain" && st.name.name === bitsName
								)
								assert.equal(
									bits.length,
									w.sets[at] === true || at === 0 ? 1 : 0,
									"a bits domain exactly where a set is typed: Tags' over the first roster, Item's where drawn"
								)
								for (const d of bits) {
									assert.ok(
										d.base.kind === "builtin" &&
											d.base.name === "bit" &&
											d.base.length === wholeDigits(s.slots.length),
										"bit(n), n every code minted rounded up to whole hex digits"
									)
									const checks = [...callsIn(schema, d.constraints)]
									assert.equal(checks.length, 1, "a bits domain's CHECK reads one constant, live()")
									const live = defined(constants.get(defined(checks[0])), "live() is installed")
									const liveCodes = Arr.flatMap(s.slots, (slot, code) =>
										slot.kind === "live" ? [code] : []
									)
									assert.deepEqual(
										live.kind === "createConstant" &&
											live.body.kind === "literal" &&
											live.body.value.kind === "bits"
											? live.body.value.hex
											: undefined,
										hexOfText(setText(s.slots.length, liveCodes)),
										"live() is the hex literal of the live codes, every hole and padding bit 0"
									)
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
								assert.notDeepEqual(
									rosterObjects(changed, before).names,
									rosterObjects(i, before).names,
									"a hole changes the names"
								)
								assert.notEqual(
									rosterObjects(changed, before).namesFunction,
									rosterObjects(i, before).namesFunction,
									"a hole names the names constant anew"
								)
							}
						})
				)
			)
	)
})
