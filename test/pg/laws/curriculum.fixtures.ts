import { defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, boolean, constant, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import type { Case, NeedFailed, Resources } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import {
	Array as Arr,
	Data,
	Effect,
	Formatter,
	Layer,
	Option,
	Order,
	type Scope,
	String as Str
} from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import type { CallError } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Num, Text, Type } from "#compiler/public/compute.ts"
import { int8 } from "#compiler/public/fields.ts"
import { param, query, type Rule, v } from "#compiler/public/query.ts"
import {
	contained,
	derived,
	key,
	mutable,
	on,
	relation,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { writeAnswerOf, type WriteAnswer } from "#test/support/calls.ts"
import { type Generated, generatedTemplate, type Installed } from "#test/support/install-migrate.ts"
import { migrated } from "#test/support/installed.ts"
import { namesOf, parsedName, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { SqlError } from "#test/support/pg.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { attempt, momentText, refusalText } from "#test/support/substrate.ts"
import type { TransactionRolledBack } from "#test/support/substrate/errors.ts"
import { clearRows, installationGroup } from "#test/support/substrate/replace.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import type { Substrate, SubstrateCase, TemplateNeed } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * The curriculum level of a downstream application (pantry's QtiCurriculum, live in production QTI since its M1 and M2
 * migrations), as a schema of its own over a content level: the law shapes production relies on and leaves to grizzle to
 * enforce, every one of them a generated case here.
 *
 * - **Content** (the base): Package, by name, and Node, a package's manifest as a tree of nodes keyed by their pre-order
 *   start, each with its end (one past its last descendant), its parent's start, its kind and its characters.
 * - **Registry** (a level over Content): Course and Assessment, the homes by slug; PackageCourse and PackageAssessment,
 *   a package's membership of one, by package; Known home, a foreign key from each membership into its home's registry,
 *   which a registry delete must respect at COMMIT.
 * - **Curriculum** (a level over Registry): Claim, derived from the manifest, each relation of the package's own LOM
 *   record whose kind is `ispartof` and whose catalog is a home's, an element whose one descendant is its text node
 *   (its end two past its start: a comment splitting the text makes it wider, and no claim); Home, derived, the union
 *   of the two memberships; One home, a key over the derived union and every Package contained in it; Stated home, a key
 *   over Claim and Claim and Home each contained in the other.
 *
 * A package is published by one ChangeSet of two strata (publishWrite): its content replaced, then its memberships
 * written from the Claim the first stratum's rows give it (homeWrite), the second stratum writing the Registry level's
 * rows. The registry's rows are written by their own calls, and a membership may be written directly too, which is how
 * a state breaks One home's key.
 */

/** Any text of up to 256 bytes: a node's kind and characters, a home's title. */
const Chars = str.bytes(256, str.regex("^.*$", "su"))

/** A home's slug: lowercase letters and digits in words joined by single hyphens (pantry's slugPattern). */
const slugPattern = "^[a-z0-9]+(-[a-z0-9]+)*$"
const Slug = str.bytes(64, str.regex(slugPattern))

/** A package's name: a lowercase letter, then lowercase letters and digits. */
const PackageName = str.bytes(64, str.regex("^[a-z][a-z0-9]*$"))

const Package = relation("Package", { name: PackageName }, ["name"])
const Node = relation(
	"Node",
	{
		package: PackageName,
		start: int8,
		end: int8,
		parent: int8,
		kind: Chars,
		chars: Chars
	},
	["package", "start"]
)
const Course = relation("Course", { slug: Slug, title: Chars }, ["slug"])
const Assessment = relation("Assessment", { slug: Slug, title: Chars }, ["slug"])
const PackageCourse = relation("PackageCourse", { course: Slug, package: PackageName }, ["package"])
const PackageAssessment = relation(
	"PackageAssessment",
	{ assessment: Slug, package: PackageName },
	["package"]
)

/** The two kinds of home, and the catalog text a manifest names each by. */
const homeKinds = ["course", "assessment"] as const
export type HomeKind = (typeof homeKinds)[number]
const catalogOf: Readonly<Record<HomeKind, string>> = { course: "course", assessment: "assessment" }

/** The kind of node of each element a claim reads, and of a text node and a comment. */
const nodeKinds = {
	record: "lom:lom",
	relation: "lom:relation",
	catalog: "lom:catalog",
	entry: "lom:entry",
	text: "text",
	comment: "comment"
} as const

/** The owner of the package's own LOM record, the one record a claim reads. */
const manifestOwner = "manifest"

/** The relation kind that names a home, LOM's `ispartof`, as the relation element's characters, collapsed. */
const partOf = "ispartof"

/** An element's span when its one descendant is its text node: itself and one node. */
const soleTextSpan = 2n

/**
 * The levels and laws of the curriculum, under `name` (the module's header). A package's content is replaced and its
 * memberships rewritten, and a home is removed from the registry, so Node, the memberships and the homes are mutable,
 * each inside its unit: a package's rows (its nodes and its memberships), and a home's by its slug.
 */
const curriculumLevels = (name: string, homed: boolean) => {
	const Content = schema(
		name,
		[Package, Node],
		[mutable(Node), unit("Bundle", { package: PackageName })]
	)
	const Registry = schema.extend(
		[Content],
		`${name}_registry`,
		[Course, Assessment, PackageCourse, PackageAssessment],
		[
			contained(on(PackageCourse, "course"), on(Course, "slug")),
			contained(on(PackageAssessment, "assessment"), on(Assessment, "slug")),
			mutable(Course),
			mutable(Assessment),
			mutable(PackageCourse),
			mutable(PackageAssessment),
			unit("Listing", { slug: Slug })
		]
	)
	const claimRule = (kind: HomeKind) => (r: Rule<typeof Content>) => {
		const { package: pkg, kind: recordKind, chars: owner, start: record } = v(Node, "record")
		const { kind: relationKind, chars: relationValue, start: related } = v(Node, "relation")
		const { kind: catalogKind, start: catalog, end: catalogEnd } = v(Node, "catalog")
		const { kind: catalogTextKind, chars: catalogText } = v(Node, "catalogText")
		const { kind: entryKind, start: entryNode, end: entryEnd } = v(Node, "entry")
		const { kind: entryTextKind, chars: entry } = v(Node, "entryText")
		return r
			.match(Node, { package: pkg, kind: recordKind, chars: owner, start: record })
			.match(Node, {
				package: pkg,
				parent: record,
				kind: relationKind,
				chars: relationValue,
				start: related
			})
			.match(Node, {
				package: pkg,
				parent: related,
				kind: catalogKind,
				start: catalog,
				end: catalogEnd
			})
			.match(Node, { package: pkg, parent: catalog, kind: catalogTextKind, chars: catalogText })
			.match(Node, {
				package: pkg,
				parent: related,
				kind: entryKind,
				start: entryNode,
				end: entryEnd
			})
			.match(Node, { package: pkg, parent: entryNode, kind: entryTextKind, chars: entry })
			.where(r.eq(recordKind, nodeKinds.record))
			.where(r.eq(owner, manifestOwner))
			.where(r.eq(relationKind, nodeKinds.relation))
			.where(r.eq(catalogKind, nodeKinds.catalog))
			.where(r.eq(catalogTextKind, nodeKinds.text))
			.where(r.eq(entryKind, nodeKinds.entry))
			.where(r.eq(entryTextKind, nodeKinds.text))
			.where(r.eq(Type.base(catalogEnd), Num.add(Type.base(catalog), soleTextSpan)))
			.where(r.eq(Type.base(entryEnd), Num.add(Type.base(entryNode), soleTextSpan)))
			.where(r.eq(Text.collapse(relationValue), partOf))
			.where(r.eq(Text.collapse(catalogText), catalogOf[kind]))
			.find({ package: pkg, catalog: catalogOf[kind], entry, relation: related })
	}
	const Claim = derived(
		"Claim",
		query(Content).rule(claimRule("course")).rule(claimRule("assessment"))
	)
	const Home = derived(
		"Home",
		query(Registry)
			.rule((r) => {
				const { course, package: pkg } = v(PackageCourse, "course")
				return r
					.match(PackageCourse, { course, package: pkg })
					.find({ catalog: catalogOf.course, package: pkg, slug: course })
			})
			.rule((r) => {
				const { assessment, package: pkg } = v(PackageAssessment, "assessment")
				return r
					.match(PackageAssessment, { assessment, package: pkg })
					.find({ catalog: catalogOf.assessment, package: pkg, slug: assessment })
			})
	)
	return schema.extend(
		[Registry],
		`${name}_curriculum`,
		[Claim, Home],
		[
			key(on(Home, "package")),
			...(homed ? [contained(on(Package, "name"), on(Home, "package"))] : []),
			key(on(Claim, "package")),
			contained(on(Claim, "package", "catalog", "entry"), on(Home, "package", "catalog", "slug")),
			contained(on(Home, "package", "catalog", "slug"), on(Claim, "package", "catalog", "entry"))
		]
	)
}

/**
 * One home a package as the curriculum's second migration added it (production's M2), over a level of its own: the
 * registry and the memberships stored in one schema, with Known home; Home derived over them in a level above, keyed by
 * package; and, where `homed`, every Package contained in Home: a stored relation's containment in a derived one, which
 * a later migration than the one installing the relations adds and validates over the rows they hold.
 */
const homeLevels = (name: string, homed: boolean) => {
	const Stored = schema(
		name,
		[Package, Course, Assessment, PackageCourse, PackageAssessment],
		[
			contained(on(PackageCourse, "course"), on(Course, "slug")),
			contained(on(PackageAssessment, "assessment"), on(Assessment, "slug"))
		]
	)
	const Home = derived(
		"Home",
		query(Stored)
			.rule((r) => {
				const { course, package: pkg } = v(PackageCourse, "course")
				return r
					.match(PackageCourse, { course, package: pkg })
					.find({ catalog: catalogOf.course, package: pkg, slug: course })
			})
			.rule((r) => {
				const { assessment, package: pkg } = v(PackageAssessment, "assessment")
				return r
					.match(PackageAssessment, { assessment, package: pkg })
					.find({ catalog: catalogOf.assessment, package: pkg, slug: assessment })
			})
	)
	return schema.extend(
		[Stored],
		`${name}_homes`,
		[Home],
		[
			key(on(Home, "package")),
			...(homed ? [contained(on(Package, "name"), on(Home, "package"))] : [])
		]
	)
}

/** How a package stands in the rows a first version stores: absent, a package with no home, or one with its course. */
const standings = ["absent", "homeless", "homed"] as const
export type Standing = (typeof standings)[number]

/** The rows two packages' standings store under the first version, as the owner's INSERTs into the stored schema. */
const storedRows = (
	tableOf: (relation: string) => string,
	stood: readonly [Standing, Standing]
): ReadonlyArray<string> => [
	`INSERT INTO ${tableOf("Course")} (slug, title) VALUES ('c1', 'Course One')`,
	...Arr.flatMap(stood, (standing, i) => {
		const pkg = defined(packageIds[i], "a package")
		switch (standing) {
			case "absent":
				return []
			case "homeless":
				return [`INSERT INTO ${tableOf("Package")} (name) VALUES ('${pkg}')`]
			case "homed":
				return [
					`INSERT INTO ${tableOf("Package")} (name) VALUES ('${pkg}')`,
					`INSERT INTO ${tableOf("PackageCourse")} (course, package) VALUES ('c1', '${pkg}')`
				]
		}
	})
]

/** A slug as a query tests it: Slug's pattern, which a membership's writer holds a claim's entry to. */
const slugTest = Text.pattern<string>(slugPattern)

/**
 * The curriculum under `name` with its writers' programs: `publish`, a package's replace (its content deleted by its
 * name, its Package and Node rows inserted) and then, in the stratum after it, its memberships written from its Claim
 * (homeWrite); the registry's own writes; and a membership written directly.
 */
const curriculumWorld = (name: string, homed: boolean) => {
	const level = curriculumLevels(name, homed)
	const { Claim } = level.relations
	const byPackage = { package: param("package", PackageName) } as const
	const content = ChangeSet.empty(level)
		.deleteWhere({ Node: byPackage })
		.insert(Package, [])
		.insert(Node, [])
	const homeWrite = ChangeSet.empty(level)
		.delete(
			PackageCourse,
			query(level).rule((r) => {
				const pkg = r.param("package", PackageName)
				const { course } = v(PackageCourse, "stored")
				return r
					.match(PackageCourse, { course, package: pkg })
					.where(r.not(Claim, { catalog: catalogOf.course, entry: course, package: pkg }))
					.find({ course, package: pkg })
			})
		)
		.insert(
			PackageCourse,
			query(level).rule((r) => {
				const pkg = r.param("package", PackageName)
				const { entry } = v(Claim, "claim")
				return r
					.match(Claim, { catalog: catalogOf.course, entry, package: pkg })
					.where(Text.matches(entry, slugTest))
					.find({ course: entry, package: pkg })
			})
		)
		.delete(
			PackageAssessment,
			query(level).rule((r) => {
				const pkg = r.param("package", PackageName)
				const { assessment } = v(PackageAssessment, "stored")
				return r
					.match(PackageAssessment, { assessment, package: pkg })
					.where(r.not(Claim, { catalog: catalogOf.assessment, entry: assessment, package: pkg }))
					.find({ assessment, package: pkg })
			})
		)
		.insert(
			PackageAssessment,
			query(level).rule((r) => {
				const pkg = r.param("package", PackageName)
				const { entry } = v(Claim, "claim")
				return r
					.match(Claim, { catalog: catalogOf.assessment, entry, package: pkg })
					.where(Text.matches(entry, slugTest))
					.find({ assessment: entry, package: pkg })
			})
		)
	const programs = {
		publish: ChangeSet.sequence(content, homeWrite),
		register: ChangeSet.empty(level).insert(Course, []).insert(Assessment, []),
		removeCourse: ChangeSet.empty(level).deleteWhere({ Course: { slug: param("slug", Slug) } }),
		removeAssessment: ChangeSet.empty(level).deleteWhere({
			Assessment: { slug: param("slug", Slug) }
		}),
		join: ChangeSet.empty(level).insert(PackageCourse, []).insert(PackageAssessment, [])
	}
	return { level, programs, world: fullWorld(level, programs, []) }
}

/** The curriculum installed once per member with its writers' login, as `grizzle generate` drafts it. */
export const curriculumTemplate = generatedTemplate({
	declaredIn: import.meta,
	name: "curriculum",
	content: { level: "curriculum", homed: true },
	build: (name) => ({
		schema: curriculumWorld(name, true).level,
		logins: [curriculumWorld(name, true).world.server]
	}),
	ambient: ordinarySession
})

/** The packages a case publishes, and the slugs it registers and names: two courses, one assessment. */
const packageIds = ["p", "q"] as const
export type PackageId = (typeof packageIds)[number]
const slugsOf: Readonly<Record<HomeKind, Arr.NonEmptyReadonlyArray<string>>> = {
	course: ["c1", "c2"],
	assessment: ["a1"]
}
/** An entry a manifest's relation names: a registered or unregistered slug, or a text that is no slug. */
const entries = ["c1", "c2", "a1", "Not_A_Slug"] as const

/**
 * One relation of a package's LOM records, as drawn: the record it is in (the package's own, or a resource's); its
 * kind's characters (`ispartof`, padded with whitespace, or another kind); the catalog it names (a home's or another);
 * how its catalog's text is written: one text node, split by a comment into two pieces whose characters join to the
 * catalog, or the catalog's whole text then a comment and more text; and its entry.
 */
export interface RelationSketch {
	readonly owner: "manifest" | "resource"
	readonly kind: "ispartof" | "padded" | "haspart"
	readonly catalog: HomeKind | "elsewhere"
	readonly text: "whole" | "split" | "trailed"
	readonly entry: (typeof entries)[number]
}

/** One call of a case: a package published with its relations, a home removed from the registry, or a membership written. */
export type Op =
	| {
			readonly kind: "publish"
			readonly package: PackageId
			readonly relations: ReadonlyArray<RelationSketch>
	  }
	| { readonly kind: "remove"; readonly home: HomeKind; readonly slug: string }
	| {
			readonly kind: "join"
			readonly package: PackageId
			readonly home: HomeKind
			readonly slug: string
	  }

/** A case: the homes registered before its calls, and its calls, each its own transaction, in order. */
export interface CurriculumCase {
	readonly registered: ReadonlyArray<readonly [HomeKind, string]>
	readonly ops: ReadonlyArray<Op>
}

/** The laws of the curriculum, by what each states, and the memberships' own keys. */
const curriculumLaws = [
	"known course",
	"known assessment",
	"one home a package",
	"every package homed",
	"one claim a package",
	"every claim a membership",
	"every membership a claim",
	"one course a package",
	"one assessment a package"
] as const
type CurriculumLaw = (typeof curriculumLaws)[number]

/** The containments of the curriculum by the relation of their source side: Known home's, One home's and Stated home's. */
const containmentsBySource: Readonly<Record<string, CurriculumLaw>> = {
	PackageCourse: "known course",
	PackageAssessment: "known assessment",
	Package: "every package homed",
	Claim: "every claim a membership",
	Home: "every membership a claim"
}

/** The keys of the curriculum by the relation they key: One home's over Home, Stated home's over Claim. */
const keysByRelation: Readonly<Record<string, CurriculumLaw>> = {
	Home: "one home a package",
	Claim: "one claim a package"
}

/** The memberships' primary keys by their relation. */
const primaryKeysByRelation: Readonly<Record<string, CurriculumLaw>> = {
	PackageCourse: "one course a package",
	PackageAssessment: "one assessment a package"
}

/** The law a refusal names, by what it states; none for a law the curriculum does not state. */
const lawOf = (refused: Law): CurriculumLaw | undefined => {
	const law = refused.kind === "above" ? refused.law : refused
	switch (law.kind) {
		case "contained":
			return containmentsBySource[law.from.relation]
		case "key":
			return keysByRelation[law.side.relation]
		case "primaryKey":
			return primaryKeysByRelation[law.relation]
		case "check":
		case "contract":
		case "coverage":
		case "family":
		case "fold":
		case "generated":
		case "pattern":
		case "variant":
		case "sealed":
		case "tree":
			return undefined
	}
}

/** A membership of a package, of one kind, at a slug. */
interface Membership {
	readonly package: PackageId
	readonly home: HomeKind
	readonly slug: string
}

/** A claim: a relation of a package's manifest, by its place among them, naming a home of one kind at an entry. */
interface Claimed {
	readonly package: PackageId
	readonly relation: number
	readonly home: HomeKind
	readonly entry: string
}

/** The curriculum's state as the host holds it. */
interface CurriculumState {
	readonly manifests: ReadonlyArray<readonly [PackageId, ReadonlyArray<RelationSketch>]>
	readonly homes: ReadonlyArray<readonly [HomeKind, string]>
	readonly memberships: ReadonlyArray<Membership>
}

const emptyCurriculum: CurriculumState = { manifests: [], homes: [], memberships: [] }

/** Whether a relation claims a home: in the package's own record, of kind `ispartof` collapsed, into a home's catalog, its catalog's text one text node. */
const claimOf = (r: RelationSketch): Option.Option<HomeKind> =>
	r.owner === "manifest" && r.kind !== "haspart" && r.text === "whole" && r.catalog !== "elsewhere"
		? Option.some(r.catalog)
		: Option.none()

/** Whether a relation would claim its home if its catalog's text were one text node: what a split withholds. */
const splitWithholds = (r: RelationSketch): boolean =>
	r.text !== "whole" && Option.isSome(claimOf({ ...r, text: "whole" }))

const claimsOf = (state: CurriculumState): ReadonlyArray<Claimed> =>
	Arr.flatMap(state.manifests, ([pkg, relations]) =>
		Arr.flatMap(relations, (r, relation) =>
			Option.match(claimOf(r), {
				onNone: () => [],
				onSome: (home) => [{ package: pkg, relation, home, entry: r.entry }]
			})
		)
	)

const slugText = regex(slugPattern)

const isSlug = (chars: string): boolean => slugText.test(chars)

/** Every law the state breaks. */
const brokenIn = (state: CurriculumState): ReadonlyArray<CurriculumLaw> => {
	const claims = claimsOf(state)
	const registered = (home: HomeKind, slug: string) =>
		Arr.some(state.homes, ([h, s]) => h === home && s === slug)
	const homesOf = (pkg: PackageId) => Arr.filter(state.memberships, (m) => m.package === pkg)
	const packages = Arr.map(state.manifests, ([pkg]) => pkg)
	return Arr.filter(curriculumLaws, (law) => {
		switch (law) {
			case "known course":
				return Arr.some(
					state.memberships,
					(m) => m.home === "course" && !registered("course", m.slug)
				)
			case "known assessment":
				return Arr.some(
					state.memberships,
					(m) => m.home === "assessment" && !registered("assessment", m.slug)
				)
			case "one home a package":
				return Arr.some(packages, (pkg) => homesOf(pkg).length > 1)
			case "every package homed":
				return Arr.some(packages, (pkg) => homesOf(pkg).length === 0)
			case "one claim a package":
				return Arr.some(packages, (pkg) => Arr.filter(claims, (c) => c.package === pkg).length > 1)
			case "every claim a membership":
				return Arr.some(
					claims,
					(c) =>
						!Arr.some(
							state.memberships,
							(m) => m.package === c.package && m.home === c.home && m.slug === c.entry
						)
				)
			case "every membership a claim":
				return Arr.some(
					state.memberships,
					(m) =>
						!Arr.some(
							claims,
							(c) => m.package === c.package && m.home === c.home && m.slug === c.entry
						)
				)
			case "one course a package":
			case "one assessment a package":
				return false
		}
	})
}

/** What a call does to the host's state: its next state, or the key its write itself breaks (two facts at one key). */
type Applied =
	| { readonly kind: "state"; readonly next: CurriculumState }
	| { readonly kind: "key"; readonly law: CurriculumLaw }

const sameMembership = (a: Membership, b: Membership): boolean =>
	a.package === b.package && a.home === b.home && a.slug === b.slug

/** Memberships inserted beside `kept`: a fact already kept is no change; two facts of one package and kind break its key. */
const inserted = (
	kept: ReadonlyArray<Membership>,
	added: ReadonlyArray<Membership>
): Result<ReadonlyArray<Membership>> => {
	const all = Arr.dedupeWith([...kept, ...added], sameMembership)
	const clash = Arr.findFirst(all, (m) =>
		Arr.some(all, (n) => n.package === m.package && n.home === m.home && n.slug !== m.slug)
	)
	return Option.match(clash, {
		onNone: () => ({ kind: "kept", memberships: all }),
		onSome: (m) => ({
			kind: "clash",
			law: m.home === "course" ? "one course a package" : "one assessment a package"
		})
	})
}
type Result<A> =
	| { readonly kind: "kept"; readonly memberships: A }
	| { readonly kind: "clash"; readonly law: CurriculumLaw }

const applied = (
	inserting: Result<ReadonlyArray<Membership>>,
	state: CurriculumState,
	manifests: CurriculumState["manifests"]
): Applied =>
	inserting.kind === "clash"
		? { kind: "key", law: inserting.law }
		: { kind: "state", next: { ...state, manifests, memberships: inserting.memberships } }

/** The host's judgment of one call on `state` (the module's header). */
const applyOp = (state: CurriculumState, op: Op): Applied => {
	switch (op.kind) {
		case "publish": {
			const manifests = Arr.append(
				Arr.filter(state.manifests, ([pkg]) => pkg !== op.package),
				[op.package, op.relations] as const
			)
			const claims = Arr.filter(claimsOf({ ...state, manifests }), (c) => c.package === op.package)
			const kept = Arr.filter(
				state.memberships,
				(m) =>
					m.package !== op.package ||
					Arr.some(claims, (c) => c.home === m.home && c.entry === m.slug)
			)
			const added = Arr.flatMap(claims, (c) =>
				isSlug(c.entry) ? [{ package: op.package, home: c.home, slug: c.entry }] : []
			)
			return applied(inserted(kept, added), state, manifests)
		}
		case "remove":
			return {
				kind: "state",
				next: {
					...state,
					homes: Arr.filter(state.homes, ([h, s]) => !(h === op.home && s === op.slug))
				}
			}
		case "join":
			return applied(
				inserted(state.memberships, [{ package: op.package, home: op.home, slug: op.slug }]),
				state,
				state.manifests
			)
	}
}

/** A relation as text, every coordinate of it. */
const relationText = (r: RelationSketch): string =>
	`${r.owner}/${r.kind}/${r.catalog}/${r.text}/${r.entry}`

/** A state as text that tells two states apart exactly when their stored rows differ. */
const stateText = (state: CurriculumState): string =>
	Arr.join(
		[
			...Arr.sort(
				Arr.map(
					state.manifests,
					([pkg, rs]) => `${pkg}:${Arr.join(Arr.map(rs, relationText), ",")}`
				),
				Order.String
			),
			...Arr.sort(
				Arr.map(state.homes, ([h, s]) => `home ${h}:${s}`),
				Order.String
			),
			...Arr.sort(
				Arr.map(state.memberships, (m) => `member ${m.package}:${m.home}:${m.slug}`),
				Order.String
			)
		],
		"; "
	)

/** A node of a manifest's tree, before its place is numbered. */
interface Tree {
	readonly kind: string
	readonly chars: string
	readonly children: ReadonlyArray<Tree>
}

const text = (chars: string): Tree => ({ kind: nodeKinds.text, chars, children: [] })
const branch = (kind: string, children: ReadonlyArray<Tree>, chars: string): Tree => ({
	kind,
	chars,
	children
})

/** A relation's catalog element: its text as one node, split by a comment into two pieces, or trailed by a comment and more text. */
const catalogTree = (r: RelationSketch): Tree => {
	const literal = r.catalog === "elsewhere" ? "elsewhere" : catalogOf[r.catalog]
	switch (r.text) {
		case "whole":
			return branch(nodeKinds.catalog, [text(literal)], "")
		case "split":
			return branch(
				nodeKinds.catalog,
				[
					text(Str.slice(0, 2)(literal)),
					branch(nodeKinds.comment, [], "x"),
					text(Str.slice(2)(literal))
				],
				""
			)
		case "trailed":
			return branch(
				nodeKinds.catalog,
				[text(literal), branch(nodeKinds.comment, [], "x"), text("x")],
				""
			)
	}
}

const relationChars: Readonly<Record<RelationSketch["kind"], string>> = {
	ispartof: partOf,
	padded: ` ${partOf}\t`,
	haspart: "haspart"
}

const relationTree = (r: RelationSketch): Tree =>
	branch(
		nodeKinds.relation,
		[catalogTree(r), branch(nodeKinds.entry, [text(r.entry)], "")],
		relationChars[r.kind]
	)

/** A package's manifest as a tree: its own LOM record holding its relations, and a resource's record when one holds some. */
const manifestTrees = (relations: ReadonlyArray<RelationSketch>): ReadonlyArray<Tree> => {
	const resource = Arr.filter(relations, (r) => r.owner === "resource")
	return [
		branch(
			nodeKinds.record,
			Arr.map(
				Arr.filter(relations, (r) => r.owner === "manifest"),
				relationTree
			),
			manifestOwner
		),
		...(resource.length === 0
			? []
			: [branch(nodeKinds.record, Arr.map(resource, relationTree), "resource")])
	]
}

/** A Node row, as a write states it. */
interface NodeRow {
	readonly package: string
	readonly start: bigint
	readonly end: bigint
	readonly parent: bigint
	readonly kind: string
	readonly chars: string
}

/** A package's manifest as Node rows: each node by its pre-order start from 1, its end one past its last descendant, its parent's start (0 for a record). */
const nodeRows = (
	pkg: PackageId,
	relations: ReadonlyArray<RelationSketch>
): ReadonlyArray<NodeRow> => {
	const rows: Array<NodeRow> = []
	const place = (tree: Tree, parent: bigint, start: bigint): bigint => {
		let next = start + 1n
		for (const child of tree.children) {
			next = place(child, start, next)
		}
		rows.push({ package: pkg, start, end: next, parent, kind: tree.kind, chars: tree.chars })
		return next
	}
	Arr.reduce(manifestTrees(relations), 1n, (start, tree) => place(tree, 0n, start))
	return rows
}

/** What a case reaches: each law shape production relies on, met by a call the real system answered as the host. */
export type CurriculumFeature =
	| "a publish's second stratum writes a membership"
	| "a state breaking the key over the derived union refused"
	| "a claim and the memberships disagreeing refused"
	| "a second claim of a package refused"
	| "a package without a home refused"
	| "a registry delete of a home with members refused at COMMIT"
	| "a registry delete of an empty home accepted"
	| "a catalog split by a comment claims nothing"
	| "a membership in an unregistered home refused"
	| "unchanged"

const relationGen: Gen<RelationSketch> = (source) => ({
	owner: source.draw(
		weighted([
			[7, constant<RelationSketch["owner"]>("manifest")],
			[1, constant<RelationSketch["owner"]>("resource")]
		])
	),
	kind: source.draw(
		weighted([
			[5, constant<RelationSketch["kind"]>("ispartof")],
			[1, constant<RelationSketch["kind"]>("padded")],
			[1, constant<RelationSketch["kind"]>("haspart")]
		])
	),
	catalog: source.draw(
		weighted([
			[3, constant<RelationSketch["catalog"]>("course")],
			[2, constant<RelationSketch["catalog"]>("assessment")],
			[1, constant<RelationSketch["catalog"]>("elsewhere")]
		])
	),
	text: source.draw(
		weighted([
			[5, constant<RelationSketch["text"]>("whole")],
			[1, constant<RelationSketch["text"]>("split")],
			[1, constant<RelationSketch["text"]>("trailed")]
		])
	),
	entry: source.draw(element(entries))
})

const homeGen: Gen<readonly [HomeKind, string]> = (source) => {
	const home = source.draw(element(homeKinds))
	return [home, source.draw(element(slugsOf[home]))] as const
}

const opGen: Gen<Op> = weighted([
	[
		6,
		(source): Op => ({
			kind: "publish",
			package: source.draw(element(packageIds)),
			relations: source.draw(array(relationGen, { min: 0, max: 2 }))
		})
	],
	[
		1,
		(source): Op => {
			const [home, slug] = source.draw(homeGen)
			return { kind: "remove", home, slug }
		}
	],
	[
		1,
		(source): Op => {
			const [home, slug] = source.draw(homeGen)
			return { kind: "join", package: source.draw(element(packageIds)), home, slug }
		}
	]
])

/** A case: each home registered or not, then one to four calls. */
export const curriculumCaseGen: Gen<CurriculumCase> = (source) => ({
	registered: Arr.filter(
		[
			["course", "c1"],
			["course", "c2"],
			["assessment", "a1"]
		] as const,
		() => source.draw(boolean)
	),
	ops: source.draw(array(opGen, { min: 1, max: 4 }))
})

/** A relation of the package's own record claiming `home` at `entry`, its catalog's text written as `text`. */
const claiming = (
	home: HomeKind,
	entry: (typeof entries)[number],
	text: RelationSketch["text"]
): RelationSketch => ({
	owner: "manifest",
	kind: "ispartof",
	catalog: home,
	text,
	entry
})

/**
 * A case constructed to reach each required situation, which a witness whose turn aims at it draws (aimed): the drawn
 * cases reach most of them a few times a run, these every run.
 */
export const curriculumAims: ReadonlyArray<
	readonly [Reached<CurriculumFeature>, Gen<CurriculumCase>]
> = [
	[
		"a publish's second stratum writes a membership",
		constant({
			registered: [["course", "c1"]],
			ops: [{ kind: "publish", package: "p", relations: [claiming("course", "c1", "whole")] }]
		})
	],
	[
		"a state breaking the key over the derived union refused",
		constant({
			registered: [
				["course", "c1"],
				["assessment", "a1"]
			],
			ops: [
				{ kind: "publish", package: "p", relations: [claiming("course", "c1", "whole")] },
				{ kind: "join", package: "p", home: "assessment", slug: "a1" }
			]
		})
	],
	[
		"a claim and the memberships disagreeing refused",
		constant({
			registered: [["course", "c1"]],
			ops: [
				{ kind: "publish", package: "p", relations: [claiming("course", "Not_A_Slug", "whole")] }
			]
		})
	],
	[
		"a second claim of a package refused",
		constant({
			registered: [
				["course", "c1"],
				["assessment", "a1"]
			],
			ops: [
				{
					kind: "publish",
					package: "p",
					relations: [claiming("course", "c1", "whole"), claiming("assessment", "a1", "whole")]
				}
			]
		})
	],
	[
		"a package without a home refused",
		constant({ registered: [], ops: [{ kind: "publish", package: "p", relations: [] }] })
	],
	[
		"a registry delete of a home with members refused at COMMIT",
		constant({
			registered: [["course", "c1"]],
			ops: [
				{ kind: "publish", package: "p", relations: [claiming("course", "c1", "whole")] },
				{ kind: "remove", home: "course", slug: "c1" }
			]
		})
	],
	[
		"a registry delete of an empty home accepted",
		constant({
			registered: [["course", "c2"]],
			ops: [{ kind: "remove", home: "course", slug: "c2" }]
		})
	],
	[
		"a catalog split by a comment claims nothing",
		constant({
			registered: [
				["course", "c1"],
				["assessment", "a1"]
			],
			ops: [
				{
					kind: "publish",
					package: "p",
					relations: [claiming("course", "c1", "trailed"), claiming("assessment", "a1", "whole")]
				}
			]
		})
	],
	[
		"a membership in an unregistered home refused",
		constant({
			registered: [],
			ops: [{ kind: "publish", package: "p", relations: [claiming("course", "c2", "whole")] }]
		})
	]
]

/** Thrown into a case's failure when the real system answered a call otherwise than the host. */
class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** What the two packages' standings reach under the later migration. */
export type MigrationFeature =
	| "a later containment the stored rows break refused"
	| "a later containment the stored rows keep applied"
	| "a package without a home refused at COMMIT after the migration"

/** Every pair of standings of the two packages: the box the later migration is exhausted over. */
export const standingsSpace: Gen<readonly [Standing, Standing]> = (source) =>
	[source.draw(element(standings)), source.draw(element(standings))] as const

/** A stored relation's table in the installation `name` of homeLevels, schema-qualified. */
const storedTable =
	(name: string) =>
	(relation: string): string =>
		`${quoteIdent(identifierOf(identity.schema(parsedSchemaName(name))))}.${quoteIdent(identifierOf(identity.table(parsedName(relation))))}`

/**
 * One case of the later migration (the test module's header): the first version installed, the standings' rows stored
 * as the owner, the second version migrated; the migration must fail with 23000 exactly when a stored package has no
 * home, and once it applies a package written without a home is refused at COMMIT, and one with its course commits.
 */
export const migrationCase = (
	stood: readonly [Standing, Standing],
	c: Case<MigrationFeature>
): Effect.Effect<void, Disagreed | SqlError | TransactionRolledBack, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		let tableOf = storedTable("")
		const breaks = Arr.contains(stood, "homeless")
		const outcome = yield* Effect.result(
			migrated({
				label: "curriculum",
				schemaName: { kind: "unique" },
				first: (name) => {
					tableOf = storedTable(name)
					return { schema: homeLevels(name, false), logins: [] }
				},
				later: [(name) => ({ schema: homeLevels(name, true), logins: [] })],
				apply: { kind: "noPlaceholders" },
				declared: () => noDeclarations,
				observe: Option.some((version: number, owner: RawSession) =>
					version === 0
						? Effect.flatMap(attempt(owner, storedRows(tableOf, stood)), (stored) =>
								stored.kind === "committed"
									? Effect.void
									: Effect.die(
											new Error(
												`the first version refused rows it admits: ${refusalText(stored.fields)}`
											)
										)
							).pipe(Effect.orDie)
						: Effect.void
				)
			})
		)
		if (outcome._tag === "Failure") {
			const failure = outcome.failure
			const byCheck =
				failure._tag === "MigrateError" &&
				failure.reason._tag === "StatementFailed" &&
				failure.reason.failure._tag === "ServerError" &&
				failure.reason.failure.sqlstate === "23000"
			if (!breaks || !byCheck) {
				return yield* new Disagreed({
					message: `the migration failed (${failure.message}) where the stored rows ${breaks ? "break" : "keep"} One home: ${Formatter.format(stood)}`
				})
			}
			c.note("a later containment the stored rows break refused")
			return
		}
		if (breaks) {
			return yield* new Disagreed({
				message: `the migration applied One home's containment over a package with no home: ${Formatter.format(stood)}`
			})
		}
		c.note("a later containment the stored rows keep applied")
		const owner = outcome.success.owner
		const homeless = yield* attempt(owner, [
			`INSERT INTO ${tableOf("Package")} (name) VALUES ('r')`
		])
		if (homeless.kind === "committed" || homeless.moment.kind !== "commit") {
			return yield* new Disagreed({
				message: `a package written without a home after the migration ${homeless.kind === "committed" ? "committed" : `was refused ${momentText(homeless.moment)}`}, where One home refuses it at COMMIT: ${Formatter.format(stood)}`
			})
		}
		c.note("a package without a home refused at COMMIT after the migration")
		const homed = yield* attempt(owner, [
			`INSERT INTO ${tableOf("Package")} (name) VALUES ('s')`,
			`INSERT INTO ${tableOf("PackageCourse")} (course, package) VALUES ('c1', 's')`
		])
		if (homed.kind !== "committed") {
			return yield* new Disagreed({
				message: `a package written with its course after the migration was refused by ${refusalText(homed.fields)}: ${Formatter.format(stood)}`
			})
		}
	})

