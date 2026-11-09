/**
 * Every world function judged at volume by PostgreSQL's serving judge (serving.ts): the filter functions, key and unique
 * probes, policy predicates and write prechecks a writable query entry installs (physical/ddl/roles.ts writePlan,
 * write/entry/precheck.ts) are existence tests bound to their arguments, each relation they read read by an index at the
 * values the arguments fix (write/entry/render.ts renderMembership), never scanned or deduplicated whole.
 *
 * A case is an installation of a documents base (worlds/model/bases/docs.ts): the roles the worlds model's generator
 * draws (worlds/generate/install.ts installGen), beside witness roles, each writing one query entry over a relation T
 * whose filter reads another source through a link, so every call the judgment asks for exists by construction. It
 * installs through its first migration, as `grizzle generate` drafts it with its roles' write filters planned
 * (installed.ts workloadOf), and the owner loads every relation at volume (docsLoads).
 *
 * Every world function of every writable query entry is called three ways, each a statement PostgreSQL plans and runs
 * twice under EXPLAIN (ANALYZE, BUFFERS) with sequential and bitmap scans disabled, the second run judged:
 *
 * - a function's body, the statement it returns (`SELECT <body>`), its arguments bound as the statement's parameters:
 *   at the values of T's middle row in physical order, at values no row holds, and, for a witness, at the linked
 *   source's own middle row's values, which the link's probe finds. Every scan of a stored relation in its plan is
 *   judged by the serving judge (serving.ts judgeScan): an Index Scan or Index Only Scan of an index the installation
 *   planned, with an index condition, one descent per loop and its buffers within the bound of its result's entries,
 *   whichever planned index PostgreSQL chose; and the claim, no row removed by a filter but the one entry a unique index
 *   finds per descent, which a key probe's membership and a unique key's recheck read, held by that index or, when
 *   PostgreSQL chose it by its cost over another, by another planned index of the relation alone, every other index of
 *   it dropped under a savepoint rolled back, as the serving judge holds a request's own index alone;
 * - a policy row: as the role, under row security, T's middle row read by its primary key, the role's policy judging
 *   it: a call of the filter function, or a membership reading no other relation. PostgreSQL counts the buffers a
 *   function reads in the node that calls it, so the statement may touch no more than the bound of its own scans and,
 *   for each entry its scan of T matched, the bound of the filter function's call at that row: its body's bound, and
 *   its body's planning, which PostgreSQL does at the call while it gives the function a custom plan, as it does a
 *   function's first calls in a session (callBound). An index PostgreSQL chose by its cost is resolved as a body's is,
 *   the owner taking on the role in its own transaction, since the role can drop no index;
 * - a read through the entry's view: as the role, T's middle row asked for by its key through the role's view of the
 *   entry, as a workload program over the role reads it, judged as the policy row: the view's filter is the entry's
 *   membership, so a key's equality pushed past it reads T by its key, and the filter's call is bounded as above. The
 *   view's columns are the entry's head, so the read names each field of T's key the head carries by its head field
 *   (ViewKeyField), and a field the rule fixes by a claim or a literal not at all, which the view's filter fixes;
 * - a precheck: as the role, the statement grizzle's write compiler builds to judge an insert of one fact into a
 *   witness's entry (write/entry/precheck.ts buildEntryCheck), bound as db.apply binds it, reading no more than its
 *   own scans and the bound of each world function's call at the fact's values (callBound): the filter function, then
 *   each key and unique probe. Its calls are the function's first in the role's session, so PostgreSQL plans each body
 *   at its call: a body that joins two relations reads their index ends for the join's selectivity, 12 buffers a call,
 *   36 of the 42 a precheck of three such calls touched, where their bodies read 6.
 *
 * Volume makes a scan plain: a world function whose lowering deduplicated each relation it read, which PostgreSQL could
 * not pull into its join, read every entry of the relation's index on every call, thousands of buffers over a bound of
 * a few.
 */
