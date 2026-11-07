import { floorPopulation, type Situations } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { Array as Arr, Effect, Result as EffectResult, Record as Rec } from "effect"
import { openToken } from "#adapter/db/open.ts"
import { refreshTargets } from "#adapter/refresh/targets.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import { login, loginRoleOf, role, roleDescOf } from "#compiler/schema/world.ts"
import type { TypeRefusal } from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { AnyRole, EntryValue } from "#compiler/types/schema/world.ts"
import {
	Account,
	AccountNames,
	accountIds,
	accountSeats,
	Org,
	Reports,
	Session,
	Task,
	TaskTally,
	taskImported,
	taskNegated,
	taskOrg,
	taskPlain,
	taskSession,
	taskStaged,
	Tier,
	Work
} from "#test/support/agreement/access-schema.ts"
import { defined } from "#test/support/assert.ts"
import { compileTemplate, testArtifacts, testCompile } from "#test/support/compile.ts"
import {
	identifiers,
	preludeAt,
	preludeImports,
	type PreludeAt,
	preludeFrom
} from "#test/support/prelude.ts"

/**
 * The access agreement: logins of roles drawn over ./access-schema.ts, each role's Task entry reading a context at a
 * drawn place or none, and the one TypeScript program that states, of every login, what its types admit, which the
 * type tier checks (test/types/api/access.test.ts). The engine is the oracle, as the runtime reads a role: the contexts
 * its relations read (schema/walk.ts queryUses of each query entry, as pool/registry.ts reads them), its compilation of
 * a program for the role (a program matching a context the role reads none of is refused), and db.refresh's resolution
 * of the relations it names (refresh/targets.ts). Of each drawn login:
 *
 * - Db.open of each of its roles without a token typechecks exactly when the role's relations read no context, and
 *   with one always, delivering exactly a Db of the role it opened, over the base or an extension, its services
 *   exactly the role's DbLayer and its error OpenError;
 * - DbLayer.make without verify typechecks exactly when no role of the login reads a context, and with verify its
 *   layer provides exactly the DbLayer of each of the login's roles, failing with OpenError;
 * - a program over a role matching a drawn context, run on the role's Db by execute, compile or apply (a read-back),
 *   typechecks exactly when the engine compiles it for the role;
 * - db.refresh of drawn derived relations typechecks exactly when the engine resolves every one against the role's
 *   refresh list, and succeeds with nothing and fails with ApplyError;
 * - Db.open of a role reached through its login, of the role value itself, or of the schema typechecks exactly when
 *   the engine reads its argument as a role reached through a login (schema/world.ts loginRoleOf);
 * - Db.open given no options, null, a token, or a token of another type than text typechecks exactly when Db.open's
 *   boundary reads them (db/open.ts openToken), refusing what a JavaScript caller passes at stage schema: no options
 *   at the call's arity (TS2554), null as the argument (TS2345), and another token at the token (TS2322);
 * - a program over the base, reading its ordinary relations alone or the closed relation's rows too, executed on a
 *   role's Db typechecks exactly when the engine compiles it for the role: a role holding every relation of the base
 *   whole but the closed one, whose rows every role reads, runs it, and a role holding one only through a query entry
 *   refuses it (OutsideRole).
 *
 * The places a Task entry reads a context are every place a definition can: a match of Org or of Session, Org under
 * a negation, in an interior stage and through an imported query, or none. Each refusal stands under
 * its directive at its call's line.
 */
const places = ["none", "org", "session", "negated", "staged", "imported", "whole"] as const
type Place = (typeof places)[number]

/** Task's entry for each place, by the name the program imports it under: a query entry, or Task whole. */
const taskEntry: { readonly [P in Place]: readonly [string, EntryValue] } = {
	none: ["taskPlain", taskPlain],
	org: ["taskOrg", taskOrg],
	session: ["taskSession", taskSession],
	negated: ["taskNegated", taskNegated],
	staged: ["taskStaged", taskStaged],
	imported: ["taskImported", taskImported],
	whole: ["Task", Task]
}

const derivedNames = ["TaskTally", "AccountNames"] as const
type DerivedName = (typeof derivedNames)[number]
const derivedValues: { readonly [D in DerivedName]: AnyDerived } = { TaskTally, AccountNames }

const contextNames = ["Org", "Session"] as const
type ContextName = (typeof contextNames)[number]

/** What Db.open is given: a role reached through its login, the role value itself, or the schema. */
const openers = ["login role", "role value", "schema"] as const
type Opener = (typeof openers)[number]