/** A call's answer as the oracle reads it: accepted, unchanged, or refused naming laws, every one or some of them. */
type Answer =
	| { readonly kind: "accepted" | "unchanged" }
	| {
			readonly kind: "refused"
			readonly every: boolean
			readonly named: ReadonlyArray<CurriculumLaw | undefined>
	  }
	| { readonly kind: "other"; readonly shown: string }

/** A write's answer as the oracle reads it (Answer). */
const answerOf = <O extends { readonly _tag: string }>(outcome: WriteAnswer<O>): Answer =>
	outcome._tag === "accepted" || outcome._tag === "unchanged"
		? { kind: outcome._tag }
		: "refused" in outcome
			? {
					kind: "refused",
					every: outcome.refused.kind === "every",
					named: Arr.map(refusedLaws(outcome.refused), lawOf)
				}
			: { kind: "other", shown: Formatter.format(outcome) }

/**
 * Whether an answer is the host's for a call (applyOp): a refusal where the call breaks a key of its own write or leaves
 * a state breaking a law, naming only laws it breaks (some of them when it names some, every one when it names every);
 * otherwise accepted, or unchanged when the stored rows stay as they are.
 */
const agrees = (answer: Answer, before: CurriculumState, expected: Applied): boolean => {
	const broken: ReadonlyArray<CurriculumLaw> =
		expected.kind === "key" ? [expected.law] : brokenIn(expected.next)
	if (broken.length > 0 || expected.kind === "key") {
		if (answer.kind !== "refused" || !Arr.isReadonlyArrayNonEmpty(answer.named)) {
			return false
		}
		const breaks = (law: CurriculumLaw | undefined) =>
			law !== undefined &&
			(expected.kind === "key" ? Arr.contains(curriculumLaws, law) : Arr.contains(broken, law))
		return answer.every ? Arr.every(answer.named, breaks) : Arr.some(answer.named, breaks)
	}
	return stateText(expected.next) === stateText(before)
		? answer.kind === "unchanged"
		: answer.kind === "accepted"
}

