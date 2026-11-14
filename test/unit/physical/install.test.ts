/**
 * The fresh installation as a whole (physical/install/compile.ts), over generated schemas, extended types and span keys
 * included, with the one login whose full role writes every relation (`oracleLogin`):
 *
 * - **Install order:** the manifest is the install order: phases in order, every edge from an earlier object to a later
 *   one, and each object kind after the kinds PostgreSQL needs before it, as the model of object kinds states them (the
 *   namespace before what it holds, types before tables, tables before what refers to or is built on them, a role
 *   before its memberships, its schema, its policies and its privileges, a role's schema before its views); every
 *   object needed and justified, and every constraint or index justified by a law or a program, but for the CHECKs
 *   that enforce a span or vector column's own type. The model is total over src's PhysicalKind by the union itself, so
 *   a new kind is a compile error here until its place is stated.
 * - **Declaration order (metamorphic):** the SQL is byte for byte the same whatever order the relations and statements
 *   are declared in.
 * - **Identifiers:** the installed schema is the conversion of the schema's declared name, and a declared name the rule
 *   refuses (its own, or a conversion PostgreSQL reserves with pg_) is refused at its declaration; only an admitted
 *   identifier (plain lowercase, at most 63 bytes, outside pg_, drawn up to that bound) names the owner, the vector
 *   schema or the extension schema, which lies outside the installed one; the installation's roles never take a schema
 *   it names, and its relations lie in the installed schema.
 *
 * What the installed catalog holds is PostgreSQL's to judge, in the database suites.
 *
 * Oracles: the model of object kinds (kindModel); the declared order's installation, against the permuted one's; the
 * naming door's rule of a declared name and of an identifier, restated, each broken name built by the rule it breaks.
 *
 * Plants (~/.cache/grizzle-release/BR04/plants): install-indexes-before-structure.patch (the Indexes phase is ordered
 * before Structure, its tables'), install-64-byte-owner.patch (an owner of 64 bytes is admitted).
 *
 * Features: a foreign key, a constant, a domain, a law index and a type CHECK; relations and statements reordered; each
 * broken rule refused at each slot, an extension schema that is the schema, and each spelling installed.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
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
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Record, String as Str } from "effect"
import type { SchemaDesc as DecodedSchemaDesc, FieldDesc } from "#compiler/ir/desc.ts"
import type { DeployPhase, PhysicalKind } from "#compiler/ir/products.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { phaseOrder } from "#compiler/physical/obligations/graph.ts"
import { type OwnedLogin, ownLogin } from "#compiler/schema/own.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import * as work from "#test/support/fixtures/ir/work.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	defaultSchemaLimits,
	fullDataSwarm,
	resolveSchema,
	schemaDesc,
	schemaSketchGen
} from "#test/support/oracle/gen/schema.ts"
import { oracleLogin } from "#test/support/oracle/install/real.ts"
import { ownedInput, owning } from "#test/support/policy.ts"
import { owner } from "#test/unit/physical/fixtures.ts"

import { regex } from "arkregex"

const generatedSketchGen = schemaSketchGen({
	...defaultSchemaLimits,
	extended: true,
	keys: "spanKeys"
})

const generatedGen: Gen<SchemaDesc> = (source) =>
	schemaDesc(
		source.draw(
			resolveSchema(source.draw(generatedSketchGen), { mode: "drawn", edge: false }, fullDataSwarm)
		)
	)

/** The oracle's login over an owned schema: one full role writing every relation (oracleLogin). */
const loginOver = (desc: DecodedSchemaDesc): OwnedLogin => succeeded(ownLogin(oracleLogin(desc)))

const installed = (desc: SchemaDesc): Installation => {
	const owned = owning(desc)
	return succeeded(
		compileInstallation(owned, { ...installOptions(owned, owner), logins: [loginOver(owned.desc)] })
	)
}

/** The descriptor a field's values have: a contract's base, through every contract. */
const valueDesc = (desc: FieldDesc): FieldDesc =>
	desc.kind === "contract" ? valueDesc(desc.base) : desc