/** A program over the base: one reading its ordinary relations alone, and one matching the closed relation too. */
const basePrograms = ["accountIds", "accountSeats"] as const
type BaseProgram = (typeof basePrograms)[number]
const baseValues: { readonly [P in BaseProgram]: object } = { accountIds, accountSeats }

/** Db.open's options as a caller may give them: none, null, a token, or a token of another type than text. */
const optionForms = ["omitted", "null", "a token", "a token of another type"] as const
type OptionForm = (typeof optionForms)[number]

/** Each form of options, in the program and as a JavaScript caller passes it. */
const optionValues: {
	readonly [F in OptionForm]: { readonly source: string; readonly value: unknown }
} = {
	omitted: { source: "", value: undefined },
	null: { source: ", null", value: null },
	"a token": { source: ', { token: "token" }', value: { token: "token" } },
	"a token of another type": { source: ", { token: 1 }", value: { token: 1 } }
}

/**
 * The diagnostic each malformed form raises, with why: the call's arity, the argument, or the token's property. A text
 * token is well formed, so the boundary refusing one is a defect the agreement reports.
 */
const optionRefusals: {
	readonly [F in Exclude<OptionForm, "a token">]: {
		readonly code: string
		readonly why: string
	}
} = {
	omitted: { code: "TS2554", why: "Db.open needs its options" },
	null: { code: "TS2345", why: "Db.open's options are an object" },
	"a token of another type": { code: "TS2322", why: "Db.open's token is text" }
}

/** The directive of options the boundary refuses. */
const optionDirective = (form: OptionForm): string => {
	if (form === "a token") {
		throw new Error("Db.open's boundary refuses a text token")
	}
	const { code, why } = optionRefusals[form]
	return `// @ts-expect-error -- ${code}: ${why}`
}

/** How a program on a role's Db runs: read, compiled, or read back by an applied ChangeSet. */
const entries = ["execute", "compile", "apply"] as const
type Entry = (typeof entries)[number]

/** One role of a case's login: its Task entry's place, and, over Reports, its derived entries and refresh list. */
interface RoleSpec {
	readonly name: string
	readonly place: Place
	readonly refresh: ReadonlyArray<DerivedName>
}

interface AccessSpec {
	readonly level: "Work" | "Reports"
	readonly roles: Arr.NonEmptyReadonlyArray<RoleSpec>
	/** The role a program runs on, the context it matches and how it runs. */
	readonly program: { readonly role: number; readonly context: ContextName; readonly entry: Entry }
	/** The role a refresh runs on and the derived relations it names. */
	readonly refresh: {
		readonly role: number
		readonly names: Arr.NonEmptyReadonlyArray<DerivedName>
	}
	/** What a further Db.open is given, of its first role. */
	readonly opener: Opener
	/** What Db.open of its first role is given as options. */
	readonly options: OptionForm
	/** A program over the base a role's Db executes: its role, and whether it matches the closed relation. */
	readonly base: { readonly role: number; readonly program: BaseProgram }
}

/** What a case reached: each role's place and every verdict. */
export type AccessNote =
	| `a context read: ${Place}`
	| `open ${"admitted" | "refused"}`
	| `verify ${"required" | "optional"}`
	| `${Entry} ${"admitted" | "refused"}`
	| `refresh ${"admitted" | "refused"}`
	| `${Opener} ${"admitted" | "refused"}`
	| `options ${OptionForm} ${"admitted" | "refused"}`
	| `base ${BaseProgram} ${"admitted" | "refused"}`
	| "two roles"
	| "over an extension"

const coin = (source: Source, odds: number): boolean => source.draw(int(1, odds)) === 1

const specGen: Gen<AccessSpec> = (source) => {
	const level = coin(source, 2) ? "Reports" : "Work"
	const count = source.draw(int(1, 2))
	const roleSpec = (at: number): RoleSpec => ({
		name: `r${at}`,
		place: source.draw(element(places)),
		refresh: level === "Reports" ? Arr.filter(derivedNames, () => coin(source, 2)) : []
	})
	const roles: Arr.NonEmptyReadonlyArray<RoleSpec> =
		count === 1 ? [roleSpec(0)] : [roleSpec(0), roleSpec(1)]
	const first = source.draw(element(derivedNames))
	return {
		level,
		roles,
		program: {
			role: source.draw(int(0, count - 1)),
			context: source.draw(element(contextNames)),
			entry: source.draw(element(entries))
		},
		refresh: {
			role: source.draw(int(0, count - 1)),
			names: coin(source, 2) ? [first] : [first, ...Arr.filter(derivedNames, (n) => n !== first)]
		},
		opener: source.draw(element(openers)),
		options: source.draw(element(optionForms)),
		base: {
			role: source.draw(int(0, count - 1)),
			program: source.draw(element(basePrograms))
		}
	}
}