/** What a call reached, given the state before it, the host's judgment and the answer that agreed with it. */
const featuresOf = (
	op: Op,
	before: CurriculumState,
	expected: Applied
): ReadonlyArray<CurriculumFeature> => {
	if (expected.kind === "key") {
		return []
	}
	const broken = brokenIn(expected.next)
	const membersBefore = Arr.filter(
		before.memberships,
		(m) => op.kind !== "remove" && m.package === op.package
	)
	const membersAfter = Arr.filter(
		expected.next.memberships,
		(m) => op.kind !== "remove" && m.package === op.package
	)
	return [
		...(op.kind === "publish" &&
		broken.length === 0 &&
		stateText(expected.next) !== stateText(before) &&
		membersBefore.length + membersAfter.length > 0 &&
		Arr.join(
			Arr.map(membersBefore, (m) => `${m.home}:${m.slug}`),
			","
		) !==
			Arr.join(
				Arr.map(membersAfter, (m) => `${m.home}:${m.slug}`),
				","
			)
			? (["a publish's second stratum writes a membership"] as const)
			: []),
		...(Arr.contains(broken, "one home a package")
			? (["a state breaking the key over the derived union refused"] as const)
			: []),
		...(Arr.contains(broken, "every claim a membership") ||
		Arr.contains(broken, "every membership a claim")
			? (["a claim and the memberships disagreeing refused"] as const)
			: []),
		...(Arr.contains(broken, "one claim a package")
			? (["a second claim of a package refused"] as const)
			: []),
		...(Arr.contains(broken, "every package homed")
			? (["a package without a home refused"] as const)
			: []),
		...(op.kind === "remove" &&
		(Arr.contains(broken, "known course") || Arr.contains(broken, "known assessment"))
			? (["a registry delete of a home with members refused at COMMIT"] as const)
			: []),
		...(op.kind === "remove" &&
		broken.length === 0 &&
		stateText(expected.next) !== stateText(before)
			? (["a registry delete of an empty home accepted"] as const)
			: []),
		...(op.kind === "publish" && Arr.some(op.relations, splitWithholds)
			? (["a catalog split by a comment claims nothing"] as const)
			: []),
		...(op.kind !== "remove" &&
		(Arr.contains(broken, "known course") || Arr.contains(broken, "known assessment"))
			? (["a membership in an unregistered home refused"] as const)
			: []),
		...(broken.length === 0 && stateText(expected.next) === stateText(before)
			? (["unchanged"] as const)
			: [])
	]
}