/** The CHECKs that enforce a column's own type declaration, as manifest idents named through the door: a span column's
 * shape and, with a fixed width, its width; a vector column's cosine domain. */
const typeChecks = (i: Installation): ReadonlySet<string> => {
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
const kindModel: { readonly [K in PhysicalKind]: KindModel } = {
	databaseDefault: { after: [], justified: "any reason" },
	schema: { after: [], justified: "any reason" },
	extension: { after: [], justified: "any reason" },
	constant: { after: ["schema"], justified: "any reason" },
	domain: { after: ["schema", "constant"], justified: "any reason" },
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
	advanceFunction: onTable("any reason"),
	unitFunction: onTable("any reason"),
	isolationFunction: inSchema,
	snapshotGuard: inSchema,
	isolationTrigger: { after: ["schema", "table", "isolationFunction"], justified: "any reason" },
	materializedView: onTable("any reason"),
	uniqueIndex: onTable("a law or a program"),
	index: onTable("a law or a program"),
	statistics: onTable("any reason"),
	validation: onTable("any reason"),
	lawFunction: onTable("a law or a program"),
	lawTrigger: { after: ["schema", "table", "lawFunction"], justified: "a law or a program" },
	role: { after: [], justified: "any reason" },
	decoder: { after: [], justified: "any reason" },
	publication: { after: ["schema", "table", "replicaIdentity"], justified: "any reason" },
	membership: { after: ["role"], justified: "any reason" },
	roleSchema: { after: ["role"], justified: "any reason" },
	view: { after: ["schema", "table", "roleSchema"], justified: "any reason" },
	worldFunction: onTable("any reason"),
	policy: { after: ["schema", "table", "role"], justified: "any reason" },
	rowSecurity: onTable("any reason"),
	privileges: {
		after: ["schema", "table", "role", "decoder", "liveSecret"],
		justified: "any reason"
	},
	ledger: inSchema
}

type OrderFeature = "a foreign key" | "a constant" | "a domain" | "a law index" | "a type CHECK"

/** An identifier of a schema or role the installation names and never creates: plain lowercase, at most 63 bytes,
 * outside pg_. */
const admitted = (name: string): boolean =>
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
type Spelling = "snake" | "camel" | "Pascal" | "a trailing underscore"
const spell = (words: ReadonlyArray<string>, spelling: Spelling): string => {
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
type DeclaredFault =
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
type IdentifierFault =
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
	map(matching(regex("^[a-oq-z][a-z0-9_]{63,79}$")), (name) => ({
		rule: "64 bytes" as const,
		name
	})),
	constant({ rule: "empty" as const, name: "" })
])
/** The names the installation takes besides its schema's, each an identifier it names and never creates. */
type Slot = "owner" | "vector schema" | "extension schema"
/** The installation's names: the schema's declared name in one spelling, the other names admitted, the extension schema
 * the installed schema or not, the owner stated or not, and at most one name broken by one rule (planted, since a drawn
 * name is rarely broken in one place only): the schema's declared name, or one of the others. */
/** The owner an installation states: none, or an admitted identifier. */
type OwnerName = { readonly kind: "none" } | { readonly kind: "named"; readonly name: string }

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
	readonly owner: OwnerName
	readonly vectorSchema: string
	readonly extensionSchema: string
	readonly extensionIsSchema: boolean
	readonly broken: BrokenName
}

const namesGen: Gen<Names> = (source) => ({
	schema: {
		words: source.draw(wordsGen),
		spelling: source.draw(element<Spelling>(["snake", "camel", "Pascal", "a trailing underscore"]))
	},
	owner: source.draw(
		oneOf<OwnerName>([
			constant({ kind: "none" }),
			map(admittedGen, (name): OwnerName => ({ kind: "named", name }))
		])
	),
	vectorSchema: source.draw(admittedGen),
	extensionSchema: source.draw(admittedGen),
	extensionIsSchema: source.draw(boolean),
	broken: source.draw(
		oneOf<BrokenName>([
			constant({ kind: "none" }),
			map(brokenDeclaredGen, (name): BrokenName => ({ kind: "schema", name })),
			(source): BrokenName => ({
				kind: "identifier",
				slot: source.draw(element<Slot>(["owner", "vector schema", "extension schema"])),
				name: source.draw(brokenIdentifierGen)
			})
		])
	)
})