import { Array as Arr, Effect, Option, Record as Rec, Result, type Scope } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import {
	type Explained,
	explainStatementWith,
	type PlanNode,
	parsePlan,
	planNodes
} from "#bench/harness/explain.ts"
import { appendAll } from "#compiler/core/array.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import { worldNames } from "#compiler/physical/ddl/names.ts"
import type { PlannedIndex } from "#compiler/physical/indexes/engine.ts"
import { ownRole } from "#compiler/schema/own.ts"
import { roleDescOf } from "#compiler/schema/world.ts"
import type { CreateFunction, SqlStatement } from "#compiler/sql/ast.ts"
import {
	claimsSettingName,
	printExpr,
	printObjectName,
	quoteIdent,
	quoteString
} from "#compiler/sql/print.ts"
import { changeSetOver, parseChangeSet } from "#compiler/write/changeset/value.ts"
import { inForce } from "#compiler/write/family/order.ts"
import { relationUniques } from "#compiler/write/insert/unique.ts"
import { bindWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import {
	type IndexFacts,
	judgeScan,
	loadRows,
	plannedFacts,
	scanReads,
	touchedBy,
	unstatedDescents,
	type VolumeLoad,
	withoutOthers
} from "#test/pg/physical/serving.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { installedCodes, testArtifacts } from "#test/support/compile.ts"
import { type Installed, installMigrated } from "#test/support/install-migrate.ts"
import { workloadOf } from "#test/support/installed.ts"
import { roleNamesOf } from "#test/support/kernel/naming.ts"
import type { SqlError } from "#test/support/pg.ts"
import { spread } from "#test/support/plans.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { Substrate, worldSession } from "#test/support/substrate/substrate.ts"
import { textsOfParams } from "#test/support/wire.ts"
import { type Built, type BuiltRole, buildInstall } from "#test/support/worlds/execute/build.ts"
import { carrierOf, valueOfText } from "#test/support/worlds/execute/host.ts"
import type { RealizeRefused } from "#test/support/worlds/execute/refused.ts"
import { fieldsOfSource, sameDomain } from "#test/support/worlds/generate/domain.ts"
import type {
	BaseSpec,
	FieldDomain,
	FieldSpec,
	InstallSpec,
	Occurrence,
	RelationSpec,
	RoleSpec,
	Term
} from "#test/support/worlds/model/types.ts"

/** A field of a witness's linked source a field of T equals: T's `from`, the source's `to`. */
interface Pair {
	readonly from: string
	readonly to: string
}

/**
 * What else a witness's linked source binds beside its link: nothing, another field of T (a pair), a context's claim,
 * as the documents base's notes bind their document's organization to the tenant's, or a field of another source X (`joined`):
 * the linked source's field `to` equals X's `field`, and another field of T links into X (`link`), so X is bound by
 * the row and by the linked source at once, `T ⋈ Y{to: T.from} ⋈ X{to: T.from2, field: Y.to}`.
 */
export type Second =
	| { readonly kind: "none" }
	| { readonly kind: "field"; readonly pair: Pair }
	| {
			readonly kind: "claim"
			readonly to: string
			readonly context: string
			readonly field: string
	  }
	| {
			readonly kind: "joined"
			readonly to: string
			readonly source: string
			readonly link: Pair
			readonly field: string
	  }

/**
 * A witness: a query entry over T whose head is every field of T, filtered by a link into another source of the base, an
 * ordinary relation or a derived one, matched or negated, binding a second field of the source or none (Second).
 */
export interface LinkWitness {
	readonly target: string
	readonly source: string
	readonly link: Pair
	readonly second: Second
	readonly negated: boolean
}

/** The fields of T a witness's linked source binds: its link's, and its second pair's. */
const pairsOf = (w: LinkWitness): ReadonlyArray<Pair> =>
	w.second.kind === "field" ? [w.link, w.second.pair] : [w.link]

/** A case: a drawn installation of a documents base and the witnesses planted beside its roles. */
export interface WorldCase {
	readonly install: InstallSpec
	readonly witnesses: Arr.NonEmptyReadonlyArray<LinkWitness>
}

/** What a case reached, as its features name it. */
export type WorldServingFeature =
	| "a filter function's probe that finds its fact"
	| "a filter function's probe that finds none"
	| "a filter function's probe of a derived relation"
	| "a filter function's probe bound by its argument and a claim"
	| "a filter function's probe bound by its argument and a joined source"
	| "a key probe that reads its key's fact"
	| "a key probe that finds no fact at its key"
	| "a declared key's probe that reads its key's fact"
	| "a declared key's probe that finds no fact at its key"
	| "a unique probe that reads its object's fact"
	| "a unique probe that finds none"
	| "a policy row calling the filter function"
	| "a policy row of a membership reading no other relation"
	| "a read through a narrowed entry's view calling the filter function"
	| "a read through a view whose rule fixes a field of T's key"
	| "a precheck calling the filter function"
	| "a drawn entry's filter function"
	| "a world function's scan read through another planned index than one serving it alone"

/** The variable a witness's rule binds a field of T to. */
const own = (field: string): Term => ({ kind: "var", name: `v_${field}` })

/** An ordinary relation of the base, by its name. */
const relationOf = (base: BaseSpec, name: string): RelationSpec =>
	Option.getOrElse(
		Arr.findFirst(base.relations, (r) => r.name === name),
		() => assert.fail(`the documents base declares no relation ${name}`)
	)

/** Whether a source of the base is a derived relation, which a role's view of it reads as of its last refresh. */
const isDerived = (base: BaseSpec, source: string): boolean =>
	Arr.some(base.derived, (d) => d.name === source)

/** The links from T into `sources`: each field of T with each field of a source of its domain. */
export const linksOf = (
	base: BaseSpec,
	target: string,
	sources: ReadonlyArray<string>
): ReadonlyArray<{ readonly source: string; readonly link: Pair }> => {
	const others = Arr.filter(sources, (s) => s !== target)
	return Arr.flatMap(relationOf(base, target).fields, (f) =>
		Arr.flatMap(others, (source) =>
			Arr.flatMap(fieldsOfSource(base, source), (g) =>
				sameDomain(f.domain, g.domain) ? [{ source, link: { from: f.name, to: g.name } }] : []
			)
		)
	)
}

/**
 * The second bindings a witness over `link` may make, beside none: another field of the source bound to a field of T of
 * its domain, unless the source is an ordinary relation it matches whose occurrence would then bind every field of T,
 * which would supply the head as T's own does, so the entry would not be writable (schema/entry.ts); or bound to a
 * context's field of its domain.
 */
export const secondsOf = (
	base: BaseSpec,
	target: string,
	source: string,
	link: Pair,
	negated: boolean
): ReadonlyArray<Second> => {
	const fields = relationOf(base, target).fields
	const others = Arr.filter(fieldsOfSource(base, source), (g) => g.name !== link.to)
	const supplies = !negated && !isDerived(base, source) && fields.length <= 2
	const unlinked = Arr.filter(fields, (f) => f.name !== link.from)
	const pairs = supplies
		? []
		: Arr.flatMap(unlinked, (f) =>
				Arr.flatMap(others, (g): ReadonlyArray<Second> =>
					sameDomain(f.domain, g.domain)
						? [{ kind: "field", pair: { from: f.name, to: g.name } }]
						: []
				)
			)
	const claims = Arr.flatMap(others, (g) =>
		Arr.flatMap(base.contexts, (c) =>
			Arr.flatMap(c.fields, (cf): ReadonlyArray<Second> =>
				sameDomain(g.domain, cf.domain)
					? [{ kind: "claim", to: g.name, context: c.name, field: cf.name }]
					: []
			)
		)
	)
	return [...pairs, ...claims]
}

/**
 * The joined seconds a witness over `link` may make (Second): another field of the linked source equal to a field of
 * its domain of a source X, into which a field of T other than the link's links (linksOf). The linked source and X each
 * bind one field of T, so neither supplies the head and the entry stays writable (schema/entry.ts).
 */
export const joinedOf = (
	base: BaseSpec,
	target: string,
	sources: ReadonlyArray<string>,
	source: string,
	link: Pair
): ReadonlyArray<Second> => {
	const others = Arr.filter(linksOf(base, target, sources), (l) => l.link.from !== link.from)
	const unlinked = Arr.filter(fieldsOfSource(base, source), (g) => g.name !== link.to)
	return Arr.flatMap(unlinked, (g) =>
		Arr.flatMap(others, (l) =>
			Arr.flatMap(fieldsOfSource(base, l.source), (h): ReadonlyArray<Second> =>
				h.name !== l.link.to && sameDomain(g.domain, h.domain)
					? [{ kind: "joined", to: g.name, source: l.source, link: l.link, field: h.name }]
					: []
			)
		)
	)
}

/** The variable a joined second equates the linked source's field and the joined source's by. */
const joinedVar: Term = { kind: "var", name: "joined" }

/** The term a witness's linked source binds its second field to. */
const secondTerms = (second: Second): ReadonlyArray<readonly [string, Term]> => {
	switch (second.kind) {
		case "none":
			return []
		case "field":
			return [[second.pair.to, own(second.pair.from)]]
		case "claim":
			return [[second.to, { kind: "context", context: second.context, field: second.field }]]
		case "joined":
			return [[second.to, joinedVar]]
	}
}

/** A joined second's occurrence of its source: bound to a field of T by its link, to the linked source by `field`. */
const joinedOccurrences = (base: BaseSpec, second: Second): ReadonlyArray<Occurrence> =>
	second.kind === "joined"
		? [
				{
					source: {
						kind: isDerived(base, second.source) ? "derived" : "ordinary",
						name: second.source
					},
					fields: Rec.fromEntries([
						[second.link.to, own(second.link.from)] as const,
						[second.field, joinedVar] as const
					])
				}
			]
		: []

/** The name of the role a witness is planted as, and of its entry. */
const witnessRole = (at: number): string => `witness${at}`
const witnessEntry = "Witness"

/** A witness's role: its one entry, written. */
const witnessSpec = (base: BaseSpec, w: LinkWitness, at: number): RoleSpec => {
	const target = relationOf(base, w.target)
	const every = Rec.fromEntries(Arr.map(target.fields, (f) => [f.name, own(f.name)] as const))
	const linked: Occurrence = {
		source: { kind: isDerived(base, w.source) ? "derived" : "ordinary", name: w.source },
		fields: Rec.fromEntries([[w.link.to, own(w.link.from)] as const, ...secondTerms(w.second)])
	}
	const joined = joinedOccurrences(base, w.second)
	const row: Occurrence = { source: { kind: "ordinary", name: w.target }, fields: every }
	return {
		name: witnessRole(at),
		entries: {
			[witnessEntry]: {
				kind: "query",
				rules: [
					{
						matches: w.negated ? [row] : [row, linked, ...joined],
						negations: w.negated ? [[linked, ...joined]] : [],
						comparisons: [],
						head: every
					}
				]
			}
		},
		write: [witnessEntry],
		refresh: []
	}
}

/** A case's installation: its drawn roles, then a role per witness, in its first login. */
const plantedInstall = (c: WorldCase): InstallSpec => {
	const base = c.install.base
	const planted = Arr.map(c.witnesses, (w, at) => witnessSpec(base, w, at))
	const [first, ...logins] = c.install.logins
	return {
		base,
		roles: [...c.install.roles, ...planted],
		logins: [{ ...first, roles: [...first.roles, ...Arr.map(planted, (r) => r.name)] }, ...logins]
	}
}

/**
 * A field's value on row `g` of the load, by its domain, every value its domain admits: a uuid digests a number, a
 * subject (`^u_[a-z]{1,8}$`) spells one in five letters, an integer or a contract field is the number itself. The value
 * of a number no load reaches is one no row holds.
 */
const uuidOf = (g: string): string => `pg_catalog.md5('u:' || (${g})::text)::uuid`
const letter = (g: string, place: number): string =>
	`pg_catalog.chr(97 + ((${g}) / ${26 ** place} % 26)::int4)`
const subjectOf = (g: string): string =>
	`'u_' || ${Arr.join(
		Arr.map([0, 1, 2, 3, 4], (place) => letter(g, place)),
		" || "
	)}`

/** Every subject the load spells has five letters, so 26^5 - 1, past every number it reaches, names none. */
const unreached = 26 ** 5 - 1

/**
 * A field of no row as SQL, by its domain, as the load writes its rows (docsLoads): a uuid and a subject at a number no
 * load reaches, an integer at -1, a serial at 0, below the identity's first value, and a contract at its greatest
 * value, which Org's check keeps the load from.
 */
const absentSql = (domain: FieldDomain): string => {
	switch (domain.kind) {
		case "uuid":
			return uuidOf("-1")
		case "text":
			return subjectOf(String(unreached))
		case "integer":
			return "-1"
		case "serial":
			return "0"
		case "contract":
			return String(domain.max)
		case "boolean":
		case "handle":
		case "span":
			return assert.fail(`the documents base declares no ${domain.kind} field`)
	}
}

/** A claim's text, by its context field's domain: a value the load writes, number 0's. */
const claimSql = (domain: FieldDomain): string => {
	switch (domain.kind) {
		case "uuid":
			return uuidOf("0")
		case "text":
			return subjectOf("0")
		case "integer":
		case "serial":
		case "contract":
			return "3"
		case "boolean":
		case "handle":
		case "span":
			return assert.fail(`the documents base's contexts declare no ${domain.kind} field`)
	}
}

/**
 * The documents base's relations at `rows` facts each, over the series `g`, in an order its foreign key admits:
 *
 * - Org: an id per number, plans 0 to 5, which its check admits;
 * - Doc: an id per number, words the number itself, so (org, words) is a key whatever the org, an org and an owner
 *   each spread over rows / 50 values;
 * - Share: a document per number, at most one per document as the one-share variant's key admits, a user spread over
 *   rows / 50;
 * - Note: its identity numbers it, a document and an author each spread over rows / 50, every document one Doc holds;
 * - Visit: its two serials number it, so it writes no field of its own.
 *
 * Every value a spread field holds is one an identity field holds too, so a link from either finds its fact, and each
 * spread value is held by some 50 rows, so a probe that rechecks another field on them is told from one that binds it.
 */
const docsLoads = (base: BaseSpec, rows: number): ReadonlyArray<VolumeLoad> => {
	const many = Math.max(1, Math.floor(rows / 50))
	const loads: Readonly<Record<string, VolumeLoad["fields"]>> = {
		Org: [
			["id", uuidOf("g")],
			["plan", "(g % 6)::int4"]
		],
		Doc: [
			["id", uuidOf("g")],
			["org", uuidOf(spread(1, many))],
			["owner", subjectOf(spread(2, many))],
			["words", "g::int4"]
		],
		Share: [
			["doc", uuidOf("g")],
			["user", subjectOf(spread(3, many))]
		],
		Note: [
			["doc", uuidOf(spread(4, many))],
			["author", subjectOf(spread(5, many))]
		],
		Visit: []
	}
	return Arr.map(base.relations, (r) => ({
		relation: r.name,
		fields: defined(loads[r.name], `the documents load of ${r.name}`)
	}))
}

/** Rows of texts, as a query of `::text` columns answers. */
type Texts = ReadonlyArray<ReadonlyArray<string>>

const textsOf = (rows: unknown): Texts => trusted<Texts>(rows)

/** A world function as installed: what the report calls it, its body as one statement, the fields of T it takes. */
interface WorldFunction {
	readonly label: string
	readonly sql: string
	readonly params: ReadonlyArray<FieldSpec>
}

/**
 * A probe's kind: of the primary key; of another declared key, which UniqueObjects.keys holds beside the primary key
 * (laws/model/uniques.ts), so its probe is a key probe; or of a unique object no key subsumes, an object beyond the
 * keys such as a key over a selected side (write/insert/unique.ts OutsideProbe, beyondKeys).
 */
type ProbeKind = "key" | "declared key" | "unique"

/**
 * A field of T's key the entry's head carries: T's field, and the head field the entry's view names it by. A field of
 * T's key outside the head, which the rule fixes by a claim or a literal, is no column of the view: every row the view
 * holds already holds its value.
 */
interface ViewKeyField {
	readonly field: string
	readonly head: string
}

/**
 * A writable query entry of an installed role and the world functions it installs, with the fields of T's key its view
 * carries (ViewKeyField).
 */
interface WorldEntry {
	readonly label: string
	readonly role: BuiltRole
	readonly entry: string
	readonly target: RelationSpec
	readonly viewKey: ReadonlyArray<ViewKeyField>
	readonly filter: Option.Option<WorldFunction>
	readonly probes: ReadonlyArray<{ readonly kind: ProbeKind; readonly fn: WorldFunction }>
	readonly witness: Option.Option<LinkWitness>
}

/** Whether a statement creates an SQL function, as the installation creates a world function. */
const isSqlFunction = (
	st: SqlStatement
): st is Extract<CreateFunction, { readonly language: "sql" }> =>
	st.kind === "createFunction" && st.language === "sql"

/**
 * Every writable query entry of the installation's roles with its filter function, when its membership reads another
 * relation, and its key and unique probes, each found among the installation's statements by the name the naming door
 * gives it (physical/ddl/names.ts worldNames); every world function the manifest installs is one of them.
 */
const worldEntries = (
	spec: InstallSpec,
	witnesses: ReadonlyArray<LinkWitness>,
	built: Built,
	installed: Installed
): ReadonlyArray<WorldEntry> => {
	const installation = installed.installation
	const functions = Arr.filter(installation.statements, isSqlFunction)
	const found = new Set<string>()
	const functionOf = (
		label: string,
		target: RelationSpec,
		name: { readonly schema: string; readonly name: string }
	): WorldFunction => {
		const fn = Option.getOrElse(
			Arr.findFirst(functions, (f) => f.name.schema === name.schema && f.name.name === name.name),
			() => assert.fail(`the installation holds no ${label}`)
		)
		found.add(printObjectName(fn.name))
		const fieldOf = (column: string): FieldSpec =>
			Option.getOrElse(
				Arr.findFirst(target.fields, (f) => installed.names.column(target.name, f.name) === column),
				() => assert.fail(`${label} takes ${column}, no field of ${target.name}`)
			)
		return {
			label,
			sql: `SELECT ${printExpr(fn.body)}`,
			params: Arr.map(fn.params, (p) => fieldOf(p.name))
		}
	}
	const witnessOf = new Map(Arr.map(witnesses, (w, at) => [witnessRole(at), w] as const))
	const entries = Arr.flatMap(spec.roles, (r): ReadonlyArray<WorldEntry> => {
		const value = defined(built.roles[r.name], `the built role ${r.name}`)
		const owned = succeeded(ownRole(defined(roleDescOf(value), `role ${r.name}`)))
		const names = worldNames(owned, installation.names)
		return Arr.flatMap([...owned.writes.values()], (w): ReadonlyArray<WorldEntry> => {
			if (w.kind !== "rows") {
				return []
			}
			const target = relationOf(spec.base, w.writable.target)
			const label = `${r.name}.${w.name}`
			const filter = w.writable.filter
			const uniques = relationUniques(
				defined(installation.laws.relations.get(target.name), `the laws of ${target.name}`)
			)
			const heads = [...w.writable.head]
			return [
				{
					label,
					role: value,
					entry: w.name,
					target,
					viewKey: Arr.flatMap(target.key, (field): ReadonlyArray<ViewKeyField> =>
						Arr.flatMap(heads, ([head, h]) => (h.field === field ? [{ field, head }] : []))
					),
					filter:
						filter.kind === "query" && filter.readsOther
							? Option.some(
									functionOf(`${label}'s filter function`, target, names.filterFunction(w.name, []))
								)
							: Option.none(),
					probes: Arr.map(uniques.probes, (probe) => ({
						kind:
							probe.kind === "key" && probe.object !== uniques.arbiter
								? ("declared key" as const)
								: probe.kind,
						fn: functionOf(
							`${label}'s ${probe.kind} probe of ${probe.object.name}`,
							target,
							names.probe(w.name, probe, [])
						)
					})),
					witness: Option.fromUndefinedOr(witnessOf.get(r.name))
				}
			]
		})
	})
	const unnamed = Arr.flatMap(installation.manifest.objects, (o) =>
		o.kind === "worldFunction"
			? Arr.flatMap(o.ddl, (st) =>
					isSqlFunction(st) && !found.has(printObjectName(st.name))
						? [printObjectName(st.name)]
						: []
				)
			: []
	)
	assert.deepEqual(
		unnamed,
		[],
		"every world function the installation installs is a writable entry's"
	)
	return entries
}

/** What the judgment reads of an installation: its planned indexes and their facts, and its relations' names. */
interface Judging {
	readonly installed: Installed
	readonly planned: ReadonlyMap<string, PlannedIndex>
	readonly facts: ReadonlyMap<string, IndexFacts>
	readonly derived: ReadonlySet<string>
	/** The claims setting's text, and each claim's text by `<context>.<field>`. */
	readonly claims: string
	readonly claimed: ReadonlyMap<string, string>
}

/**
 * One scan of a stored relation a plan ran: its relation as EXPLAIN names it, its loops, and the entries its index
 * condition matched over them, the rows it returned and those its filter removed.
 */
interface ScanSeen {
	readonly relation: string
	readonly loops: number
	readonly entries: number
}

/** A scan's entries over every loop: PostgreSQL reports its rows and the rows its filter removed per loop. */
const entriesOfScan = (n: PlanNode): number =>
	(n.actualRows + n.rowsRemovedByFilter) * n.actualLoops

/**
 * A scan whose index PostgreSQL chose does not hold the claim (serving.ts Claim, `unstated`): the relation as EXPLAIN
 * names it, the index, and why. It is a problem unless another planned index of the relation, alone, serves the
 * statement's scans of it (resolveClaims).
 */
interface Unclaimed {
	readonly relation: string
	readonly through: PlannedIndex
	readonly why: string
}

/**
 * What one statement's plan read: the problems the serving rules find, its scans, the bound on their buffers, the scans
 * whose index PostgreSQL chose does not hold the claim, and the buffers PostgreSQL's planning of the statement touched
 * (EXPLAIN's Planning Buffers).
 */
interface Reading {
	readonly problems: ReadonlyArray<string>
	readonly scans: ReadonlyArray<ScanSeen>
	readonly bound: number
	readonly unclaimed: ReadonlyArray<Unclaimed>
	readonly planning: number
}

/**
 * The buffers a call of a world function may read at the values its body was judged at: its body's scans' bound, and its
 * body's planning. PostgreSQL plans an SQL function's body at the call's arguments while it gives the function a custom
 * plan, as it does a function's first calls in a session, and counts that planning's buffers in the node that calls it.
 */
const callBound = (body: Reading): number => body.bound + body.planning

/**
 * A plan judged (see the header): every scan of a stored relation held to the serving rules by serving.ts's judge
 * (judgeScan), but a scan of the statement's input (`inputs`, a precheck's carriers of the facts it judges), a temporary
 * table it reads whole through local buffers, which no bound counts. Each scan's index, whichever PostgreSQL chose, is
 * held to what it read; one that does not hold the claim too is Unclaimed. Each scan's buffers are held to its own bound
 * for a statement that calls no world function (`calls` none), or, for one that does, the statement's buffers to the
 * bound of its scans and the buffers its calls may read.
 */
const readingOf = (
	cx: Judging,
	label: string,
	explained: Explained,
	inputs: ReadonlySet<string>,
	calls: Option.Option<number>
): Reading => {
	const plan = explained.plan
	const bounded = Option.isNone(calls) ? "scan" : "statement"
	const problems: Array<string> = []
	const scans: Array<ScanSeen> = []
	const bounds: Array<number> = []
	const unclaimed: Array<Unclaimed> = []
	for (const n of planNodes(plan)) {
		if (Option.isNone(n.relation)) {
			continue
		}
		const relation = n.relation.value
		if (inputs.has(relation)) {
			continue
		}
		scans.push({ relation, loops: n.actualLoops, entries: entriesOfScan(n) })
		const read = judgeScan(
			n,
			cx.planned,
			cx.facts,
			true,
			() => ({ kind: "read" }),
			unstatedDescents,
			bounded
		)
		if (read.kind === "unserved") {
			problems.push(`${label}: ${relation}: ${read.why}`)
			continue
		}
		const index = read.through.index.name
		if (read.kind === "swept") {
			problems.push(`${label}: ${relation}: ${read.why}`)
		} else {
			const claimed = judgeScan(
				n,
				cx.planned,
				cx.facts,
				true,
				() => ({ kind: "unstated" }),
				unstatedDescents,
				bounded
			)
			if (claimed.kind === "unserved") {
				unclaimed.push({ relation, through: read.through, why: claimed.why })
			}
		}
		bounds.push(scanReads(n, defined(cx.facts.get(index), `the facts of ${index}`)).bound)
	}
	const bound = Arr.reduce(bounds, 0, (sum, b) => sum + b)
	if (Option.isSome(calls) && touchedBy(plan) > bound + calls.value) {
		problems.push(
			`${label}: ${touchedBy(plan)} buffers, over the ${bound} its scans may read and the ${calls.value} its world function calls may`
		)
	}
	return {
		problems,
		scans,
		bound,
		unclaimed,
		planning: explained.planningBuffers.sharedHit + explained.planningBuffers.sharedRead
	}
}

/** No input a statement reads whole: a body's and a policy row's. */
const noInputs: ReadonlySet<string> = new Set()

/** EXPLAIN's options beside ANALYZE and BUFFERS, as the serving judge captures a probe. */
const analyzed = { serialize: { kind: "off" }, wal: false } as const

/**
 * A statement's EXPLAIN (ANALYZE, BUFFERS), run twice, the second run's: the first plans what it calls and reads the
 * catalog rows its plan needs.
 */
const explained = (
	run: (
		sql: string,
		params: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>,
	label: string,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<Explained, SqlError> =>
	Effect.gen(function* () {
		const explain = explainStatementWith(sql, analyzed)
		yield* run(explain, params)
		const rows = yield* run(explain, params)
		const plan = parsePlan(rows[0]?.[0])
		return Result.isSuccess(plan)
			? plan.success
			: assert.fail(`${label}: no plan: ${plan.failure.message}`)
	})

/** The settings every judged statement runs under, as the serving judge plans its probes, and the case's claims. */
const judgedSettings = (cx: Judging): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => [
	["SET LOCAL enable_seqscan = off", []],
	["SET LOCAL enable_bitmapscan = off", []],
	[
		`SELECT pg_catalog.set_config(${quoteString(claimsSettingName)}::text, $1::text, true)`,
		[cx.claims]
	]
]

/** One row's values of a relation's fields, as text, by field. */
type Row = Readonly<Record<string, string>>

/** A relation's table or materialized view, quoted and qualified, and a field's column, quoted. */
const tableSql = (cx: Judging, relation: string): string =>
	printObjectName(cx.installed.names.relation(relation))
const columnSql = (cx: Judging, relation: string, field: string): string =>
	quoteIdent(cx.installed.names.column(relation, field))

/** The middle row in physical order of a source's rows, every field of it, as the serving judge samples a probe's. */
const middleRow = (cx: Judging, source: string, fields: ReadonlyArray<FieldSpec>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const table = tableSql(cx, source)
		const [row] = yield* Effect.map(
			admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(fields, (f) => `${columnSql(cx, source, f.name)}::text`),
					", "
				)} FROM ${table} ORDER BY ctid OFFSET (SELECT count(*) / 2 FROM ${table}) LIMIT 1`,
				[]
			),
			textsOf
		)
		const values = defined(row, `the middle row of ${source}`)
		return Rec.fromEntries(
			Arr.map(fields, (f, at) => [f.name, defined(values[at], `${source}.${f.name}`)] as const)
		)
	})

/** Each field's value of no row (absentSql). */
const absentRow = (fields: ReadonlyArray<FieldSpec>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const [row] = yield* Effect.map(
			admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(fields, (f) => `(${absentSql(f.domain)})::text`),
					", "
				)}`,
				[]
			),
			textsOf
		)
		const values = defined(row, "the absent row")
		return Rec.fromEntries(
			Arr.map(fields, (f, at) => [f.name, defined(values[at], `the absent ${f.name}`)] as const)
		)
	})