/** Why a curriculum case fails: a disagreement with the host, a call's or a statement's error, or its database's. */
type CurriculumError =
	| Disagreed
	| CallError
	| SqlError
	| TransactionRolledBack
	| NeedFailed
	| OpenError

/** A membership as a row reads it back: its package, kind and slug. */
const membershipText = (m: Membership): string => `${m.package}:${m.home}:${m.slug}`

/**
 * A batch of curriculum cases on one clone of its own (curriculumHistories): the installation's login served
 * over the clone and one Db opened on it for the batch; each case empties the installation's tables as the owner,
 * registers its homes, then makes its calls in order, each judged by the host (agrees) and noted (featuresOf), and ends
 * with the stored memberships and homes compared with the host's.
 */
export const runCurriculum =
	(resources: Resources<{ readonly fresh: TemplateNeed<SubstrateCase<Generated>> }>) =>
	(batch: Arr.NonEmptyReadonlyArray<readonly [CurriculumCase, Case<CurriculumFeature>]>) =>
		Effect.gen(function* () {
			const { substrate, value: generated } = yield* resources.fresh
			const world = curriculumWorld(generated.installed.declared, true).world
			const served = servedGenerated(generated, world.server)
			const context = yield* Layer.build(served.layer)
			const db = yield* Db.open(served.login.roles.app, {}).pipe(Effect.provideContext(context))
			const tables = installationGroup(namesOf(generated.installed))
			const homeRows = (home: HomeKind) =>
				`SELECT slug::text FROM ${home === "course" ? tableIn(generated.installed, "Course") : tableIn(generated.installed, "Assessment")}`
			return Arr.map(batch, ([k, c]): Effect.Effect<void, CurriculumError> =>
				Effect.gen(function* () {
					yield* clearRows(substrate.admin, tables)
					const registering = yield* writeAnswerOf(
						db.workload.register.once({
							params: {},
							facts: {
								insert: {
									Course: Arr.flatMap(k.registered, ([h, slug]) =>
										h === "course" ? [{ slug, title: slug }] : []
									),
									Assessment: Arr.flatMap(k.registered, ([h, slug]) =>
										h === "assessment" ? [{ slug, title: slug }] : []
									)
								}
							}
						})
					)
					const registered = answerOf(registering)
					if (registered.kind !== (k.registered.length === 0 ? "unchanged" : "accepted")) {
						return yield* new Disagreed({
							message: `registering ${Formatter.format(k.registered)} answered ${Formatter.format(registered)}`
						})
					}
					let state: CurriculumState = { ...emptyCurriculum, homes: k.registered }
					for (const op of k.ops) {
						const expected = applyOp(state, op)
						const called = yield* writeAnswerOf(
							op.kind === "publish"
								? db.workload.publish.once({
										params: { package: op.package },
										facts: {
											insert: {
												Package: [{ name: op.package }],
												Node: nodeRows(op.package, op.relations)
											}
										}
									})
								: op.kind === "remove"
									? op.home === "course"
										? db.workload.removeCourse.once({ params: { slug: op.slug }, facts: {} })
										: db.workload.removeAssessment.once({ params: { slug: op.slug }, facts: {} })
									: db.workload.join.once({
											params: {},
											facts: {
												insert: {
													PackageCourse:
														op.home === "course" ? [{ course: op.slug, package: op.package }] : [],
													PackageAssessment:
														op.home === "assessment"
															? [{ assessment: op.slug, package: op.package }]
															: []
												}
											}
										})
						)
						const answer = answerOf(called)
						if (!agrees(answer, state, expected)) {
							return yield* new Disagreed({
								message: `${Formatter.format(op)} answered ${Formatter.format(answer)} where the host ${expected.kind === "key" ? `breaks ${expected.law}` : `leaves ${stateText(expected.next)}, breaking ${Formatter.format(brokenIn(expected.next))}`}, from ${stateText(state)}`
							})
						}
						c.noteAll(featuresOf(op, state, expected))
						if (expected.kind === "state" && brokenIn(expected.next).length === 0) {
							state = expected.next
						}
					}
					const courseMembers = yield* substrate.admin.queryValues(
						`SELECT package::text, course::text FROM ${tableIn(generated.installed, "PackageCourse")}`,
						[]
					)
					const assessmentMembers = yield* substrate.admin.queryValues(
						`SELECT package::text, assessment::text FROM ${tableIn(generated.installed, "PackageAssessment")}`,
						[]
					)
					const courses = yield* substrate.admin.queryValues(homeRows("course"), [])
					const assessments = yield* substrate.admin.queryValues(homeRows("assessment"), [])
					const stored = Arr.sort(
						[
							...Arr.map(courseMembers, (row) => `${String(row[0])}:course:${String(row[1])}`),
							...Arr.map(
								assessmentMembers,
								(row) => `${String(row[0])}:assessment:${String(row[1])}`
							)
						],
						Order.String
					)
					const homes = Arr.sort(
						[
							...Arr.map(courses, (row) => `course:${String(row[0])}`),
							...Arr.map(assessments, (row) => `assessment:${String(row[0])}`)
						],
						Order.String
					)
					const hosted = Arr.sort(Arr.map(state.memberships, membershipText), Order.String)
					const hostedHomes = Arr.sort(
						Arr.map(state.homes, ([h, s]) => `${h}:${s}`),
						Order.String
					)
					if (
						Arr.join(stored, ";") !== Arr.join(hosted, ";") ||
						Arr.join(homes, ";") !== Arr.join(hostedHomes, ";")
					) {
						return yield* new Disagreed({
							message: `the stored memberships ${Formatter.format(stored)} and homes ${Formatter.format(homes)}, where the host holds ${Formatter.format(hosted)} and ${Formatter.format(hostedHomes)}`
						})
					}
				}).pipe(Effect.scoped)
			)
		})