/**
 * A role's entries: Tier and Account whole, Task at its place, and over Reports both derived relations whole. The
 * closed relation is no role's entry: every role reads its rows.
 */
const roleEntries = (spec: AccessSpec, r: RoleSpec): ReadonlyArray<readonly [string, string]> => [
	["Tier", "Tier"],
	["Account", "Account"],
	["Task", taskEntry[r.place][0]],
	...(spec.level === "Reports" ? Arr.map(derivedNames, (d) => [d, d] as const) : [])
]

/** A role, built by the public role(...) as the program builds it. */
const builtRole = (spec: AccessSpec, r: RoleSpec): AnyRole => {
	const values: Readonly<Record<string, EntryValue>> = {
		Tier,
		Account,
		...(spec.level === "Reports" ? derivedValues : {})
	}
	const entriesOf = Rec.fromEntries(
		Arr.map(roleEntries(spec, r), ([name, value]) => [
			name,
			name === "Task" ? taskEntry[r.place][1] : got(values, value)
		])
	)
	return role(spec.level === "Reports" ? Reports : Work, r.name, entriesOf, {
		write: [],
		refresh: r.refresh
	})
}

const got = (record: Readonly<Record<string, EntryValue>>, name: string): EntryValue => {
	const found = record[name]
	if (found === undefined) {
		throw new Error(`no value ${name}`)
	}
	return found
}

/** The contexts a role's relations read, by name, as the layer reads them. */
const readsOf = (value: AnyRole): ReadonlySet<string> => {
	const desc = roleDescOf(value)
	if (desc === undefined) {
		throw new Error("role(...) describes every role it builds")
	}
	return new Set(
		Arr.flatMap(desc.relations, (entry) =>
			entry.kind === "world" ? [...queryUses(entry.query).contexts.keys()] : []
		)
	)
}

/** The program over a role matching a context, built through the query builder's JavaScript view. */
const builtProgram = (value: AnyRole, context: ContextName): QueryValue => {
	const account = value.relations["Account"]
	return queryOver(value).rule((r: RuleValue) => {
		const vars = varsOver(account, "account")
		const matched = r.match(account, { id: vars["id"], name: vars["name"] })
		return (
			context === "Org"
				? matched.match(Org, { id: vars["id"] })
				: matched.match(Session, { sub: vars["name"] })
		).find({ id: vars["id"] })
	})
}

interface AccessVerdict {
	/** Per role, whether its relations read a context. */
	readonly reads: Arr.NonEmptyReadonlyArray<boolean>
	readonly program: boolean
	readonly refresh: boolean
	/** Whether Db.open's first argument is a role reached through its login. */
	readonly opener: boolean
	/** Whether Db.open's boundary reads the drawn options (db/open.ts openToken). */
	readonly options: boolean
	/** Whether the engine compiles the program over the base for the role (OutsideRole for a partial role). */
	readonly base: boolean
}

const verdictOf = (spec: AccessSpec): AccessVerdict => {
	const values = Arr.map(spec.roles, (r) => builtRole(spec, r))
	const reads = Arr.map(values, (v) => readsOf(v).size > 0)
	const programRole = defined(values[spec.program.role], "the program's role")
	const program = Result.flatMap(
		catchCompileError(() => builtProgram(programRole, spec.program.context)),
		(q) => compileTemplate(q, programRole, testCompile)
	)
	const refreshRole = defined(values[spec.refresh.role], "the refresh's role")
	const desc = roleDescOf(refreshRole)
	const artifacts = testArtifacts(refreshRole, testCompile)
	if (desc === undefined || !artifacts.ok) {
		throw new Error("a drawn role compiles")
	}
	const refresh = refreshTargets(
		desc,
		artifacts.value,
		Arr.map(spec.refresh.names, (n) => derivedValues[n])
	)
	const level = spec.level === "Reports" ? Reports : Work
	const built = login(level, "agreement", values, [])
	const first = spec.roles[0].name
	const opened: unknown =
		spec.opener === "login role"
			? built.roles[first]
			: spec.opener === "role value"
				? values[0]
				: level
	return {
		reads,
		program: program.ok,
		refresh: EffectResult.isSuccess(refresh),
		opener: loginRoleOf(opened) !== undefined,
		options: EffectResult.isSuccess(openToken(optionValues[spec.options].value)),
		base: compileTemplate(
			baseValues[spec.base.program],
			defined(values[spec.base.role], "the base program's role"),
			testCompile
		).ok
	}
}

