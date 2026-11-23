import * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined } from "@bjornpagen/testing/assert"
import type { Situations } from "@bjornpagen/testing/features"
import { type Aimed, aimed, array, element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { Array as Arr, Effect, Result as EffectResult, Record as Rec } from "effect"
import { openOptions } from "#adapter/db/served.ts"
import { readServedRole } from "#adapter/pool/served.ts"
import { served } from "#adapter/served/served.ts"
import { catchCompileError } from "#compiler/core/canonical.ts"
import type { Refused } from "#compiler/core/refusals.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { writtenNames } from "#compiler/ir/desc.ts"
import { lawsOf } from "#compiler/program/laws.ts"
import { type QueryValue, queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { queryDescOf } from "#compiler/schema/protocol.ts"
import { schemaBuilder as schema } from "#compiler/schema/schema.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import {
	loginBuilder as login,
	roleBuilder as role,
	roleDescOf,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/schema/world.ts"
import type { AnyDerived } from "#compiler/types/derived/derived.ts"
import type {
	AnyContext,
	AnyRole,
	EntryValue,
	RoleOptionRecord
} from "#compiler/types/schema/world.ts"
import {
	Account,
	AccountNames,
	accountIds,
	accountOrg,
	accountSeats,
	accountSession,
	accountTasks,
	Org,
	Reports,
	Session,
	Task,
	taskImported,
	taskNegated,
	taskOrg,
	taskPlain,
	taskSession,
	taskStaged,
	Tier,
	Work
} from "#test/support/agreement/access-schema.ts"
import { compileTemplate, testCompile } from "#test/support/compile.ts"
import { compiledServedFile } from "#test/support/compiled-served.ts"
import { preludeAt, preludeFrom, preludeModule } from "#test/support/prelude.ts"
import {
	batchOwned,
	caseOwned,
	type Entry as ProgramEntry,
	type Program
} from "#test/types/batch/batch.ts"

/**
 * The access agreement: logins of roles drawn over ./access-schema.ts, each role's Task entry reading a context at a
 * drawn place or none and each role declaring the contexts its Task entry reads and a drawn few more, and the one
 * TypeScript program that states, of every login, what its types admit, which the type tier checks
 * (test/types/api/access.test.ts). The engine is the oracle, as the runtime and generate read a role: the contexts its
 * Description declares (RoleDesc.contexts, which ownership holds as OwnedRole.contexts, the served file's and the
 * layer's), role(...)'s admission of a role whose query entry matches a context it may not declare, its compilation of a
 * program for the role, as a workload over the role compiles each member (a program matching a context the role does
 * not declare is refused, OutsideRole context). Of each drawn login:
 *
 * - Db.open of each of its roles without a token typechecks exactly when the role declares no context, and with one
 *   always, delivering exactly a Db of the role it opened, over the base or an extension, its services exactly the
 *   role's DbLayer and its error OpenError;
 * - DbLayer.make without verify typechecks exactly when no role of the login declares a context, and with verify its
 *   layer provides exactly the DbLayer of each of the login's roles, failing with OpenError;
 * - a program over a role matching a drawn context, a member of a workload over the role as a query or as a ChangeSet's
 *   read-back, typechecks exactly when the engine compiles it for the role;
 * - a role outside the login, its Task entry at a drawn place and its declared contexts a drawn subset of Org and
 *   Session, which may leave out a context its entry reads, typechecks exactly when role(...) builds it, refused
 *   exactly where the entry matches a context it does not declare (RoleRefused entryContext);
 * - Db.open of a role of the login's served workload (served<typeof L>(file, name).roles), of the role reached through
 *   the login value itself, of the role value itself, or of the schema typechecks exactly when Db.open's boundary reads
 *   its argument as a served login's role (pool/served.ts readServedRole);
 * - Db.open given no options, null, a token, or a token of another type than text typechecks exactly when Db.open's
 *   boundary reads them (db/served.ts openOptions), refusing what a JavaScript caller passes at stage schema: no options,
 *   null as the argument, and another token;
 * - a program over the base, reading its ordinary relations alone or the closed relation's rows too, a member of a
 *   workload over a role, typechecks exactly when the engine compiles it for the role: a role holding every relation of
 *   the base whole but the closed one, whose rows every role reads, runs it, and a role holding one only through a query
 *   entry refuses it (OutsideRole);
 * - each role's laws, its statements' type, are exactly the base's laws role(...) keeps for it, each one whose every
 *   relation is a whole entry of the role under its own name (schema/world.ts namesOf against the admitted whole
 *   names), and a full role's likewise: a law over Task is dropped by a role holding Task through a query entry, under
 *   Task's own name;
 * - a full role over the level, its entries wholeEntriesOf(level) and its write list none, writableNamesOf(level),
 *   those and a name role refuses to write, or a drawn list that may name one twice,
 *   typechecks exactly when role(...) builds it, refused for naming one twice exactly when the engine admits each name
 *   of the list alone and refuses the list, and then its relations' names and its write list are exactly those of the
 *   engine's Description of it, and a program over the base reading the closed relation, and one over the level (over
 *   Reports, matching its live derived relation, which no role holds), are members of a workload over it exactly when
 *   the engine compiles them there, and so is a program over the base matching a drawn context, which the full role
 *   runs exactly when it declares that context: one program over the base serves every full role declaring what it
 *   matches;
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

const derivedNames = ["AccountNames"] as const
type DerivedName = (typeof derivedNames)[number]
const derivedValues: { readonly [D in DerivedName]: AnyDerived } = { AccountNames }

const contextNames = ["Org", "Session"] as const
type ContextName = (typeof contextNames)[number]
const contextValues: { readonly [C in ContextName]: AnyContext } = { Org, Session }

/** The program over the base matching each context, by the name the program imports it under. */
const baseMatching: { readonly [C in ContextName]: readonly [string, object] } = {
	Org: ["accountOrg", accountOrg],
	Session: ["accountSession", accountSession]
}

/** The contexts a place's Task entry matches, as the engine reads its definition (schema/walk.ts queryUses). */
const entryReads = (place: Place): ReadonlyArray<ContextName> => {
	if (place === "whole") {
		return []
	}
	const uses = queryUses(queryDescOf(taskEntry[place][1], `Task at ${place}`))
	return Arr.filter(contextNames, (c) => uses.contexts.has(c))
}

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

/** The directive of an opener that is no served login's role: Db.open's argument refuses it. */
const openerDirective = (opener: Opener): string => {
	switch (opener) {
		case "served role":
			throw new Error("Db.open's boundary refuses a served login's role")
		case "login role":
			return "// @ts-expect-error -- refused: Db.open takes a role of a served login, and a login's role lacks its base"
		case "role value":
		case "schema":
			return "// @ts-expect-error -- refused: Db.open takes a role of a served login"
	}
}

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
 * Why each malformed form is refused: the call's arity, the argument, or the token's property. A text token is well
 * formed, so the boundary refusing one is a defect the agreement reports.
 */
const optionRefusals: { readonly [F in Exclude<OptionForm, "a token">]: string } = {
	omitted: "Db.open needs its options",
	null: "Db.open's options are an object",
	"a token of another type": "Db.open's token is text"
}

/** The directive of options the boundary refuses. */
const optionDirective = (form: OptionForm): string => {
	if (form === "a token") {
		throw new Error("Db.open's boundary refuses a text token")
	}
	return `// @ts-expect-error -- refused: ${optionRefusals[form]}`
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

/**
 * A full role over the case's level: its base's whole entries (wholeEntriesOf), its write list, the contexts it declares, and the context the program over the base it is given matches.
 */
interface FullSpec {
	readonly write: FullWrite
	readonly contexts: ReadonlyArray<ContextName>
	readonly matches: ContextName
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

/**
 * One role of a case's login: its Task entry's place, and the contexts it declares beyond those its Task entry reads.
 */
interface RoleSpec {
	readonly name: string
	readonly place: Place
	readonly extra: ReadonlyArray<ContextName>
}

/** A role outside the login: its Task entry's place and the contexts it declares, any subset of the two. */
interface StraySpec {
	readonly place: Place
	readonly contexts: ReadonlyArray<ContextName>
}

interface AccessSpec {
	readonly level: "Work" | "Reports"
	readonly roles: Arr.NonEmptyReadonlyArray<RoleSpec>
	/** The role a program runs on, the context it matches and how it runs. */
	readonly program: { readonly role: number; readonly context: ContextName; readonly entry: Entry }
	/** What a further Db.open is given, of its first role. */
	readonly opener: Opener
	/** What Db.open of its first role is given as options. */
	readonly options: OptionForm
	/** A program over the base a role's Db executes: its role, and whether it matches the closed relation. */
	readonly base: { readonly role: number; readonly program: BaseProgram }
	/** A full role over the level, outside the login. */
	readonly full: FullSpec
	/** A role outside the login whose declaration may leave out a context its Task entry reads. */
	readonly stray: StraySpec
	/** Each builder that takes a schema, given the level or the first role's value. */
	readonly over: { readonly [B in SchemaTaker]: BaseKind }
}

/** What a case reached: each role's place and every verdict. */
export type AccessNote =
	| `a context read: ${Place}`
	| `open ${"admitted" | "refused"}`
	| `verify ${"required" | "optional"}`
	| `${Entry} ${"admitted" | "refused"}`
	| `${Opener} ${"admitted" | "refused"}`
	| `options ${OptionForm} ${"admitted" | "refused"}`
	| `base ${BaseProgram} ${"admitted" | "refused"}`
	| `full ${"admitted" | "refused"}`
	| `full over ${AccessSpec["level"]} runs its program ${"admitted" | "refused"}`
	| `full write ${FullWrite["kind"]}`
	| "full write repeated"
	| `full matches a context ${"admitted" | "refused"}`
	| `stray ${"admitted" | "refused"}`
	| "declared beyond its relations"
	| `${SchemaTaker} over a ${BaseKind} ${"admitted" | "refused"}`
	| `law ${"kept" | "dropped"}`
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

/** A drawn subset of the contexts, in their order. */
const contextsGen: Gen<ReadonlyArray<ContextName>> = (source) =>
	Arr.filter(contextNames, () => coin(source, 2))

const fullGen: Gen<FullSpec> = (source) => ({
	write: fullWriteGen(source),
	contexts: contextsGen(source),
	matches: source.draw(element(contextNames))
})

/** What a login's role is drawn as beside its name: its Task entry's place and the contexts it declares beyond it. */
type RoleDraw = Gen<Omit<RoleSpec, "name">>

/** A role drawn anywhere: its Task entry at a drawn place, a drawn subset of the contexts declared beyond it. */
const anyRole: RoleDraw = (source) => ({
	place: source.draw(element(places)),
	extra: contextsGen(source)
})

/** A role that reads no context: Task whole, which matches none, and no context declared beyond it. */
const contextFreeRole: RoleDraw = () => ({ place: "whole", extra: [] })

/** A login whose roles are each drawn as `role` draws one, and everything else about it drawn. */
const specOf =
	(role: RoleDraw): Gen<AccessSpec> =>
	(source) => {
		const level = coin(source, 2) ? "Reports" : "Work"
		const count = source.draw(int(1, 2))
		const roleSpec = (at: number): RoleSpec => ({ name: `r${at}`, ...role(source) })
		const roles: Arr.NonEmptyReadonlyArray<RoleSpec> =
			count === 1 ? [roleSpec(0)] : [roleSpec(0), roleSpec(1)]
		return {
			level,
			roles,
			program: {
				role: source.draw(int(0, count - 1)),
				context: source.draw(element(contextNames)),
				entry: source.draw(element(entries))
			},
			opener: source.draw(element(openers)),
			options: source.draw(element(optionForms)),
			base: {
				role: source.draw(int(0, count - 1)),
				program: source.draw(element(basePrograms))
			},
			full: fullGen(source),
			stray: { place: source.draw(element(places)), contexts: contextsGen(source) },
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
 * A role's entries: Tier and Account whole, Task at its place, and over Reports the stored derived relation whole. The
 * closed relation is no role's entry: every role reads its rows.
 */
const roleEntries = (spec: AccessSpec, r: RoleSpec): ReadonlyArray<readonly [string, string]> => [
	["Tier", "Tier"],
	["Account", "Account"],
	["Task", taskEntry[r.place][0]],
	...(spec.level === "Reports" ? Arr.map(derivedNames, (d) => [d, d] as const) : [])
]

/** The positions in a role's base's statements of the laws the role keeps, its statements, as role(...) built them. */
const keptPositions = (r: AnyRole): ReadonlyArray<number> =>
	Arr.filterMap(r.base.statements, (s, j) =>
		Arr.contains(r.statements, s) ? EffectResult.succeed(j) : EffectResult.failVoid
	)

/** The base's laws at the positions kept, as the union type the program states, never for none. */
const keptUnion = (level: AccessSpec["level"], kept: ReadonlyArray<number>): string =>
	Arr.isReadonlyArrayNonEmpty(kept)
		? Arr.join(
				Arr.map(kept, (j) => `(typeof ${level})["statements"][${j}]`),
				" | "
			)
		: "never"

/** The contexts a login's role declares: those its Task entry reads, and its drawn extra ones, in their order. */
const declaredOf = (r: RoleSpec): ReadonlyArray<ContextName> => {
	const reads = entryReads(r.place)
	return Arr.filter(contextNames, (c) => Arr.contains(reads, c) || Arr.contains(r.extra, c))
}

/** Contexts by name, as a JavaScript caller declares them. */
const contextsOf = (names: ReadonlyArray<ContextName>): ReadonlyArray<AnyContext> =>
	Arr.map(names, (c) => contextValues[c])

/** Contexts by name, as the program declares them. */
const contextsSource = (names: ReadonlyArray<ContextName>): string =>
	`contexts: [${Arr.join(names, ", ")}]`

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
		contexts: contextsOf(declaredOf(r))
	})
}

/** The stray role, built by role(...) as the program builds it, as the engine reads it: built or refused. */
const strayVerdictOf = (stray: StraySpec): boolean =>
	catchCompileError(() =>
		role(
			Work,
			"stray",
			{ Tier, Account, Task: taskEntry[stray.place][1] },
			{ contexts: contextsOf(stray.contexts) }
		)
	).ok

const got = (record: Readonly<Record<string, EntryValue>>, name: string): EntryValue => {
	const found = record[name]
	if (found === undefined) {
		throw new Error(`no value ${name}`)
	}
	return found
}

/** The contexts a role declares, by name, as its Description holds them and the layer reads them. */
const declaresOf = (value: AnyRole): ReadonlySet<string> => {
	const desc = roleDescOf(value)
	if (desc === undefined) {
		throw new Error("role(...) describes every role it builds")
	}
	return new Set(Arr.map(desc.contexts, (c) => c.name))
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
	/** Per role, whether it declares a context. */
	readonly reads: Arr.NonEmptyReadonlyArray<boolean>
	/** Per role, the positions in its base's statements of the laws role(...) keeps for it (keptPositions). */
	readonly kept: Arr.NonEmptyReadonlyArray<ReadonlyArray<number>>
	readonly program: boolean
	/** Whether Db.open's first argument is a role reached through its login. */
	readonly opener: boolean
	/** Whether Db.open's boundary reads the drawn options (db/served.ts openOptions). */
	readonly options: boolean
	/** Whether the engine compiles the program over the base for the role (OutsideRole for a partial role). */
	readonly base: boolean
	readonly full: FullVerdict
	/** Whether role(...) builds the stray role. */
	readonly stray: boolean
	/** Whether each schema-taking builder admits the base it is given. */
	readonly over: { readonly [B in SchemaTaker]: boolean }
}

/**
 * The engine's reading of a case's full role: refused by role(...), for a repeat in its write list or not, or admitted
 * with the names of its entries and its write list as its Description holds them, and whether the program over the
 * base matching the closed relation, the program over its level (levelPrograms) and the program over the base matching
 * the drawn context compile for it.
 */
type FullVerdict =
	| { readonly kind: "refused"; readonly repeat: boolean }
	| {
			readonly kind: "admitted"
			readonly entries: ReadonlyArray<string>
			readonly write: ReadonlyArray<string>
			readonly kept: ReadonlyArray<number>
			readonly base: boolean
			readonly level: boolean
			readonly matches: boolean
	  }

/** A full role's options as a JavaScript caller passes them, its write list made by the helpers the program calls. */
const fullOptions = (
	full: FullSpec,
	level: typeof Work | typeof Reports
): RoleOptionRecord<ReadonlyArray<string>> => {
	const contexts = contextsOf(full.contexts)
	switch (full.write.kind) {
		case "omitted":
			return { contexts }
		case "every":
			return { write: writableNamesOf(level), contexts }
		case "every and":
			return { write: [...writableNamesOf(level), full.write.stray], contexts }
		case "listed":
			return { write: full.write.names, contexts }
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
		write: writtenNames(desc),
		kept: keptPositions(built.value),
		base: compileTemplate(accountSeats, built.value, testCompile).ok,
		level: compileTemplate(levelValues[spec.level], built.value, testCompile).ok,
		matches: compileTemplate(baseMatching[spec.full.matches][1], built.value, testCompile).ok
	}
}

/** The builders that take a schema, as a JavaScript caller sees them, taking any base at all. */
interface SchemaTaking {
	role(base: unknown, name: string, relations: Readonly<Record<string, EntryValue>>): unknown
	login(base: unknown, name: string, roles: readonly [AnyRole], options: readonly []): unknown
	extend(
		base: unknown,
		name: string,
		relations: readonly [],
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
				return schemaTaking.extend([base], "Over", [], [], [])
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
	const reads = Arr.map(values, (v) => declaresOf(v).size > 0)
	const kept = Arr.map(values, keptPositions)
	const programRole = defined(values[spec.program.role], "the program's role")
	const program = Result.flatMap(
		catchCompileError(() => builtProgram(programRole, spec.program.context)),
		(q) => compileTemplate(q, programRole, testCompile)
	)
	const level = spec.level === "Reports" ? Reports : Work
	const built = login(level, "agreement", values, [])
	const first = spec.roles[0].name
	const opened: unknown =
		spec.opener === "served role"
			? served(compiledServedFile(built), "agreement").roles[first]
			: spec.opener === "login role"
				? built.roles[first]
				: spec.opener === "role value"
					? values[0]
					: level
	return {
		reads,
		kept,
		program: program.ok,
		opener: EffectResult.isSuccess(readServedRole(opened)),
		options: EffectResult.isSuccess(openOptions(optionValues[spec.options].value)),
		base: compileTemplate(
			baseValues[spec.base.program],
			defined(values[spec.base.role], "the base program's role"),
			testCompile
		).ok,
		full: fullVerdictOf(spec),
		stray: strayVerdictOf(spec.stray),
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

export interface AccessCase {
	readonly spec: AccessSpec
	readonly verdict: AccessVerdict
	readonly notes: ReadonlySet<AccessNote>
}

/** A login of drawn roles, the engine's verdict on each probe of it, and what it reaches. */
const casesOf =
	(specs: Gen<AccessSpec>): Gen<AccessCase> =>
	(source) => {
		const spec = specs(source)
		const verdict = verdictOf(spec)
		const notes = new Set<AccessNote>()
		for (const [r, reads] of Arr.zip(spec.roles, verdict.reads)) {
			notes.add(`a context read: ${r.place}`)
			notes.add(`open ${reads ? "refused" : "admitted"}`)
			if (Arr.some(declaredOf(r), (c) => !Arr.contains(entryReads(r.place), c))) {
				notes.add("declared beyond its relations")
			}
		}
		notes.add(`stray ${verdict.stray ? "admitted" : "refused"}`)
		for (const [r, kept] of Arr.zip(spec.roles, verdict.kept)) {
			if (Arr.isReadonlyArrayNonEmpty(kept)) {
				notes.add("law kept")
			}
			if (kept.length < builtRole(spec, r).base.statements.length) {
				notes.add("law dropped")
			}
		}
		notes.add(`verify ${Arr.some(verdict.reads, (x) => x) ? "required" : "optional"}`)
		notes.add(`${spec.program.entry} ${verdict.program ? "admitted" : "refused"}`)
		notes.add(`${spec.opener} ${verdict.opener ? "admitted" : "refused"}`)
		notes.add(`options ${spec.options} ${verdict.options ? "admitted" : "refused"}`)
		notes.add(`base ${spec.base.program} ${verdict.base ? "admitted" : "refused"}`)
		notes.add(`full ${verdict.full.kind}`)
		if (verdict.full.kind === "admitted") {
			notes.add(
				`full over ${spec.level} runs its program ${verdict.full.level ? "admitted" : "refused"}`
			)
			notes.add(`full matches a context ${verdict.full.matches ? "admitted" : "refused"}`)
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

/**
 * Logins of drawn roles, the engine's verdict on each probe of each and what it reaches; aimed at "verify optional" by
 * logins whose roles read no context, which roles drawn anywhere reach about once in 27 logins.
 */
export const accessCases: Aimed<AccessCase, AccessNote> = aimed(casesOf(specOf(anyRole)), [
	["verify optional", casesOf(specOf(contextFreeRole))]
])

/** The refusal a full role's write list takes when it names a relation twice. */
const repeatRefusal: Refused = "a write list names each role relation once"

const contextRefusal: Refused =
	"a program on a Db of a role matches only the contexts the role declares, whose facts its claims hold"

/** The refusal a role takes when a query entry of it matches a context it does not declare. */
const entryContextRefusal: Refused =
	"a role's query entry matches only the contexts the role declares"

/** The directive of a workload member over no level of the workload's schema, as workload(...) refuses it. */
const levelDirective =
	"// @ts-expect-error -- refused: a program over a level of the workload's schema, or a key of a relation of one"

/** A role's declaration, in the program. */
const roleSource = (spec: AccessSpec, r: RoleSpec, i: number): string =>
	`export const R${i}_${r.name} = role(${spec.level}, ${jsonText(r.name)}, { ${Arr.join(
		Arr.map(roleEntries(spec, r), ([name, value]) => `${name}: ${value}`),
		", "
	)} }, { ${contextsSource(declaredOf(r))} })`

/** The stray role's declaration, in the program: under its directive where role(...) refuses it. */
const strayLines = (stray: StraySpec, admitted: boolean, i: number): ReadonlyArray<string> => [
	...(admitted ? [] : [`// @ts-expect-error -- refusal: ${entryContextRefusal}`]),
	`export const D${i} = role(Work, "d${i}", { Tier: Tier, Account: Account, Task: ${taskEntry[stray.place][0]} }, { ${contextsSource(stray.contexts)} })`
]

/** The program over a role matching a context, in the program. */
const programSource = (roleId: string, context: ContextName, i: number): string =>
	`export const p${i} = query(${roleId}).rule((r) => { const { id, name } = v(${roleId}.relations.Account, "account"); return r.match(${roleId}.relations.Account, { id, name })${context === "Org" ? ".match(Org, { id })" : ".match(Session, { sub: name })"}.find({ id }) })`

/** A full role's options, in the program. */
const fullOptionsSource = (full: FullSpec, level: AccessSpec["level"]): string => {
	const contexts = contextsSource(full.contexts)
	switch (full.write.kind) {
		case "omitted":
			return `{ ${contexts} }`
		case "every":
			return `{ write: writableNamesOf(${level}), ${contexts} }`
		case "every and":
			return `{ write: [...writableNamesOf(${level}), ${jsonText(full.write.stray)}], ${contexts} }`
		case "listed":
			return `{ write: [${Arr.join(Arr.map(full.write.names, jsonText), ", ")}], ${contexts} }`
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
					? `// @ts-expect-error -- refusal: ${repeatRefusal}`
					: "// @ts-expect-error -- refused: role refuses the full role's write list",
				declaration
			]
		case "admitted":
			return [
				declaration,
				`export type fe${i} = Expect<Equals<keyof (typeof F${i})["relations"], ${unionOf(verdict.entries)}>>`,
				`export type fw${i} = Expect<Equals<WriteListOf<typeof F${i}>, ${unionOf(verdict.write)}>>`,
				`export type fk${i} = Expect<Equals<(typeof F${i})["statements"][number], ${keptUnion(spec.level, verdict.kept)}>>`,
				...(verdict.base ? [] : [levelDirective]),
				`export const fb${i} = workload(F${i}, { p: accountSeats })`,
				...(verdict.level ? [] : [levelDirective]),
				`export const fl${i} = workload(F${i}, { p: ${levelPrograms[spec.level]} })`,
				...(verdict.matches ? [] : [`// @ts-expect-error -- refusal: ${contextRefusal}`]),
				`export const fc${i} = workload(F${i}, { p: ${baseMatching[spec.full.matches][0]} })`
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
				return `schema.extend([${base}], "Over", [], [])`
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
			: [`// @ts-expect-error -- refused: ${builder} takes a schema, and a role is none`]),
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
			? [
					`// @ts-expect-error -- refused: role ${r.name} declares a context, so Db.open needs a token`
				]
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
	return [
		...Arr.map(spec.roles, (r) => roleSource(spec, r, i)),
		...Arr.map(
			Arr.zip(spec.roles, verdict.kept),
			([r, kept]) =>
				`export type k${i}_${r.name} = Expect<Equals<(typeof R${i}_${r.name})["statements"][number], ${keptUnion(spec.level, kept)}>>`
		),
		`export const L${i} = login(${spec.level}, "l${i}", [${Arr.join(roleIds, ", ")}])`,
		`export const S${i} = served<typeof L${i}>(file, "l${i}")`,
		...opens,
		...(Arr.some(verdict.reads, (x) => x)
			? [
					"// @ts-expect-error -- refused: a role of the login declares a context, so its layer needs verify"
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
		...(verdict.program ? [] : [`// @ts-expect-error -- refusal: ${contextRefusal}`]),
		`export const x${i} = workload(${programRole}, { p: ${served} })`,
		...fullBlock(spec, verdict.full, i),
		...strayLines(spec.stray, verdict.stray, i),
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
	"full matches a context admitted",
	"full matches a context refused",
	"stray admitted",
	"stray refused",
	"declared beyond its relations",
	...Arr.map(fullWriteKinds, (kind): AccessNote => `full write ${kind}`),
	"full write repeated",
	...Arr.flatMap(schemaTakers, (builder): ReadonlyArray<AccessNote> => [
		`${builder} over a schema admitted`,
		`${builder} over a role refused`
	]),
	"law kept",
	"law dropped",
	"two roles",
	"over an extension"
]

/** The access program's prelude (test/support/programs/access.ts), every name it reads. */
const prelude = await Effect.runPromise(preludeAt("test/support/programs/access.ts"))

/** The logins of a batch, its first login's config standing for every login's destination. */
const accessHeader: ReadonlyArray<string> = [
	"type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false",
	"type Expect<T extends true> = T",
	'declare const destination: Omit<DbConfigShape<typeof L0>, "login" | "password" | "verify" | "attachPool">',
	"declare const password: Redacted.Redacted",
	"declare const verify: Verify",
	"declare const file: unknown",
	""
]

/** The program over a batch's logins: one module, each login a block of its own. */
export const accessProgram = (
	cases: Arr.NonEmptyReadonlyArray<AccessCase>,
	entry: ProgramEntry
): Program => [
	preludeModule(
		"index.ts",
		"// Generated by test/support/agreement/access.ts: the access type/engine agreement.",
		preludeFrom(prelude, entry),
		[
			{ owner: batchOwned, lines: accessHeader },
			...Arr.map(cases, (c, at) => ({ owner: caseOwned(at), lines: blockOf(c, at) }))
		]
	)
]
