import { floorPopulation, type Situations } from "@grizzle/testing/features"
import { array, element, type Gen, int } from "@grizzle/testing/gen"
import { floorSeed, rotatingSeed } from "@grizzle/testing/random"
import { sample, type Source } from "@grizzle/testing/source"
import { Array as Arr, Effect, Result as EffectResult, Record as Rec } from "effect"
import { isServedRole, openToken } from "#adapter/db/served.ts"
import { refreshTargets } from "#adapter/refresh/targets.ts"
import { served } from "#adapter/served/served.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { lawsOf } from "#compiler/program/laws.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { schema } from "#compiler/schema/schema.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import { login, role, roleDescOf, wholeEntriesOf, writableNamesOf } from "#compiler/schema/world.ts"
import type { TypeRefusal } from "#compiler/types/core/phantom.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type { AnyRole, EntryValue, RoleOptionRecord } from "#compiler/types/schema/world.ts"
import {
	Account,
	AccountNames,
	accountIds,
	accountSeats,
	accountTasks,
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
import { preludeAt, type PreludeAt, preludeFrom, preludeProgram } from "#test/support/prelude.ts"

/**
 * The access agreement: logins of roles drawn over ./access-schema.ts, each role's Task entry reading a context at a
 * drawn place or none, and the one TypeScript program that states, of every login, what its types admit, which the
 * type tier checks (test/types/api/access.test.ts). The engine is the oracle, as the runtime and generate read a role: the
 * contexts its relations read (schema/walk.ts queryUses of each query entry, as pool/registry.ts reads them), its
 * compilation of a program for the role, as a workload over the role compiles each member (a program matching a context
 * the role reads none of is refused), and the resolution of the relations a refresh member names (refresh/targets.ts).
 * Of each drawn login:
 *
 * - Db.open of each of its roles without a token typechecks exactly when the role's relations read no context, and
 *   with one always, delivering exactly a Db of the role it opened, over the base or an extension, its services
 *   exactly the role's DbLayer and its error OpenError;
 * - DbLayer.make without verify typechecks exactly when no role of the login reads a context, and with verify its
 *   layer provides exactly the DbLayer of each of the login's roles, failing with OpenError;
 * - a program over a role matching a drawn context, a member of a workload over the role as a query or as a ChangeSet's
 *   read-back, typechecks exactly when the engine compiles it for the role;
 * - a refresh member, refresh(relations), of drawn derived relations in a workload over a role typechecks exactly when
 *   the engine resolves every one against the role's refresh list, and its handle succeeds with nothing and fails with
 *   ApplyError;
 * - Db.open of a role of the login's served workload (served<typeof L>(file, name).roles), of the role reached through
 *   the login value itself, of the role value itself, or of the schema typechecks exactly when Db.open's boundary reads
 *   its argument as a served login's role (db/served.ts isServedRole);
 * - Db.open given no options, null, a token, or a token of another type than text typechecks exactly when Db.open's
 *   boundary reads them (db/served.ts openToken), refusing what a JavaScript caller passes at stage schema: no options
 *   at the call's arity (TS2554), null as the argument (TS2345), and another token at the token (TS2322);
 * - a program over the base, reading its ordinary relations alone or the closed relation's rows too, a member of a
 *   workload over a role, typechecks exactly when the engine compiles it for the role: a role holding every relation of
 *   the base whole but the closed one, whose rows every role reads, runs it, and a role holding one only through a query
 *   entry refuses it (OutsideRole);
 * - a full role over the level, its entries wholeEntriesOf(level) and its write list none, writableNamesOf(level),
 *   those and a name role refuses to write, or a drawn list that may name one twice, and a drawn refresh list,
 *   typechecks exactly when role(...) builds it, refused for naming one twice exactly when the engine admits each name
 *   of the list alone and refuses the list, and then its relations' names and its write list are exactly those of the
 *   engine's Description of it, and a program over the base reading the closed relation, and one over the level (over
 *   Reports, matching its live derived relation, which no role holds), are members of a workload over it exactly when
 *   the engine compiles them there;
 * - each builder that takes a schema (role, login, schema.extend, wholeEntriesOf, writableNamesOf, lawsOf), given the
 *   level or the case's first role value, typechecks exactly when the engine admits its base: a role is no schema.
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

/**
 * What Db.open is given: a role of the login's served workload, the role reached through the login value itself, the
 * role value itself, or the schema.
 */
const openers = ["served role", "login role", "role value", "schema"] as const
type Opener = (typeof openers)[number]

/** A program over the base: one reading its ordinary relations alone, and one matching the closed relation too. */
const basePrograms = ["accountIds", "accountSeats"] as const
type BaseProgram = (typeof basePrograms)[number]
const baseValues: { readonly [P in BaseProgram]: object } = { accountIds, accountSeats }

/**
 * The program over each level a full role of that level runs: over Work, one reading its ordinary relations; over
 * Reports, one matching its live derived relation, which no role holds, so a full role holds Reports whole without it.
 */
const levelPrograms = { Work: "accountIds", Reports: "accountTasks" } as const
const levelValues: { readonly [L in keyof typeof levelPrograms]: object } = {
	Work: accountIds,
	Reports: accountTasks
}

/** The directive of an opener that is no served login's role: the diagnostic it raises at Db.open's argument. */
const openerDirective = (opener: Opener): string => {
	switch (opener) {
		case "served role":
			throw new Error("Db.open's boundary refuses a served login's role")
		case "login role":
		case "role value":
		case "schema":
			return "// @ts-expect-error -- TS2345: Db.open takes a role of a served login"
	}
}

/**
 * The served workload's JSON members served(...) reads, of a case's login: its base, its PostgreSQL role and its
 * roles' names, as `grizzle generate` writes them; nothing else of it is read before a layer is built.
 */
const servedHead = (spec: AccessSpec): object => ({
	base: spec.level,
	role: "agreement",
	roles: Arr.map(spec.roles, (r) => ({ name: r.name }))
})

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

/** How a workload over a role serves a program: as a query member, or as the read-back of a ChangeSet member. */
const entries = ["query", "read-back"] as const
type Entry = (typeof entries)[number]

/**
 * Every name of either level a full role's lists draw from: Work's relations, the closed TierInfo among them, then
 * Reports' derived relations.
 */
const levelNames = ["Tier", "TierInfo", "Account", "Task", ...derivedNames] as const
type LevelName = (typeof levelNames)[number]

/**
 * The names role refuses in a full role's write list, the stray after writableNamesOf: the roster, the closed relation,
 * and each derived relation. A second copy of a name writableNamesOf holds is no stray: that list's length is unknown
 * to the types, so they see no repeat in it; the listed kind draws the repeats a list's type shows.
 */
const strayNames = ["Tier", "TierInfo", ...derivedNames] as const
type StrayName = (typeof strayNames)[number]

/** The names writableNamesOf gives over either level: its ordinary relations, which a full role writes whole. */
const writableNames = ["Account", "Task"] as const

/**
 * A full role's write list, as the program spells it: left out, every relation it may write (writableNamesOf), those
 * and a stray, or a drawn list of the names it may write, perhaps one of them twice, and perhaps one more of the
 * level's names.
 */
type FullWrite =
	| { readonly kind: "omitted" }
	| { readonly kind: "every" }
	| { readonly kind: "every and"; readonly stray: StrayName }
	| { readonly kind: "listed"; readonly names: ReadonlyArray<LevelName> }

/** A full role over the case's level: its base's whole entries (wholeEntriesOf), and its write and refresh lists. */
interface FullSpec {
	readonly write: FullWrite
	readonly refresh: ReadonlyArray<LevelName>
}

/** The builders that take a schema, each of which a case gives a base of its own. */
const schemaTakers = [
	"role",
	"login",
	"schema.extend",
	"wholeEntriesOf",
	"writableNamesOf",
	"lawsOf"
] as const
type SchemaTaker = (typeof schemaTakers)[number]

/** What a schema-taking builder is given: the case's level, or its first role's value, which is no schema. */
const baseKinds = ["schema", "role"] as const
type BaseKind = (typeof baseKinds)[number]

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
	/** A full role over the level, outside the login. */
	readonly full: FullSpec
	/** Each builder that takes a schema, given the level or the first role's value. */
	readonly over: { readonly [B in SchemaTaker]: BaseKind }
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
	| `full ${"admitted" | "refused"}`
	| `full over ${AccessSpec["level"]} runs its program ${"admitted" | "refused"}`
	| `full write ${FullWrite["kind"]}`
	| "full write repeated"
	| `${SchemaTaker} over a ${BaseKind} ${"admitted" | "refused"}`
	| "two roles"
	| "over an extension"

const coin = (source: Source, odds: number): boolean => source.draw(int(1, odds)) === 1

const fullWriteKinds = ["omitted", "every", "every and", "listed"] as const satisfies ReadonlyArray<
	FullWrite["kind"]
>

const fullWriteGen: Gen<FullWrite> = (source) => {
	const kind = source.draw(element(fullWriteKinds))
	switch (kind) {
		case "omitted":
			return { kind }
		case "every":
			return { kind }
		case "every and":
			return { kind, stray: source.draw(element(strayNames)) }
		case "listed":
			return {
				kind,
				names: [
					...source.draw(array(element(writableNames), { min: 0, max: 3 })),
					...(coin(source, 2) ? [] : [source.draw(element(levelNames))])
				]
			}
	}
}

const fullGen: Gen<FullSpec> = (source) => ({
	write: fullWriteGen(source),
	refresh: coin(source, 2) ? [] : Arr.filter(levelNames, () => coin(source, 3))
})

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
		},
		full: fullGen(source),
		over: {
			role: source.draw(element(baseKinds)),
			login: source.draw(element(baseKinds)),
			"schema.extend": source.draw(element(baseKinds)),
			wholeEntriesOf: source.draw(element(baseKinds)),
			writableNamesOf: source.draw(element(baseKinds)),
			lawsOf: source.draw(element(baseKinds))
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
	/** Whether Db.open's boundary reads the drawn options (db/served.ts openToken). */
	readonly options: boolean
	/** Whether the engine compiles the program over the base for the role (OutsideRole for a partial role). */
	readonly base: boolean
	readonly full: FullVerdict
	/** Whether each schema-taking builder admits the base it is given. */
	readonly over: { readonly [B in SchemaTaker]: boolean }
}

