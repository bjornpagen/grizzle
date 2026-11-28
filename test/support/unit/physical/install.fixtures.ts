/** What the properties of install.test.ts read: its spaces, models and helpers. */

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
	weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { regex } from "arkregex"
import { Array as Arr, Record, String as Str } from "effect"
import type { SchemaDesc as DecodedSchemaDesc, FieldDesc } from "#compiler/ir/desc.ts"
import type { PhysicalKind } from "#compiler/ir/products.ts"
import { type Installation, installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { type OwnedLogin, ownLogin } from "#compiler/schema/own.ts"
import { succeeded } from "#test/support/assert.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import {
	defaultSchemaLimits,
	fullDataSwarm,
	resolveSchema,
	schemaDesc,
	schemaSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { oracleLogin } from "#test/support/oracle/install/real.ts"
import { owning } from "#test/support/policy.ts"

const generatedSketchGen = schemaSketchGen({
	...defaultSchemaLimits,
	extended: true,
	keys: "spanKeys"
})

export const generatedGen: Gen<SchemaDesc> = (source) =>
	schemaDesc(
		source.draw(
			resolveSchema(source.draw(generatedSketchGen), { mode: "drawn", edge: false }, fullDataSwarm)
		)
	)

/** The oracle's login over an owned schema: one full role writing every relation (oracleLogin). */
export const loginOver = (desc: DecodedSchemaDesc): OwnedLogin =>
	succeeded(ownLogin(oracleLogin(desc)))

export const installed = (desc: SchemaDesc): Installation => {
	const owned = owning(desc)
	return succeeded(
		compileInstallation(owned, { ...installOptions(owned), logins: [loginOver(owned.desc)] })
	)
}

/** The descriptor a field's values have: a contract's base, through every contract. */
const valueDesc = (desc: FieldDesc): FieldDesc =>
	desc.kind === "domain" ? valueDesc(desc.base) : desc

/** The CHECKs that enforce a column's own type declaration, as manifest idents named through the door: a span column's
 * shape and, with a fixed width, its width; a vector column's cosine domain. */
export const typeChecks = (i: Installation): ReadonlySet<string> => {
	const N = installationNamesOf(i)
	const checks = new Set<string>()
	for (const r of Record.values(i.owned.relations)) {
		if (r.desc.kind !== "relation") {
			continue
		}
		const ident = (check: string) => `constraint:${N.schema}.${N.tableIdent(r.desc)}.${check}`
		for (const [field, desc] of Record.toEntries(r.desc.fields)) {
			const value = valueDesc(desc.type)
			if (value.kind === "span") {
				checks.add(ident(N.spanCheck(r.desc, field, { kind: "shape" })))
				if (value.width !== undefined) {
					checks.add(ident(N.spanCheck(r.desc, field, { kind: "width" })))
				}
			}
			if (value.kind === "vector") {
				checks.add(ident(N.normCheck(r.desc, field)))
			}
		}
	}
	return checks
}

/** What the fresh installation requires of one object kind:
 * - after: the kinds every object of which precedes any object of this one, what PostgreSQL needs to exist first; none
 *   for what lives outside the installed schema (the database's defaults, an extension in its own schema, a role);
 * - justified: the reasons an object of the kind needs: any one, a law or a program (an object a law or a program asks
 *   for), or, for a CHECK, a law, a program or its column's own type (typeChecks). */
interface KindModel {
	readonly after: ReadonlyArray<PhysicalKind>
	readonly justified: "any reason" | "a law or a program" | "a law, a program or its column's type"
}

const inSchema: KindModel = { after: ["schema"], justified: "any reason" }

const onTable = (justified: KindModel["justified"]): KindModel => ({
	after: ["schema", "table"],
	justified
})

/** Every object kind's model, keyed by the union itself. */
export const kindModel: { readonly [K in PhysicalKind]: KindModel } = {
	schema: { after: [], justified: "any reason" },
	extension: { after: [], justified: "any reason" },
	constant: { after: ["schema"], justified: "any reason" },
	domain: { after: ["schema", "constant"], justified: "any reason" },
	functionOwner: { after: ["schema"], justified: "any reason" },
	rowType: inSchema,
	declaredFunction: { after: ["schema", "functionOwner"], justified: "any reason" },
	table: { after: ["schema", "constant", "domain"], justified: "any reason" },
	liveSecret: inSchema,
	replicaIdentity: onTable("any reason"),
	lawColumn: onTable("a law or a program"),
	primaryKey: onTable("a law or a program"),
	unique: onTable("a law or a program"),
	check: onTable("a law, a program or its column's type"),
	foreignKey: {
		after: ["schema", "table", "primaryKey", "unique"],
		justified: "a law or a program"
	},
	refusalFunction: inSchema,
	borrowFunction: inSchema,
	head: onTable("any reason"),
	headStamp: { after: ["schema", "table", "head"], justified: "any reason" },
	isolationFunction: inSchema,
	snapshotGuard: inSchema,
	isolationTrigger: { after: ["schema", "table", "isolationFunction"], justified: "any reason" },
	storedTable: onTable("any reason"),
	uniqueIndex: onTable("a law or a program"),
	index: onTable("a law or a program"),
	validation: onTable("any reason"),
	ruleJudge: inSchema,
	lawFunction: onTable("a law or a program"),
	lawTrigger: { after: ["schema", "table", "lawFunction"], justified: "a law or a program" },
	immutableGuard: onTable("any reason"),
	immutableTrigger: { after: ["schema", "table", "immutableGuard"], justified: "any reason" },
	founding: onTable("a law or a program"),
	role: { after: [], justified: "any reason" },
	decoder: { after: [], justified: "any reason" },
	publication: { after: ["schema", "table", "replicaIdentity"], justified: "any reason" },
	membership: { after: ["role"], justified: "any reason" },
	viewSchema: { after: [], justified: "any reason" },
	view: { after: ["schema", "table", "viewSchema"], justified: "any reason" },
	worldFunction: onTable("any reason"),
	policy: { after: ["schema", "table", "role"], justified: "any reason" },
	rowSecurity: onTable("any reason"),
	privileges: {
		after: ["schema", "table", "role", "decoder", "liveSecret"],
		justified: "any reason"
	},
	ledger: inSchema
}

export type OrderFeature =
	| "a foreign key"
	| "a constant"
	| "a domain"
	| "a law index"
	| "a type CHECK"

/** An identifier of a schema or role the installation names and never creates: plain lowercase, at most 63 bytes,
 * outside pg_. */
export const admitted = (name: string): boolean =>
	regex("^[a-z_][a-z0-9_]*$").test(name) &&
	Buffer.byteLength(name) <= 63 &&
	!Str.startsWith("pg_")(name)

/** A schema name's words, and the spellings of them that are one declared name, whose conversion is the words joined by
 * single underscores: the rule compares declared names by their segments, and an underscore with no segment after it
 * adds none. */
const wordsGen: Gen<ReadonlyArray<string>> = (source) => [
	source.draw(matching(regex("^(?:p[a-fh-z][a-z]{0,4}|pg[a-z]{1,4}|[a-oq-z][a-z]{1,5})$"))),
	...source.draw(array(matching(regex("^[a-z]{2,6}$")), { min: 0, max: 2 }))
]

/** A character outside the plain set a declared name or an identifier holds: no letter, digit or underscore of ASCII. */
const outsideGen: Gen<string> = oneOf([
	codePoint(0x20, 0x2f),
	codePoint(0x3a, 0x40),
	codePoint(0x5b, 0x5e),
	constant("`"),
	codePoint(0x7b, 0x7e),
	codePoint(0xa0, 0x24f)
])

export type Spelling = "snake" | "camel" | "Pascal" | "a trailing underscore"

export const spell = (words: ReadonlyArray<string>, spelling: Spelling): string => {
	switch (spelling) {
		case "snake":
			return Arr.join(words, "_")
		case "camel":
			return Arr.join(
				Arr.map(words, (w, i) => (i === 0 ? w : Str.capitalize(w))),
				""
			)
		case "Pascal":
			return Arr.join(Arr.map(words, Str.capitalize), "")
		case "a trailing underscore":
			return `${Arr.join(words, "_")}_`
	}
}

/** A schema's declared name broken by one rule of the naming door: a leading underscore or digit, a character outside
 * the plain set, a conversion past 63 bytes, the empty name, a conversion PostgreSQL reserves with pg_. */
export type DeclaredFault =
	| "a leading underscore"
	| "a leading digit"
	| "an outside character"
	| "a conversion past 63 bytes"
	| "the empty name"
	| "a pg_ conversion"

const brokenDeclaredGen: Gen<{ readonly rule: DeclaredFault; readonly name: string }> = oneOf<{
	readonly rule: DeclaredFault
	readonly name: string
}>([
	map(wordsGen, (ws) => ({
		rule: "a leading underscore" as const,
		name: `_${spell(ws, "snake")}`
	})),
	map(
		(source) => [source.draw(int(0, 9)), source.draw(wordsGen)] as const,
		([digit, ws]) => ({
			rule: "a leading digit" as const,
			name: `${digit}${spell(ws, "snake")}`
		})
	),
	map(
		(source) => [source.draw(wordsGen), source.draw(outsideGen)] as const,
		([ws, c]) => ({
			rule: "an outside character" as const,
			name: `${spell(ws, "snake")}${c}x`
		})
	),
	map(matching(regex("^[a-z][a-z0-9]{63,79}$")), (name) => ({
		rule: "a conversion past 63 bytes" as const,
		name
	})),
	constant({ rule: "the empty name" as const, name: "" }),
	map(wordsGen, (ws) => ({ rule: "a pg_ conversion" as const, name: `Pg${spell(ws, "Pascal")}` }))
])

/** An identifier broken by one rule: uppercase, a leading digit, the pg_ prefix, a character outside the plain set, 64
 * bytes, empty. */
export type IdentifierFault =
	| "uppercase"
	| "leading digit"
	| "pg_ prefix"
	| "outside character"
	| "64 bytes"
	| "empty"

/** An admitted identifier, built outside pg_: short, or exactly the 63 bytes a name holds. */
const admittedGen: Gen<string> = weighted([
	[
		4,
		matching(
			regex(
				"^(?:[a-oq-z_][a-z0-9_]{0,12}|p(?:[a-fh-z0-9_][a-z0-9_]{0,11})?|pg(?:[a-z0-9][a-z0-9_]{0,10})?)$"
			)
		)
	],
	[1, matching(regex("^[a-oq-z_][a-z0-9_]{62}$"))]
])

const brokenIdentifierGen: Gen<{ readonly rule: IdentifierFault; readonly name: string }> = oneOf<{
	readonly rule: IdentifierFault
	readonly name: string
}>([
	map(matching(regex("^[a-z]{0,4}[A-Z][a-z]{0,4}$")), (name) => ({
		rule: "uppercase" as const,
		name
	})),
	map(matching(regex("^[0-9][a-z]{0,6}$")), (name) => ({ rule: "leading digit" as const, name })),
	map(matching(regex("^pg_[a-z]{0,6}$")), (name) => ({ rule: "pg_ prefix" as const, name })),
	map(
		(source) => [source.draw(matching(regex("^[a-z]{1,4}$"))), source.draw(outsideGen)] as const,
		([stem, c]) => ({ rule: "outside character" as const, name: `${stem}${c}x` })
	),
	map(
		weighted([
			[3, matching(regex("^[a-oq-z][a-z0-9_]{63}$"))],
			[1, matching(regex("^[a-oq-z][a-z0-9_]{64,79}$"))]
		]),
		(name) => ({ rule: "64 bytes" as const, name })
	),
	constant({ rule: "empty" as const, name: "" })
])

/** The names the installation takes besides its schema's, each an identifier it names and never creates. */
export type Slot = "vector schema" | "extension schema"

/** The installation's names: the schema's declared name in one spelling, the other names admitted, the extension schema
 * the installed schema or not, and at most one name broken by one rule (planted, since a drawn name is rarely broken in
 * one place only): the schema's declared name, or one of the others. */

/** The one name a case breaks, if any: the schema's declared name, or one of the identifiers it names. */
type BrokenName =
	| { readonly kind: "none" }
	| {
			readonly kind: "schema"
			readonly name: { readonly rule: DeclaredFault; readonly name: string }
	  }
	| {
			readonly kind: "identifier"
			readonly slot: Slot
			readonly name: { readonly rule: IdentifierFault; readonly name: string }
	  }

interface Names {
	readonly schema: { readonly words: ReadonlyArray<string>; readonly spelling: Spelling }
	readonly vectorSchema: string
	readonly extensionSchema: string
	readonly extensionIsSchema: boolean
	readonly broken: BrokenName
}

export const namesGen: Gen<Names> = (source) => ({
	schema: {
		words: source.draw(wordsGen),
		spelling: source.draw(element<Spelling>(["snake", "camel", "Pascal", "a trailing underscore"]))
	},
	vectorSchema: source.draw(admittedGen),
	extensionSchema: source.draw(admittedGen),
	extensionIsSchema: source.draw(boolean),
	broken: source.draw(
		oneOf<BrokenName>([
			constant({ kind: "none" }),
			map(brokenDeclaredGen, (name): BrokenName => ({ kind: "schema", name })),
			(source): BrokenName => ({
				kind: "identifier",
				slot: source.draw(element<Slot>(["vector schema", "extension schema"])),
				name: source.draw(brokenIdentifierGen)
			})
		])
	)
})
