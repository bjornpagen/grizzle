/** What the properties of identity.test.ts read: its spaces, models and helpers. */

import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import { array, boolean, element, type Gen, int, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	type Identity,
	identity,
	type StandingName,
	type TemporaryCensus,
	type TemporaryKind
} from "#compiler/core/identity.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { hashedNames } from "#compiler/physical/install/comments.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Logic, Xml } from "#compiler/public/compute.ts"
import { Bits, bits, closedId, contract, natural, pg } from "#compiler/public/fields.ts"
import {
	type AnyLogin,
	type AnySchema,
	closed,
	contained,
	login,
	on,
	relation,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { type Owned, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { loginDescOf } from "#compiler/schema/world.ts"
import type { CommentTarget } from "#compiler/sql/ast.ts"
import { ledger, shopV1 } from "#test/pg/cli/fixture.ts"
import { refused, succeeded } from "#test/support/assert.ts"
import { allocatedLevels } from "#test/support/compile.ts"
import type { relation as descRelation } from "#test/support/fixtures/ir/desc.ts"
import { Id } from "#test/support/ids.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { owning } from "#test/support/policy.ts"
import { aliasPairs, refusedNameWords } from "#test/unit/core/identity.dictionary.ts"

/**
 * A fixture with its login: the shop; the ledger, whose residual law and derived relation install as extensions; and
 * the definitions, whose objects are named by definitions over the installation's own names (`definitionsOf`).
 */
type Fixture = "shop" | "ledger" | "definitions"

/** The fixtures, each declared under one name and installed under two. */
const declaredUnder = "names"

const handles = ["k0", "k1", "k2"] as const

const handleKey = Symbol("Handle")
const innerKey = Symbol("Inner")
const outerKey = Symbol("Outer")
const patternedKey = Symbol("Patterned")
/**
 * A schema each of whose objects named by its definition's digest has a definition that reads the installation's own
 * names: a contract over another contract, one over a closed id, its roster's domain, and one calling Xml.isPattern,
 * the installation's library function; T's CHECK that its (k, n) is a row of the closed relation Pairs, a row function
 * of T's columns calling Pairs' constant; and T's generated set field g, the singleton of Picks' f at k2, a key Picks
 * holds no row of, so g reads no column and is a row function of no parameter, returning the roster's bits domain.
 * Each identity digests its definition read in no schema (sql/type-schemas.ts digestedHooks).
 */
const definitionsOf = (name: string) => {
	const K = closed.ordered("K", handles)
	const Pairs = closed.relation(
		"Pairs",
		{ k: closedId(K), n: natural },
		["k"],
		[
			{ k: "k0", n: 0n },
			{ k: "k1", n: 1n }
		]
	)
	const Picks = closed.relation(
		"Picks",
		{ k: closedId(K), f: closedId(K) },
		["k"],
		[{ k: "k0", f: "k1" }]
	)
	const Inner = contract<typeof innerKey>()("Inner", pg.bigint, (v) => Logic.ge(v, 0n))
	const Outer = contract<typeof outerKey>()("Outer", Inner, (v) => Logic.le(v, 10n))
	const Handle = contract<typeof handleKey>()("Handle", closedId(K), undefined)
	const Patterned = contract<typeof patternedKey>()("Patterned", str.regex("^.*$", "su"), (v) =>
		Logic.eq(Xml.isPattern(v), true)
	)
	const T = relation.generated(
		"T",
		{ id: Id, k: closedId(K), n: natural, outer: Outer, handle: Handle, pattern: Patterned },
		["id"],
		() => ({ g: generatedField(bits(K), Bits.singleton(Picks.at("f", "k2")), []) })
	)
	const s = schema(name, [K, Pairs, Picks, T], [contained(on(T, "k", "n"), on(Pairs, "k", "n"))])
	return {
		schema: s,
		server: login(s, "desk", [role(s, "writer", { T }, { insert: ["T"] })])
	}
}

export const fixtureOf = (
	fixture: Fixture
): { readonly schema: AnySchema; readonly server: AnyLogin } => {
	switch (fixture) {
		case "shop":
			return shopV1(declaredUnder, "none")
		case "ledger":
			return ledger(declaredUnder)
		case "definitions":
			return definitionsOf(declaredUnder)
	}
}

/**
 * The schema names an installation is drawn under, none of which the declared name, a digest or another name holds as
 * a part: plain pairs, and pairs one of which is a prefix of the other.
 */
const schemaNames = ["gz_naming_one", "gz_naming_two", "gz_naming", "gz_naming_alt"] as const

export const installed = (owned: Owned, login: AnyLogin, at: Identity<"schema">): Installation => {
	const logins = [succeeded(ownLogin(defined(loginDescOf(login), "a login value")))]
	return succeeded(
		compileInstallation(
			owned,
			completeInstallOptions(
				owned,
				allocatedLevels(at, owned.levels),
				logins,
				[],
				firstCodebook(rostersOf(owned))
			)
		)
	)
}

/** The identifier a COMMENT's target names. */
export const targetName = (on: CommentTarget): string => {
	switch (on.kind) {
		case "SCHEMA":
		case "ROLE":
			return on.name
		case "COLUMN":
			return on.column
		case "CONSTRAINT":
		case "TRIGGER":
		case "POLICY":
		case "DOMAIN CONSTRAINT":
			return on.name
		case "TABLE":
		case "VIEW":
		case "DOMAIN":
		case "TYPE":
		case "INDEX":
		case "FUNCTION":
			return on.name.name
	}
}

export type InstallFeature =
	| "two plain names"
	| "one name a prefix of the other"
	| "a hashed object commented"
	| "a definition over the installation's names"

/** Each temporary kind's constructor: the names a migration sets an object aside and swaps an index under. */
export const temporaryOf: { readonly [K in TemporaryKind]: (of: string) => Identity<K> } = {
	aside: identity.aside,
	roleAside: identity.roleAside,
	swap: identity.swap
}

/** Admits each of `temporaries` in order, each under its own identifier. */
export const admitsAll = (
	census: TemporaryCensus,
	temporaries: ReadonlyArray<Identity<TemporaryKind>>
): void => {
	for (const t of temporaries) {
		assert.equal(succeeded(census.admit(t)), t.identifier, t.display)
	}
}

/** Refuses `temporary` as DigestCollision of its identifier, naming `display` before it and its own display after. */
export const collides = (
	census: TemporaryCensus,
	temporary: Identity<TemporaryKind>,
	display: string
): void => {
	const reason = refused(census.admit(temporary), "DigestCollision").reason
	if (reason._tag !== "DigestCollision") {
		return assert.fail(`a DigestCollision, not ${reason._tag}`)
	}
	assert.equal(reason.identifier, temporary.identifier)
	assert.deepEqual([reason.display, reason.otherDisplay], [display, temporary.display])
}

export type TemporaryFeature =
	| "admitted"
	| "minted again"
	| "a standing name met"
	| "two temporaries met"

/** Every pair of the schema names, each pair once, the lesser first. */
const pairs = Arr.flatMap(schemaNames, (a) =>
	Arr.flatMap(schemaNames, (b) => (a < b ? [[a, b] as const] : []))
)

/** A fixture and a pair of schema names it is installed under. */
export const installationGen: Gen<
	readonly [Fixture, readonly [(typeof schemaNames)[number], (typeof schemaNames)[number]]]
> = (source) =>
	[
		source.draw(element<Fixture>(["shop", "ledger", "definitions"])),
		source.draw(element(nonEmpty(pairs, "pairs of schema names")))
	] as const

/** What a declared-name case reaches: two names that convert alike, or one refused name, as relations or as fields. */
export type RuleFeature =
	| "relations alike"
	| "fields alike"
	| "a refused relation name"
	| "a refused field name"

/** A case of the rules: two names that convert alike, as relations or as fields, or one refused name, as either. */
type Drawn = { readonly kind: RuleFeature; readonly p: string; readonly q: string }

/**
 * Every alias pair and every refused name of the identifier dictionary, as relations and as fields: an alias pair or a
 * refused name, then its namespace.
 */
export const declaredNamesGen: Gen<Drawn> = oneOf([
	(source): Drawn => {
		const [p, q] = source.draw(word(aliasPairs))
		return { kind: source.draw(boolean) ? "fields alike" : "relations alike", p, q }
	},
	(source): Drawn => {
		const name = source.draw(word(refusedNameWords))
		return {
			kind: source.draw(boolean) ? "a refused field name" : "a refused relation name",
			p: name.declared,
			q: name.declared
		}
	}
])

/** A schema of the rules' relations. */
export const schemaOf = (relations: ReadonlyArray<ReturnType<typeof descRelation>>) => ({
	name: "Rules",
	relations,
	statements: [],
	bases: [] as const
})

/** A drawn census: up to five fields of one relation's sequences, one forged twin or none, and the twin's place. */
export const censusGen: Gen<{
	readonly fields: ReadonlyArray<string>
	readonly twin: boolean
	readonly at: number
}> = (source) => ({
	fields: source.draw(array(element(["a", "b", "c", "d", "e"]), { min: 1, max: 5 })),
	twin: source.draw(boolean),
	at: source.draw(int(0, 4))
})

/** A fixture's installed snapshot: the hashed names its installation leaves standing, and its identifiers. */
interface Snapshot {
	readonly standing: ReadonlyArray<StandingName>
	readonly names: Arr.NonEmptyReadonlyArray<string>
}

/** The snapshot a fixture's installation under one schema name leaves. */
const snapshotOf = (fixture: Fixture): Snapshot => {
	const { schema, server } = fixtureOf(fixture)
	const installation = installed(
		owning(schema),
		server,
		identity.schema(parsedSchemaName("gz_naming"))
	)
	const names = Arr.dedupe(Arr.map(installation.identities, (i): string => i.identifier))
	return {
		standing: hashedNames(installation.manifest.comments),
		names: nonEmpty(names, `${fixture}'s identifiers`)
	}
}

/** Each fixture's snapshot. */
export const snapshots: { readonly [F in Fixture]: Snapshot } = {
	shop: snapshotOf("shop"),
	ledger: snapshotOf("ledger"),
	definitions: snapshotOf("definitions")
}

/** What a temporary meets: nothing, a standing name of its identifier, or another temporary of it. */
type Meets = "nothing" | "a standing name" | "another temporary"

/** One temporary minted: its kind, the standing identifier or earlier temporary it is of, and whether it is minted again. */
interface Step {
	readonly kind: TemporaryKind
	readonly of: number
	readonly again: boolean
}

/** A migration's temporaries over a snapshot: each minted of a standing identifier or again, and what one meets. */
export const temporariesGen: Gen<{
	readonly snapshot: Fixture
	readonly steps: ReadonlyArray<Step>
	readonly meets: Meets
	readonly at: number
}> = (source) => ({
	snapshot: source.draw(element<Fixture>(["shop", "ledger", "definitions"])),
	steps: source.draw(
		array(
			(step): Step => ({
				kind: step.draw(element<TemporaryKind>(["aside", "roleAside", "swap"])),
				of: step.draw(int(0, 0xffff)),
				again: step.draw(boolean)
			}),
			{ min: 1, max: 6 }
		)
	),
	meets: source.draw(element<Meets>(["nothing", "a standing name", "another temporary"])),
	at: source.draw(int(0, 5))
})