/** One call of a world function: which, how its arguments were chosen, and their values. */
interface Call {
	readonly entry: WorldEntry
	readonly fn: WorldFunction
	readonly kind: "filter" | ProbeKind
	readonly at: "row" | "linked" | "absent" | "fact"
	readonly row: Row
}

/** A call's arguments: the row's values of the fields the function takes, in its order. */
const argsOf = (fn: WorldFunction, row: Row): ReadonlyArray<string> =>
	Arr.map(fn.params, (f) => defined(row[f.name], `${fn.label}'s argument ${f.name}`))

/**
 * A statement the judgment runs: what the report calls it, its SQL and parameters, the statements it needs first (a
 * precheck's carriers and their ANALYZE), and whom it runs as: the owner, or a world's role.
 */
interface Statement {
	readonly label: string
	readonly sql: string
	readonly params: ReadonlyArray<string>
	readonly before: ReadonlyArray<readonly [string, ReadonlyArray<string>]>
	readonly as: { readonly kind: "owner" } | { readonly kind: "role"; readonly role: string }
}

/**
 * The problems of a statement's Unclaimed scans, in a transaction of the owner under the judged settings: none for a
 * relation another planned index of which serves the statement alone, every other index of the relation dropped under a
 * savepoint rolled back, the owner taking on the statement's role there to run it as the role does, and every scan of
 * the relation in its plan then holding the claim, its buffers bounded as the statement's (`bounded`). PostgreSQL chose
 * the index it read by its cost over that one, and serving.ts's judge holds it only to what it read, as it holds a
 * request's probe read through another index than its own; `excused` notes each such scan.
 */