/**
 * How long one curriculum case may run on the runner: a case's calls each commit through the curriculum's set judge,
 * whose probes of Claim join six Node rows apiece, and at a loaded machine's commit a call took tens of seconds, so
 * the runner's case deadline (60 s) cut a case as hung that a long deadline let pass.
 *
 * @limitKind measured
 * @owner test/pg/laws/curriculum.test.ts
 * @unit milliseconds
 * @scope one case of curriculumHistories on the runner
 * @evidence each case's wall time from its verdict's start to its end, written by a probe finalizer to
 *   ~/.cache/grizzle-release/TESTSYS/GZ-LAWS/out/curriculum-cases-20261117.jsonl (the probe and its 900 s deadline not
 *   committed), with the run's report in run-curriculum3.log beside it
 * @observed 2026-11-17 11:42 to 11:52 UTC, one run
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, load average 385 to 510 from other lanes; a private
 *   family of 4 members of the pinned PostgreSQL 19rc2, fsync off; grizzle at 706f9920 with vendor/toolchain at 62b8f1d;
 *   Node 26.13.1
 * @workload toolchain-test run test/pg/laws/curriculum.test.ts#curriculumHistories at TEST_SEED=1: 150 sampled cases
 *   and 38 floor cases, every one passing
 * @result case wall time p50 1.1 s, p90 5.0 s, p99 85.3 s, the slowest 104.3 s; at the runner's 60 s two earlier runs
 *   at the same load cut a case as hung that replayed alone in 57 s with the process's start
 * @decision 210 s, about twice the slowest case observed; a case past it hangs rather than runs slowly
 * @revalidate a case of more calls (curriculumCaseGen), a curriculum of more matches in Claim, a machine of other cores
 *   or load, a PostgreSQL repin, or the runner's case deadline measured again
 */
export const curriculumDeadline = 210_000

/** A relation's table of an installation, schema-qualified, by the installation's own names. */
const tableIn = (installed: Installed, relation: string): string =>
	printObjectName(installed.names.relation(relation))