interface AccessCase {
	readonly spec: AccessSpec
	readonly verdict: AccessVerdict
	readonly notes: ReadonlySet<AccessNote>
}

const caseGen: Gen<AccessCase> = (source) => {
	const spec = specGen(source)
	const verdict = verdictOf(spec)
	const notes = new Set<AccessNote>()
	for (const [r, reads] of Arr.zip(spec.roles, verdict.reads)) {
		notes.add(`a context read: ${r.place}`)
		notes.add(`open ${reads ? "refused" : "admitted"}`)
	}
	notes.add(`verify ${Arr.some(verdict.reads, (x) => x) ? "required" : "optional"}`)
	notes.add(`${spec.program.entry} ${verdict.program ? "admitted" : "refused"}`)
	notes.add(`refresh ${verdict.refresh ? "admitted" : "refused"}`)
	notes.add(`${spec.opener} ${verdict.opener ? "admitted" : "refused"}`)
	notes.add(`options ${spec.options} ${verdict.options ? "admitted" : "refused"}`)
	notes.add(`base ${spec.base.program} ${verdict.base ? "admitted" : "refused"}`)
	if (spec.roles.length > 1) {
		notes.add("two roles")
	}
	if (spec.level === "Reports") {
		notes.add("over an extension")
	}
	return { spec, verdict, notes }
}

/** The refusal a program over the base takes on a Db of a role that holds no relation of it whole. */
const baseRefusal: TypeRefusal = "a program over no level of the database's schema"

const contextRefusal: TypeRefusal =
	"a program on a Db of a role matches only the contexts the role's relations read, whose facts its claims hold"

/** A role's declaration, in the program. */
const roleSource = (spec: AccessSpec, r: RoleSpec, i: number): string =>
	`export const R${i}_${r.name} = role(${spec.level}, ${jsonText(r.name)}, { ${Arr.join(
		Arr.map(roleEntries(spec, r), ([name, value]) => `${name}: ${value}`),
		", "
	)} }${spec.level === "Reports" ? `, { refresh: [${Arr.join(Arr.map(r.refresh, jsonText), ", ")}] }` : ""})`

/** The program over a role matching a context, in the program. */
const programSource = (roleId: string, context: ContextName, i: number): string =>
	`export const p${i} = query(${roleId}).rule((r) => { const { id, name } = v(${roleId}.relations.Account, "account"); return r.match(${roleId}.relations.Account, { id, name })${context === "Org" ? ".match(Org, { id })" : ".match(Session, { sub: name })"}.find({ id }) })`

/** Db.open's first argument, in the program. */
const openerSource = (spec: AccessSpec, i: number): string => {
	const first = spec.roles[0].name
	switch (spec.opener) {
		case "login role":
			return `L${i}.roles.${first}`
		case "role value":
			return `R${i}_${first}`
		case "schema":
			return spec.level
	}
}