const resolveClaims = (
	cx: Judging,
	statement: Statement,
	unclaimed: ReadonlyArray<Unclaimed>,
	bounded: "scan" | "statement",
	excused: () => void
) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const run = (sql: string, values: ReadonlyArray<string>) => admin.queryValues(sql, values)
		const judged = { schema: cx.installed.schema, installation: cx.installed.installation }
		const problems: Array<string> = []
		for (const u of unclaimed) {
			const others = Arr.filter(
				cx.installed.installation.indexes,
				(i) => i.relation === u.through.relation && i.index.name !== u.through.index.name
			)
			let served = false
			for (const host of others) {
				yield* admin.query("SAVEPOINT alone", [])
				for (const drop of yield* withoutOthers(judged, host)) {
					yield* admin.query(drop, [])
				}
				if (statement.as.kind === "role") {
					const role = quoteIdent(statement.as.role)
					yield* admin.query(`GRANT ${role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`, [])
					yield* admin.query(`SET LOCAL ROLE ${role}`, [])
				}
				for (const [sql, params] of statement.before) {
					yield* run(sql, params)
				}
				const alone = yield* explained(
					run,
					`${statement.label}, ${host.index.name} alone`,
					statement.sql,
					statement.params
				)
				yield* admin.query("ROLLBACK TO SAVEPOINT alone", [])
				const scans = Arr.filter(
					[...planNodes(alone.plan)],
					(n) => Option.isSome(n.relation) && n.relation.value === u.relation
				)
				served =
					Arr.isReadonlyArrayNonEmpty(scans) &&
					Arr.every(
						scans,
						(n) =>
							judgeScan(
								n,
								cx.planned,
								cx.facts,
								true,
								() => ({ kind: "unstated" }),
								unstatedDescents,
								bounded
							).kind === "served"
					)
				if (served) {
					break
				}
			}
			if (served) {
				excused()
			} else {
				problems.push(
					`${statement.label}: ${u.relation}: ${u.why}, and no other planned index of ${u.relation} serves the statement alone`
				)
			}
		}
		return problems
	})