/**
 * The engine's reading of a case's full role: refused by role(...), for a repeat in its write list or not, or admitted
 * with the names of its entries and its write list as its Description holds them, and whether the program over the
 * base matching the closed relation and the program over its level (levelPrograms) compile for it.
 */
type FullVerdict =
	| { readonly kind: "refused"; readonly repeat: boolean }
	| {
			readonly kind: "admitted"
			readonly entries: ReadonlyArray<string>
			readonly write: ReadonlyArray<string>
			readonly base: boolean
			readonly level: boolean
	  }

/** A full role's options as a JavaScript caller passes them, its write list made by the helpers the program calls. */
const fullOptions = (
	full: FullSpec,
	level: typeof Work | typeof Reports
): RoleOptionRecord<ReadonlyArray<string>, ReadonlyArray<string>> => {
	switch (full.write.kind) {
		case "omitted":
			return { refresh: full.refresh }
		case "every":
			return { write: writableNamesOf(level), refresh: full.refresh }
		case "every and":
			return { write: [...writableNamesOf(level), full.write.stray], refresh: full.refresh }
		case "listed":
			return { write: full.write.names, refresh: full.refresh }
	}
}

/**
 * The case's full role, built by role(...) over wholeEntriesOf(level) as the program builds it, as the engine reads
 * it.
 */