/** One case's statements: its roles and login, and each probe under its verdict's directive. */
const blockOf = (c: AccessCase, i: number): ReadonlyArray<string> => {
	const { spec, verdict } = c
	const roleIds = Arr.map(spec.roles, (r) => `R${i}_${r.name}`)
	const services = Arr.join(
		Arr.map(roleIds, (id) => `DbLayer<typeof ${id}>`),
		" | "
	)
	const opens = Arr.flatMap(Arr.zip(spec.roles, verdict.reads), ([r, reads]) => [
		...(reads
			? [`// @ts-expect-error -- TS2741: role ${r.name} reads a context, so Db.open needs a token`]
			: []),
		`export const o${i}_${r.name} = Db.open(L${i}.roles.${r.name}, {})`,
		`export const t${i}_${r.name} = Db.open(L${i}.roles.${r.name}, { token: "token" })`,
		`export type s${i}_${r.name} = [Expect<Equals<Effect.Services<typeof t${i}_${r.name}>, DbLayer<typeof R${i}_${r.name}>>>, Expect<Equals<Effect.Error<typeof t${i}_${r.name}>, OpenError>>, Expect<Equals<Effect.Success<typeof t${i}_${r.name}>, DbOf<typeof R${i}_${r.name}, unknown>>>]`
	])
	const programRole = defined(roleIds[spec.program.role], "the program's role")
	const run = (() => {
		switch (spec.program.entry) {
			case "execute":
				return `db.execute(p${i}, {})`
			case "compile":
				return `db.compile(p${i})`
			case "apply":
				return `db.apply(ChangeSet.empty(${programRole}).read("rows", () => p${i}), {})`
		}
	})()
	const refreshRole = defined(roleIds[spec.refresh.role], "the refresh's role")
	return [
		...Arr.map(spec.roles, (r) => roleSource(spec, r, i)),
		`export const L${i} = login(${spec.level}, "l${i}", [${Arr.join(roleIds, ", ")}])`,
		...opens,
		...(Arr.some(verdict.reads, (x) => x)
			? [
					"// @ts-expect-error -- TS2345: a role of the login reads a context, so its layer needs verify"
				]
			: []),
		`export const m${i} = DbLayer.make({ ...destination, login: L${i}, password })`,
		`export const n${i} = DbLayer.make({ ...destination, login: L${i}, password, verify })`,
		`export type y${i} = Expect<Equals<typeof n${i}, Layer.Layer<${services}, OpenError>>>`,
		...(verdict.opener
			? []
			: ["// @ts-expect-error -- TS2739: Db.open takes a role reached through its login"]),
		`export const w${i} = Db.open(${openerSource(spec, i)}, { token: "token" })`,
		...(verdict.options ? [] : [optionDirective(spec.options)]),
		`export const u${i} = Db.open(L${i}.roles.${spec.roles[0].name}${optionValues[spec.options].source})`,
		`export const b${i} = (db: DbOf<typeof ${defined(roleIds[spec.base.role], "the base program's role")}, unknown>) =>`,
		...(verdict.base ? [] : [`\t// @ts-expect-error -- TS2345 refusal: ${baseRefusal}`]),
		`\tdb.execute(${spec.base.program}, {})`,
		programSource(programRole, spec.program.context, i),
		`export const x${i} = (db: DbOf<typeof ${programRole}, unknown>) =>`,
		...(verdict.program ? [] : [`\t// @ts-expect-error -- TS2345 refusal: ${contextRefusal}`]),
		`\t${run}`,
		`export const f${i} = (db: DbOf<typeof ${refreshRole}, unknown>) =>`,
		...(verdict.refresh
			? []
			: [
					"\t// @ts-expect-error -- TS2345: a refresh names derived relations of the role's refresh list"
				]),
		`\tdb.refresh(${Arr.join(spec.refresh.names, ", ")})`,
		...(verdict.refresh
			? [
					`export type g${i} = Expect<Equals<ReturnType<typeof f${i}>, Effect.Effect<void, ApplyError>>>`
				]
			: []),
		""
	]
}

/** The situations the floor's witnesses reach: every place, and each probe under both verdicts. */
export const accessRequired: Situations<AccessNote> = [
	...Arr.map(places, (p): AccessNote => `a context read: ${p}`),
	"open admitted",
	"open refused",
	"verify required",
	"verify optional",
	"execute admitted",
	"execute refused",
	"compile admitted",
	"compile refused",
	"apply admitted",
	"apply refused",
	"refresh admitted",
	"refresh refused",
	"login role admitted",
	"role value refused",
	"schema refused",
	"options omitted refused",
	"options null refused",
	"options a token admitted",
	"options a token of another type refused",
	"base accountIds admitted",
	"base accountIds refused",
	"base accountSeats admitted",
	"base accountSeats refused",
	"two roles",
	"over an extension"
]

/** The logins the run's own stream draws, beside the floor's witnesses. */
export const accessCount = 60

const accessLabel = "types/api access agreement"

export const accessWitnesses = () =>
	floorPopulation(accessLabel, caseGen, accessCount, (c) => [...c.notes])

const accessCases = (seed: number): ReadonlyArray<AccessCase> => [
	...accessWitnesses().values,
	...sample(caseGen, rotatingSeed(seed, floorSeed(accessLabel)), accessCount)
]

/** The access program's prelude (test/support/programs/access.ts), every name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/access.ts"))

export const accessEntriesFrom = (entry: (path: string) => string): PreludeAt =>
	preludeFrom(prelude, entry)

/** The program over the run's cases: one module, its imports the names its declarations and blocks read. */
export const accessModule = (entries: PreludeAt, seed: number): string => {
	const text = Arr.join(
		[
			"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
			"type Expect<T extends true> = T",
			'declare const destination: Omit<DbConfigShape<typeof L0>, "login" | "password" | "verify" | "attachPool">',
			"declare const password: Redacted.Redacted",
			"declare const verify: Verify",
			"",
			...Arr.flatMap(accessCases(seed), blockOf),
			""
		],
		"\n"
	)
	return Arr.join(
		[
			"// Generated by test/support/agreement/access.ts: the access type/engine agreement.",
			...preludeImports(entries, identifiers(text)),
			"",
			text
		],
		"\n"
	)
}