/** `body` in a transaction of the owner rolled back, under the judged settings and the case's claims. */
const asOwner = <A, E, R>(cx: Judging, body: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		return yield* Effect.acquireUseRelease(
			admin.query("BEGIN", []),
			() =>
				Effect.gen(function* () {
					for (const [sql, params] of judgedSettings(cx)) {
						yield* admin.query(sql, params)
					}
					return yield* body
				}),
			() => Effect.ignore(admin.query("ROLLBACK", []))
		)
	})

/** The feature an excused scan notes (resolveClaims). */
const excusedFeature: WorldServingFeature =
	"a world function's scan read through another planned index than one serving it alone"

/**
 * A role's statement's reading with its Unclaimed scans resolved (resolveClaims) in a transaction of the owner: the
 * role's own session can drop no index.
 */
const resolvedAsRole = (
	cx: Judging,
	statement: Statement,
	reading: Reading,
	note: (feature: WorldServingFeature) => void
) =>
	Arr.isReadonlyArrayNonEmpty(reading.unclaimed)
		? Effect.map(
				asOwner(
					cx,
					resolveClaims(cx, statement, reading.unclaimed, "statement", () => note(excusedFeature))
				),
				(unresolved): Reading => ({ ...reading, problems: [...reading.problems, ...unresolved] })
			)
		: Effect.succeed(reading)