const fullVerdictOf = (spec: AccessSpec): FullVerdict => {
	const level = spec.level === "Reports" ? Reports : Work
	const options = fullOptions(spec.full, level)
	const built = catchCompileError(() => role(level, "full", wholeEntriesOf(level), options))
	if (!built.ok) {
		const writes = (names: ReadonlyArray<string>): boolean =>
			catchCompileError(() => role(level, "writes", wholeEntriesOf(level), { write: names })).ok
		const list = options.write
		return {
			kind: "refused",
			repeat: list !== undefined && !writes(list) && Arr.every(list, (n) => writes([n]))
		}
	}
	const desc = roleDescOf(built.value)
	if (desc === undefined) {
		throw new Error("role(...) describes every role it builds")
	}
	return {
		kind: "admitted",
		entries: Arr.map(desc.relations, (entry) => entry.name),
		write: desc.write,
		base: compileTemplate(accountSeats, built.value, testCompile).ok,
		level: compileTemplate(levelValues[spec.level], built.value, testCompile).ok
	}
}

/** The builders that take a schema, as a JavaScript caller sees them, taking any base at all. */
interface SchemaTaking {
	role(base: unknown, name: string, relations: Readonly<Record<string, EntryValue>>): unknown
	login(base: unknown, name: string, roles: readonly [AnyRole], options: readonly []): unknown
	extend(
		base: unknown,
		name: string,
		relations: Readonly<Record<string, never>>,
		statements: readonly [],
		extra: readonly []
	): unknown
	wholeEntriesOf(base: unknown): unknown
	writableNamesOf(base: unknown): unknown
	lawsOf(base: unknown): unknown
}
const schemaTaking: SchemaTaking = {
	role,
	login,
	extend: schema.extend,
	wholeEntriesOf,
	writableNamesOf,
	lawsOf
}