describe("the fresh installation", () => {
	it.effect("is in install order, every object needed and justified, every edge kept", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the model of object kinds: what precedes each, and what justifies it"
					},
					suite: "unit/physical/install-order",
					draw: drawn(generatedGen),
					literal: Formatter.format,
					coverage: required<OrderFeature>(
						["a foreign key", "a constant", "a domain", "a law index", "a type CHECK"],
						{ cases: 100, sense: notesOnly }
					),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(desc, c) =>
					Effect.sync(() => {
						const i = installed(desc)
						const checks = typeChecks(i)
						const objects = i.manifest.objects
						const rank = (p: DeployPhase) => phaseOrder.indexOf(p)
						for (const [k, current] of objects.entries()) {
							if (k > 0) {
								assert.ok(rank(current.phase) >= rank(defined(objects[k - 1]).phase), current.ident)
							}
						}
						const position = new Map(Arr.map(objects, (o, k) => [o.ident, k]))
						for (const e of i.manifest.edges) {
							assert.ok(
								defined(position.get(e.from)) < defined(position.get(e.to)),
								`${e.from} before ${e.to}`
							)
						}
						const creates = (kind: PhysicalKind) => Arr.some(objects, (o) => o.kind === kind)
						const lastOf = (kind: PhysicalKind) => Arr.map(objects, (o) => o.kind).lastIndexOf(kind)
						assert.ok(creates("schema"), "the installation creates its namespace")
						for (const [k, o] of objects.entries()) {
							for (const before of kindModel[o.kind].after) {
								assert.ok(lastOf(before) < k, `every ${before} before ${o.ident}`)
							}
						}
						if (creates("foreignKey")) {
							c.note("a foreign key")
						}
						if (creates("constant")) {
							c.note("a constant")
						}
						if (creates("domain")) {
							c.note("a domain")
						}
						for (const o of objects) {
							assert.equal(o.state, "needed")
							assert.ok(o.reasons.length > 0, o.ident)
							if (o.kind === "index" && Arr.some(o.reasons, (r) => r.kind === "law")) {
								c.note("a law index")
							}
							const lawful = Arr.some(o.reasons, (r) => r.kind === "law" || r.kind === "access")
							const typeCheck =
								checks.has(o.ident) && Arr.every(o.reasons, (r) => r.kind === "enforcement")
							switch (kindModel[o.kind].justified) {
								case "any reason":
									break
								case "a law or a program":
									assert.ok(lawful, o.ident)
									break
								case "a law, a program or its column's type":
									if (typeCheck) {
										c.note("a type CHECK")
									}
									assert.ok(lawful || typeCheck, o.ident)
									break
							}
						}
					})
			)
		)
	)

	it.effect(
		"compiles byte-identical SQL whatever order the relations and statements are declared in",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "universal",
							name: "an installation is invariant under its declaration's order"
						},
						suite: "unit/physical/install-declaration-order",
						/** A generated schema and a permutation of its relations and one of its statements. */
						draw: drawn((source) => {
							const desc = source.draw(generatedGen)
							const all = (n: number) => ({ min: n, max: n })
							return {
								desc,
								relations: source.draw(shuffled(desc.relations, all(desc.relations.length))),
								statements: source.draw(shuffled(desc.statements, all(desc.statements.length)))
							}
						}),
						literal: Formatter.format,
						coverage: required<"relations reordered" | "statements reordered">(
							["relations reordered", "statements reordered"],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 60,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ desc, relations, statements }, c) =>
						Effect.sync(() => {
							if (Arr.some(relations, (r, k) => r !== desc.relations[k])) {
								c.note("relations reordered")
							}
							if (Arr.some(statements, (s, k) => s !== desc.statements[k])) {
								c.note("statements reordered")
							}
							const declared = installed(desc).statements
							assert.deepEqual(installed({ ...desc, relations, statements }).statements, declared)
						})
				)
			)
	)

	it.effect(
		"names its schema, owner, vector schema and extension schema by admitted identifiers only",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the naming door's rule of a declared name and of an admitted identifier"
						},
						suite: "unit/physical/install-identifiers",
						draw: drawn(namesGen),
						literal: Formatter.format,
						coverage: required<
							| `${DeclaredFault} refused`
							| `${IdentifierFault} refused`
							| "schema refused"
							| `${Slot} refused`
							| "an extension schema that is the schema"
							| `${Spelling} installed`
						>(
							[
								"a leading underscore refused",
								"a leading digit refused",
								"an outside character refused",
								"a conversion past 63 bytes refused",
								"the empty name refused",
								"a pg_ conversion refused",
								"uppercase refused",
								"leading digit refused",
								"pg_ prefix refused",
								"outside character refused",
								"64 bytes refused",
								"empty refused",
								"schema refused",
								"owner refused",
								"vector schema refused",
								"extension schema refused",
								"an extension schema that is the schema",
								"snake installed",
								"camel installed",
								"Pascal installed",
								"a trailing underscore installed"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(n, c) =>
						Effect.sync(() => {
							if (n.broken.kind === "schema") {
								c.note(`${n.broken.name.rule} refused`)
								c.note("schema refused")
								refused(
									ownedInput({ ...work.WorkDesc, name: n.broken.name.name }),
									"MalformedDescription"
								)
								return
							}
							const owned = owning({
								...work.WorkDesc,
								name: spell(n.schema.words, n.schema.spelling)
							})
							const schema = Arr.join(n.schema.words, "_")
							const at = (slot: Slot, name: string) =>
								n.broken.kind === "identifier" && n.broken.slot === slot ? n.broken.name.name : name
							const extensionSchema = at(
								"extension schema",
								n.extensionIsSchema ? schema : n.extensionSchema
							)
							const vectorSchema = at("vector schema", n.vectorSchema)
							/** The installer takes no owner as undefined, as `grizzle generate` drafts an installation. */
							const ownerRole =
								n.broken.kind === "identifier" && n.broken.slot === "owner"
									? n.broken.name.name
									: n.owner.kind === "named"
										? n.owner.name
										: undefined
							const login = loginOver(owned.desc)
							const result = compileInstallation(owned, {
								...installOptions(owned, ownerRole),
								vectorSchema,
								extensionSchema,
								logins: [login]
							})
							const named = [
								vectorSchema,
								extensionSchema,
								...(ownerRole === undefined ? [] : [ownerRole])
							]
							if (!Arr.every(named, admitted)) {
								if (n.broken.kind === "identifier") {
									c.note(`${n.broken.name.rule} refused`)
									c.note(`${n.broken.slot} refused`)
								}
								refused(result, "MalformedDescription")
								return
							}
							if (extensionSchema === schema) {
								c.note("an extension schema that is the schema")
								refused(result, "MalformedDescription")
								return
							}
							c.note(`${n.schema.spelling} installed`)
							const i = succeeded(result)
							assert.deepEqual(
								Arr.map(i.worlds, (w) => ({
									name: w.name,
									roles: Arr.map(w.roles, (r) => r.name)
								})),
								[{ name: login.name, roles: Arr.map(login.roles, (r) => r.name) }]
							)
							for (const w of i.worlds) {
								for (const r of w.roles) {
									assert.ok(![schema, ...named].includes(r.schema), r.schema)
								}
							}
							for (const r of work.WorkDesc.relations) {
								assert.equal(i.names.relation(r.name).schema, schema)
							}
						})
				)
			)
	)
})