/**
 * The calls' bodies judged, in one transaction of the owner rolled back, an Unclaimed scan resolved by the relation's
 * other planned indexes alone (resolveClaims).
 */
const judgeCalls = (
	cx: Judging,
	calls: ReadonlyArray<Call>,
	note: (feature: WorldServingFeature) => void
) =>
	asOwner(
		cx,
		Effect.gen(function* () {
			const { admin } = yield* Substrate
			const readings: Array<readonly [Call, Reading]> = []
			for (const call of calls) {
				const statement: Statement = {
					label: `${call.fn.label} at ${call.at}`,
					sql: call.fn.sql,
					params: argsOf(call.fn, call.row),
					before: [],
					as: { kind: "owner" }
				}
				const plan = yield* explained(
					(sql, params) => admin.queryValues(sql, params),
					statement.label,
					statement.sql,
					statement.params
				)
				const reading = readingOf(cx, statement.label, plan, noInputs, Option.none())
				const unresolved = yield* resolveClaims(cx, statement, reading.unclaimed, "scan", () =>
					note(excusedFeature)
				)
				readings.push([call, { ...reading, problems: [...reading.problems, ...unresolved] }])
			}
			return readings
		})
	)

/**
 * Statements run as an entry's role, on a session of its login that has taken it on, in one SERIALIZABLE transaction
 * rolled back, under the judged settings and the case's claims.
 */
const asRole = <A>(
	cx: Judging,
	entry: WorldEntry,
	body: (
		run: (
			sql: string,
			params: ReadonlyArray<string>
		) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>
	) => Effect.Effect<A, SqlError>
): Effect.Effect<A, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const session = yield* s.session(worldSession(cx.installed.world(entry.role)))
		return yield* Effect.acquireUseRelease(
			session.begin,
			() =>
				Effect.gen(function* () {
					for (const [sql, params] of judgedSettings(cx)) {
						yield* session.query(sql, params)
					}
					return yield* body((sql, params) => session.values(sql, params))
				}),
			() => Effect.ignore(session.rollback)
		)
	})

/** The rows a plan's scans of T matched: the entries its policy judges. */
const entriesOf = (cx: Judging, target: string, plan: PlanNode): number =>
	Arr.reduce(
		Arr.filter(
			[...planNodes(plan)],
			(n) =>
				Option.isSome(n.relation) && n.relation.value === cx.installed.names.relation(target).name
		),
		0,
		(sum, n) => sum + entriesOfScan(n)
	)

/**
 * A policy row (see the header): T's middle row read by its primary key as the entry's role, the statement's buffers
 * bound by its scans' and, per entry it matched, the filter function's body at that row (`call`, none for a membership
 * reading no other relation).
 */
const policyRow = (
	cx: Judging,
	entry: WorldEntry,
	row: Row,
	call: Option.Option<Reading>,
	note: (feature: WorldServingFeature) => void
) =>
	Effect.gen(function* () {
		const target = entry.target
		const statement: Statement = {
			label: `${entry.label}'s policy row`,
			sql: `SELECT 1 FROM ${tableSql(cx, target.name)} WHERE ${Arr.join(
				Arr.map(target.key, (f, at) => `${columnSql(cx, target.name, f)} = $${at + 1}`),
				" AND "
			)}`,
			params: Arr.map(target.key, (f) => defined(row[f], `${target.name}.${f}`)),
			before: [],
			as: { kind: "role", role: cx.installed.world(entry.role).role }
		}
		const plan = yield* asRole(cx, entry, (run) =>
			explained(run, statement.label, statement.sql, statement.params)
		)
		const each = Option.match(call, { onNone: () => 0, onSome: callBound })
		const reading = readingOf(
			cx,
			statement.label,
			plan,
			noInputs,
			Option.some(entriesOf(cx, target.name, plan.plan) * each)
		)
		return yield* resolvedAsRole(cx, statement, reading, note)
	})

/**
 * A read through the entry's view (see the header): T's middle row asked for by its key through the view of the role's
 * world, as the role, as a workload program over the role reads the entry: the view's filter judges each entry its
 * scan of T matched, so the statement's buffers are bound by its scans' and, per entry, the filter function's body at
 * that row (`call`, none for a membership reading no other relation).
 */
const viewRow = (
	cx: Judging,
	entry: WorldEntry,
	row: Row,
	call: Option.Option<Reading>,
	note: (feature: WorldServingFeature) => void
) =>
	Effect.gen(function* () {
		const target = entry.target
		const names = roleNamesOf(cx.installed, entry.role)
		const conditions = Arr.map(
			entry.viewKey,
			(k, at) => `${names.column(entry.entry, k.head)} = $${at + 1}`
		)
		const statement: Statement = {
			label: `${entry.label}'s read through its view`,
			sql: `SELECT 1 FROM ${names.view(entry.entry)}${
				Arr.isReadonlyArrayNonEmpty(conditions) ? ` WHERE ${Arr.join(conditions, " AND ")}` : ""
			}`,
			params: Arr.map(entry.viewKey, (k) => defined(row[k.field], `${target.name}.${k.field}`)),
			before: [],
			as: { kind: "role", role: cx.installed.world(entry.role).role }
		}
		const plan = yield* asRole(cx, entry, (run) =>
			explained(run, statement.label, statement.sql, statement.params)
		)
		const each = Option.match(call, { onNone: () => 0, onSome: callBound })
		const reading = readingOf(
			cx,
			statement.label,
			plan,
			noInputs,
			Option.some(entriesOf(cx, target.name, plan.plan) * each)
		)
		return yield* resolvedAsRole(cx, statement, reading, note)
	})

/**
 * A precheck (see the header): the statement grizzle's write compiler builds to judge an insert of `fact` into the
 * entry, compiled for the role and the claims' contexts, bound as db.apply binds it, run as the role after the carriers
 * it reads, its buffers bound by its scans' and `calls`, the bounds of the world functions it calls at the fact.
 */