/** Whether a schema-taking builder admits the base the case gives it, the level or the first role's value. */
const overVerdictOf = (spec: AccessSpec, first: AnyRole, builder: SchemaTaker): boolean => {
	const level = spec.level === "Reports" ? Reports : Work
	const base: unknown = spec.over[builder] === "schema" ? level : first
	return catchCompileError(() => {
		switch (builder) {
			case "role":
				return schemaTaking.role(base, "over", { Account })
			case "login":
				return schemaTaking.login(base, "over", [role(level, "taken", { Account })], [])
			case "schema.extend":
				return schemaTaking.extend(base, "Over", {}, [], [])
			case "wholeEntriesOf":
				return schemaTaking.wholeEntriesOf(base)
			case "writableNamesOf":
				return schemaTaking.writableNamesOf(base)
			case "lawsOf":
				return schemaTaking.lawsOf(base)
		}
	}).ok
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
		spec.opener === "served role"
			? served(servedHead(spec), "agreement").roles[first]
			: spec.opener === "login role"
				? built.roles[first]
				: spec.opener === "role value"
					? values[0]
					: level
	return {
		reads,
		program: program.ok,
		refresh: EffectResult.isSuccess(refresh),
		opener: isServedRole(opened),
		options: EffectResult.isSuccess(openToken(optionValues[spec.options].value)),
		base: compileTemplate(
			baseValues[spec.base.program],
			defined(values[spec.base.role], "the base program's role"),
			testCompile
		).ok,
		full: fullVerdictOf(spec),
		over: {
			role: overVerdictOf(spec, values[0], "role"),
			login: overVerdictOf(spec, values[0], "login"),
			"schema.extend": overVerdictOf(spec, values[0], "schema.extend"),
			wholeEntriesOf: overVerdictOf(spec, values[0], "wholeEntriesOf"),
			writableNamesOf: overVerdictOf(spec, values[0], "writableNamesOf"),
			lawsOf: overVerdictOf(spec, values[0], "lawsOf")
		}
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
	notes.add(`full ${verdict.full.kind}`)
	if (verdict.full.kind === "admitted") {
		notes.add(
			`full over ${spec.level} runs its program ${verdict.full.level ? "admitted" : "refused"}`
		)
	}
	notes.add(`full write ${spec.full.write.kind}`)
	if (verdict.full.kind === "refused" && verdict.full.repeat) {
		notes.add("full write repeated")
	}
	for (const builder of schemaTakers) {
		notes.add(
			`${builder} over a ${spec.over[builder]} ${verdict.over[builder] ? "admitted" : "refused"}`
		)
	}
	if (spec.roles.length > 1) {
		notes.add("two roles")
	}
	if (spec.level === "Reports") {
		notes.add("over an extension")
	}
	return { spec, verdict, notes }
}

/** The refusal a full role's write list takes when it names a relation twice. */
const repeatRefusal: TypeRefusal = "a write list names each role relation once"

const contextRefusal: TypeRefusal =
	"a program on a Db of a role matches only the contexts the role's relations read, whose facts its claims hold"

/** The directive of a workload member over no level of the workload's schema, as workload(...) refuses it. */
const levelDirective =
	"// @ts-expect-error -- TS2322: a program over a level of the workload's schema, or a key of a relation of one"

/** A role's declaration, in the program. */
const roleSource = (spec: AccessSpec, r: RoleSpec, i: number): string =>
	`export const R${i}_${r.name} = role(${spec.level}, ${jsonText(r.name)}, { ${Arr.join(
		Arr.map(roleEntries(spec, r), ([name, value]) => `${name}: ${value}`),
		", "
	)} }${spec.level === "Reports" ? `, { refresh: [${Arr.join(Arr.map(r.refresh, jsonText), ", ")}] }` : ""})`

/** The program over a role matching a context, in the program. */
const programSource = (roleId: string, context: ContextName, i: number): string =>
	`export const p${i} = query(${roleId}).rule((r) => { const { id, name } = v(${roleId}.relations.Account, "account"); return r.match(${roleId}.relations.Account, { id, name })${context === "Org" ? ".match(Org, { id })" : ".match(Session, { sub: name })"}.find({ id }) })`

/** A full role's options, in the program. */
const fullOptionsSource = (full: FullSpec, level: AccessSpec["level"]): string => {
	const refresh = `refresh: [${Arr.join(Arr.map(full.refresh, jsonText), ", ")}]`
	switch (full.write.kind) {
		case "omitted":
			return `{ ${refresh} }`
		case "every":
			return `{ write: writableNamesOf(${level}), ${refresh} }`
		case "every and":
			return `{ write: [...writableNamesOf(${level}), ${jsonText(full.write.stray)}], ${refresh} }`
		case "listed":
			return `{ write: [${Arr.join(Arr.map(full.write.names, jsonText), ", ")}], ${refresh} }`
	}
}

/** Names as the union type the program states, never for none. */
const unionOf = (names: ReadonlyArray<string>): string =>
	Arr.isReadonlyArrayNonEmpty(names) ? Arr.join(Arr.map(names, jsonText), " | ") : "never"

/**
 * A case's full role, in the program: under its directive where role(...) refuses it, and otherwise followed by its
 * relations' names and its write list stated as the engine's, and the program over the base matching the closed
 * relation and the program over its level, each a member of a workload over it, under the engine's verdicts.
 */
const fullBlock = (spec: AccessSpec, verdict: FullVerdict, i: number): ReadonlyArray<string> => {
	const declaration = `export const F${i} = role(${spec.level}, "f${i}", wholeEntriesOf(${spec.level}), ${fullOptionsSource(spec.full, spec.level)})`
	switch (verdict.kind) {
		case "refused":
			return [
				verdict.repeat
					? `// @ts-expect-error -- TS2345 refusal: ${repeatRefusal}`
					: "// @ts-expect-error -- TS2345: role refuses the full role's write or refresh list",
				declaration
			]
		case "admitted":
			return [
				declaration,
				`export type fe${i} = Expect<Equals<keyof (typeof F${i})["relations"], ${unionOf(verdict.entries)}>>`,
				`export type fw${i} = Expect<Equals<WriteListOf<typeof F${i}>, ${unionOf(verdict.write)}>>`,
				...(verdict.base ? [] : [levelDirective]),
				`export const fb${i} = workload(F${i}, { p: accountSeats })`,
				...(verdict.level ? [] : [levelDirective]),
				`export const fl${i} = workload(F${i}, { p: ${levelPrograms[spec.level]} })`
			]
	}
}

/** A schema-taking builder given its base, in the program: under its directive where the engine refuses the base. */
const overLines = (
	spec: AccessSpec,
	builder: SchemaTaker,
	admitted: boolean,
	i: number
): ReadonlyArray<string> => {
	const base = spec.over[builder] === "schema" ? spec.level : `R${i}_${spec.roles[0].name}`
	const call = (() => {
		switch (builder) {
			case "role":
				return `role(${base}, "b${i}", { Account })`
			case "login":
				return `login(${base}, "b${i}", [role(${spec.level}, "c${i}", { Account })])`
			case "schema.extend":
				return `schema.extend(${base}, "Over", {}, [])`
			case "wholeEntriesOf":
				return `wholeEntriesOf(${base})`
			case "writableNamesOf":
				return `writableNamesOf(${base})`
			case "lawsOf":
				return `lawsOf(${base})`
		}
	})()
	return [
		...(admitted
			? []
			: [`// @ts-expect-error -- TS2345: ${builder} takes a schema, and a role is none`]),
		`export const B${i}_${schemaTakers.indexOf(builder)} = ${call}`
	]
}

/** Db.open's first argument, in the program. */
const openerSource = (spec: AccessSpec, i: number): string => {
	const first = spec.roles[0].name
	switch (spec.opener) {
		case "served role":
			return `S${i}.roles.${first}`
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
		`export const o${i}_${r.name} = Db.open(S${i}.roles.${r.name}, {})`,
		`export const t${i}_${r.name} = Db.open(S${i}.roles.${r.name}, { token: "token" })`,
		`export type s${i}_${r.name} = [Expect<Equals<Effect.Services<typeof t${i}_${r.name}>, DbLayer<typeof R${i}_${r.name}>>>, Expect<Equals<Effect.Error<typeof t${i}_${r.name}>, OpenError>>, Expect<Equals<Effect.Success<typeof t${i}_${r.name}>, DbOf<typeof R${i}_${r.name}, unknown>>>]`
	])
	const programRole = defined(roleIds[spec.program.role], "the program's role")
	const served = (() => {
		switch (spec.program.entry) {
			case "query":
				return `p${i}`
			case "read-back":
				return `ChangeSet.empty(${programRole}).read("rows", () => p${i})`
		}
	})()
	const refreshRole = defined(roleIds[spec.refresh.role], "the refresh's role")
	return [
		...Arr.map(spec.roles, (r) => roleSource(spec, r, i)),
		`export const L${i} = login(${spec.level}, "l${i}", [${Arr.join(roleIds, ", ")}])`,
		`export const S${i} = served<typeof L${i}>(file, "l${i}")`,
		...opens,
		...(Arr.some(verdict.reads, (x) => x)
			? [
					"// @ts-expect-error -- TS2345: a role of the login reads a context, so its layer needs verify"
				]
			: []),
		`export const m${i} = DbLayer.make({ ...destination, login: S${i}, password })`,
		`export const n${i} = DbLayer.make({ ...destination, login: S${i}, password, verify })`,
		`export type y${i} = Expect<Equals<typeof n${i}, Layer.Layer<${services}, OpenError>>>`,
		...(verdict.opener ? [] : [openerDirective(spec.opener)]),
		`export const w${i} = Db.open(${openerSource(spec, i)}, { token: "token" })`,
		...(verdict.options ? [] : [optionDirective(spec.options)]),
		`export const u${i} = Db.open(S${i}.roles.${spec.roles[0].name}${optionValues[spec.options].source})`,
		...(verdict.base ? [] : [levelDirective]),
		`export const b${i} = workload(${defined(roleIds[spec.base.role], "the base program's role")}, { p: ${spec.base.program} })`,
		programSource(programRole, spec.program.context, i),
		...(verdict.program ? [] : [`// @ts-expect-error -- TS2322 refusal: ${contextRefusal}`]),
		`export const x${i} = workload(${programRole}, { p: ${served} })`,
		...(verdict.refresh
			? []
			: [
					"// @ts-expect-error -- TS2322: a refresh member names derived relations of its role's refresh list"
				]),
		`export const f${i} = workload(${refreshRole}, { r: refresh([${Arr.join(spec.refresh.names, ", ")}]) })`,
		...(verdict.refresh
			? [
					`export const h${i} = (db: DbOf<typeof ${refreshRole}, typeof f${i}.programs>) => db.workload.r.refresh`,
					`export type g${i} = Expect<Equals<ReturnType<typeof h${i}>, Effect.Effect<void, ApplyError>>>`
				]
			: []),
		...fullBlock(spec, verdict.full, i),
		...Arr.flatMap(schemaTakers, (builder) => overLines(spec, builder, verdict.over[builder], i)),
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
	"query admitted",
	"query refused",
	"read-back admitted",
	"read-back refused",
	"refresh admitted",
	"refresh refused",
	"served role admitted",
	"login role refused",
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
	"full admitted",
	"full refused",
	"full over Work runs its program admitted",
	"full over Reports runs its program admitted",
	...Arr.map(fullWriteKinds, (kind): AccessNote => `full write ${kind}`),
	"full write repeated",
	...Arr.flatMap(schemaTakers, (builder): ReadonlyArray<AccessNote> => [
		`${builder} over a schema admitted`,
		`${builder} over a role refused`
	]),
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
			"declare const file: unknown",
			"",
			...Arr.flatMap(accessCases(seed), blockOf),
			""
		],
		"\n"
	)
	return preludeProgram(
		"// Generated by test/support/agreement/access.ts: the access type/engine agreement.",
		entries,
		text
	)
}