const precheck = (
	cx: Judging,
	base: BaseSpec,
	entry: WorldEntry,
	fact: Row,
	calls: number,
	note: (feature: WorldServingFeature) => void
): Effect.Effect<Reading, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const label = `${entry.label}'s precheck`
		const artifacts = succeeded(
			testArtifacts(entry.role, {
				installation: cx.installed.installation.names.installation,
				codes: installedCodes(cx.installed.installation.names.codes)
			})
		)
		const world = artifacts.world
		if (world.kind !== "role") {
			return assert.fail(`${label}: the role's artifacts hold no world`)
		}
		const values = yield* Effect.forEach(entry.target.fields, (f) =>
			Effect.map(
				valueOfText(
					f.domain,
					defined(fact[f.name], `the fact's ${f.name}`),
					f.name,
					cx.installed.installation.names.codes
				),
				(value) => [f.name, carrierOf(f.domain, value)] as const
			)
		)
		const changes = changeSetOver
			.empty(entry.role)
			.insert(defined(entry.role.relations[entry.entry], `${label}: the entry's relation`), [
				Rec.fromEntries(values)
			])
		const change = defined(parseChangeSet(changes), `${label}: a ChangeSet`)
		const program = succeeded(
			compileWrite(world.checked, change.desc, {
				names: artifacts.names,
				reads: artifacts.reads,
				claims: { kind: "facts", present: new Set(Arr.map(base.contexts, (c) => c.name)) },
				world: { kind: "role", names: world.names },
				laws: artifacts.laws,
				derived: artifacts.derived
			})
		)
		const members = yield* Effect.orDie(collectInputs(program.frontend, change.inputs))
		const bound = succeeded(
			bindWrite(program, { members, params: {}, transport: inForce(bindFrame) })
		)
		if (bound.kind !== "bound") {
			return assert.fail(`${label}: the fact is refused before any SQL`)
		}
		const statements = program.artifact.statements
		const at = Arr.findFirstIndex(statements, (st) => st.step.kind === "check")
		const check = defined(Option.getOrUndefined(at), `${label}: no check statement`)
		const statement = defined(statements[check], `${label}: the check statement`)
		const before = statements.slice(0, check)
		const inputs = new Set(
			Arr.flatMap(before, (st) => (st.step.kind === "carrier" ? [st.step.carrier] : []))
		)
		const judged: Statement = {
			label,
			sql: bound.form(statement).sql,
			params: textsOfParams(succeeded(bound.values(statement))),
			before: Arr.map(before, (st) =>
				st.step.kind === "carrier" || st.step.kind === "analyze"
					? ([bound.form(st).sql, textsOfParams(succeeded(bound.values(st)))] as const)
					: assert.fail(`${label}: a ${st.step.kind} statement before the check`)
			),
			as: { kind: "role", role: cx.installed.world(entry.role).role }
		}
		const plan = yield* asRole(cx, entry, (run) =>
			Effect.gen(function* () {
				for (const [sql, params] of judged.before) {
					yield* run(sql, params)
				}
				return yield* explained(run, label, judged.sql, judged.params)
			})
		)
		const reading = readingOf(cx, label, plan, inputs, Option.some(calls))
		return yield* resolvedAsRole(cx, judged, reading, note)
	})

/** The claims every judged statement runs under: a fact of each context of the base, each field a value the load
 * writes (claimSql), as the setting's text (adapter/db/claims.ts) and by claim. */
const claimsOf = (base: BaseSpec) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const fields = Arr.flatMap(base.contexts, (c) =>
			Arr.map(c.fields, (f) => ({ context: c, field: f }))
		)
		if (!Arr.isReadonlyArrayNonEmpty(fields)) {
			return { text: "{}", claimed: new Map<string, string>() }
		}
		const [row] = yield* Effect.map(
			admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(fields, (f) => `(${claimSql(f.field.domain)})::text`),
					", "
				)}`,
				[]
			),
			textsOf
		)
		const values = defined(row, "the claims' values")
		const claimed = Arr.map(fields, (f, at) => ({
			...f,
			value: defined(values[at], `the claim ${f.context.name}.${f.field.name}`)
		}))
		return {
			text: jsonText(
				Rec.fromEntries(
					Arr.map(base.contexts, (c) => [
						c.name,
						Rec.fromEntries(
							Arr.flatMap(claimed, (f) =>
								f.context.name === c.name ? [[f.field.name, f.value] as const] : []
							)
						)
					])
				)
			),
			claimed: new Map(
				Arr.map(claimed, (f) => [`${f.context.name}.${f.field.name}`, f.value] as const)
			)
		}
	})

/** A witness's row of T at its linked source's middle row: T's fields the link reads hold the source's values. */
const linkedOf = (w: LinkWitness, onto: Row, source: Row): Row => ({
	...onto,
	...Rec.fromEntries(
		Arr.map(pairsOf(w), (p) => [p.from, defined(source[p.to], `${w.source}.${p.to}`)] as const)
	)
})

/**
 * An entry's arguments: T's middle row, a row of no values, and for a witness the row whose linked fields its source's
 * middle row holds, and the fact a precheck inserts, one the entry holds that meets no fact outside the entry at a key
 * of T: a stored fact of a matched link's entry, the first T holds (none when T holds none), or every field at no value
 * for a negated link.
 */
interface Arguments {
	readonly row: Row
	readonly absent: Row
	readonly linked: Option.Option<Row>
	readonly fact: Option.Option<Row>
}

/** The first fact of T a matched witness's entry holds under the case's claims, none when T holds none. */
const memberRow = (cx: Judging, target: RelationSpec, w: LinkWitness) =>
	Effect.gen(function* () {
		const { admin } = yield* Substrate
		const source = (field: string): string => `s.${columnSql(cx, w.source, field)}`
		const targetColumn = (field: string): string => `t.${columnSql(cx, target.name, field)}`
		const claimed = w.second.kind === "claim" ? [w.second] : []
		const joined = w.second.kind === "joined" ? [w.second] : []
		const conditions = [
			...Arr.map(pairsOf(w), (p) => `${source(p.to)} = ${targetColumn(p.from)}`),
			...Arr.map(claimed, (c, at) => `${source(c.to)}::text = $${at + 1}::text`),
			...Arr.flatMap(joined, (j) => [
				`x.${columnSql(cx, j.source, j.link.to)} = ${targetColumn(j.link.from)}`,
				`x.${columnSql(cx, j.source, j.field)} = ${source(j.to)}`
			])
		]
		const from = Arr.join(
			[
				`${tableSql(cx, w.source)} AS s`,
				...Arr.map(joined, (j) => `${tableSql(cx, j.source)} AS x`)
			],
			", "
		)
		const [row] = yield* Effect.map(
			admin.queryValues(
				`SELECT ${Arr.join(
					Arr.map(target.fields, (f) => `${targetColumn(f.name)}::text`),
					", "
				)} FROM ${tableSql(cx, target.name)} AS t WHERE EXISTS (SELECT 1 FROM ${from} WHERE ${Arr.join(conditions, " AND ")}) LIMIT 1`,
				Arr.map(claimed, (c) =>
					defined(cx.claimed.get(`${c.context}.${c.field}`), `the claim ${c.context}.${c.field}`)
				)
			),
			textsOf
		)
		return Option.map(Option.fromUndefinedOr(row), (values) =>
			Rec.fromEntries(
				Arr.map(
					target.fields,
					(f, at) => [f.name, defined(values[at], `${target.name}.${f.name}`)] as const
				)
			)
		)
	})

/** An entry's arguments (Arguments). */
const argumentsOf = (cx: Judging, base: BaseSpec, entry: WorldEntry) =>
	Effect.gen(function* () {
		const row = yield* middleRow(cx, entry.target.name, entry.target.fields)
		const absent = yield* absentRow(entry.target.fields)
		const witnessed = yield* Effect.forEach(Option.toArray(entry.witness), (w) =>
			Effect.gen(function* () {
				const source = yield* middleRow(cx, w.source, fieldsOfSource(base, w.source))
				return {
					linked: linkedOf(w, row, source),
					fact: w.negated ? Option.some(absent) : yield* memberRow(cx, entry.target, w)
				}
			})
		)
		const [first] = witnessed
		return {
			row,
			absent,
			linked: Option.map(Option.fromUndefinedOr(first), (w) => w.linked),
			fact: Option.flatMap(Option.fromUndefinedOr(first), (w) => w.fact)
		} satisfies Arguments
	})

/** Every call of an entry's world functions at its arguments: each function at T's row and at none, the filter
 * function at the witness's linked row, and every function the precheck calls at its fact. */
const callsOf = (entry: WorldEntry, args: Arguments): ReadonlyArray<Call> => {
	const functions: ReadonlyArray<{ readonly kind: Call["kind"]; readonly fn: WorldFunction }> = [
		...Arr.map(Option.toArray(entry.filter), (fn) => ({ kind: "filter" as const, fn })),
		...entry.probes
	]
	return Arr.flatMap(functions, ({ kind, fn }) => [
		{ entry, fn, kind, at: "row" as const, row: args.row },
		{ entry, fn, kind, at: "absent" as const, row: args.absent },
		...(kind === "filter"
			? Arr.map(Option.toArray(args.linked), (row) => ({
					entry,
					fn,
					kind,
					at: "linked" as const,
					row
				}))
			: []),
		...Arr.map(Option.toArray(args.fact), (row) => ({ entry, fn, kind, at: "fact" as const, row }))
	])
}

/** What a call's reading reached (WorldServingFeature): its probes of another relation for a filter function, its scans of T
 * for a key, a declared key's or a unique probe. */
const callFeatures = (
	cx: Judging,
	call: Call,
	reading: Reading
): ReadonlyArray<WorldServingFeature> => {
	const table = cx.installed.names.relation(call.entry.target.name).name
	const ran = Arr.filter(reading.scans, (s) => s.loops > 0)
	const ofTarget = Arr.filter(ran, (s) => s.relation === table)
	const ofOthers = Arr.filter(ran, (s) => s.relation !== table)
	switch (call.kind) {
		case "filter":
			return Arr.flatMap(ofOthers, (s): ReadonlyArray<WorldServingFeature> => [
				s.entries > 0
					? "a filter function's probe that finds its fact"
					: "a filter function's probe that finds none",
				...(cx.derived.has(s.relation)
					? ["a filter function's probe of a derived relation" as const]
					: []),
				...(Option.exists(call.entry.witness, (w) => w.second.kind === "claim")
					? ["a filter function's probe bound by its argument and a claim" as const]
					: []),
				...(Option.exists(call.entry.witness, (w) => w.second.kind === "joined")
					? ["a filter function's probe bound by its argument and a joined source" as const]
					: []),
				...(Option.isNone(call.entry.witness) ? ["a drawn entry's filter function" as const] : [])
			])
		case "key":
			return Arr.map(ofTarget, (s): WorldServingFeature =>
				s.entries > 0
					? "a key probe that reads its key's fact"
					: "a key probe that finds no fact at its key"
			)
		case "declared key":
			return Arr.flatMap(ofTarget, (s): ReadonlyArray<WorldServingFeature> =>
				s.entries > 0
					? [
							"a key probe that reads its key's fact",
							"a declared key's probe that reads its key's fact"
						]
					: [
							"a key probe that finds no fact at its key",
							"a declared key's probe that finds no fact at its key"
						]
			)
		case "unique":
			return Arr.map(ofTarget, (s): WorldServingFeature =>
				s.entries > 0
					? "a unique probe that reads its object's fact"
					: "a unique probe that finds none"
			)
	}
}

/** The rows each relation holds in the drawn population's cases. */
export const populationRows = 20_000

/**
 * Judges a case at `rows` facts per relation (see the header): installs it, loads it, and judges every call of every
 * world function of every writable query entry, each entry's policy row, and each witness's precheck. Every problem,
 * none when PostgreSQL serves every one; `note` records what it reached.
 */
export const judgeCase = (
	c: WorldCase,
	rows: number,
	note: (feature: WorldServingFeature) => void
): Effect.Effect<
	ReadonlyArray<string>,
	RealizeRefused | CompileError | SqlError | TransactionRolledBack,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const spec = plantedInstall(c)
		const base = spec.base
		const built = yield* buildInstall(spec, base.name)
		const logins = Rec.values(built.logins)
		const installed = yield* installMigrated(built.base, {
			ambient: ordinarySession,
			label: "world_serving",
			logins,
			extensions: workloadOf({ schema: built.base, logins }).extensions
		})
		const judged = { schema: installed.schema, installation: installed.installation }
		yield* loadRows(judged, docsLoads(base, rows), rows)
		for (const d of base.derived) {
			const view = printObjectName(installed.names.relation(d.name))
			yield* s.admin.query(`REFRESH MATERIALIZED VIEW ${view}`, [])
			yield* s.admin.query(`VACUUM (ANALYZE) ${view}`, [])
		}
		const claims = yield* claimsOf(base)
		const cx: Judging = {
			installed,
			planned: new Map(Arr.map(installed.installation.indexes, (i) => [i.index.name, i] as const)),
			facts: yield* plannedFacts(judged),
			derived: new Set(Arr.map(base.derived, (d) => installed.names.relation(d.name).name)),
			claims: claims.text,
			claimed: claims.claimed
		}
		const entries = worldEntries(spec, c.witnesses, built, installed)
		const argued = yield* Effect.forEach(entries, (entry) =>
			Effect.map(argumentsOf(cx, base, entry), (args) => ({ entry, args }))
		)
		const readings = yield* judgeCalls(
			cx,
			Arr.flatMap(argued, ({ entry, args }) => callsOf(entry, args)),
			note
		)
		const problems: Array<string> = []
		for (const [call, reading] of readings) {
			appendAll(problems, reading.problems)
			for (const feature of callFeatures(cx, call, reading)) {
				note(feature)
			}
		}
		const readingAt = (entry: WorldEntry, at: Call["at"]) =>
			Arr.filter(readings, ([call]) => call.entry === entry && call.at === at)
		for (const { entry, args } of argued) {
			const filterAtRow = Arr.findFirst(readingAt(entry, "row"), ([call]) => call.kind === "filter")
			const policy = yield* policyRow(
				cx,
				entry,
				args.row,
				Option.map(filterAtRow, ([, reading]) => reading),
				note
			)
			appendAll(problems, policy.problems)
			note(
				Option.isSome(entry.filter)
					? "a policy row calling the filter function"
					: "a policy row of a membership reading no other relation"
			)
			const viewed = yield* viewRow(
				cx,
				entry,
				args.row,
				Option.map(filterAtRow, ([, reading]) => reading),
				note
			)
			appendAll(problems, viewed.problems)
			if (Option.isSome(entry.filter)) {
				note("a read through a narrowed entry's view calling the filter function")
			}
			if (entry.viewKey.length < entry.target.key.length) {
				note("a read through a view whose rule fixes a field of T's key")
			}
			for (const fact of Option.toArray(args.fact)) {
				const calls = Arr.reduce(
					readingAt(entry, "fact"),
					0,
					(sum, [, reading]) => sum + callBound(reading)
				)
				const checked = yield* precheck(cx, base, entry, fact, calls, note)
				appendAll(problems, checked.problems)
				if (Option.isSome(entry.filter)) {
					note("a precheck calling the filter function")
				}
			}
		}
		return problems
	})
