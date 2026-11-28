/**
 * A role's world views, the one derivation of them (main's ruling): each query entry's view, its definition lowered over
 * the role's base, read through a derived table where its heading holds a closed id, whose decoded column
 * follows the id, and bound under its view scope (sql/bind.ts bindView, sql/naming.ts ViewScope). The role's compile
 * computes them once (program/schema.ts roleArtifacts, ArtifactsWorld `role`), the binding reads each read of a view by
 * them (sql/bind.ts BindView `world`), and the installation creates each from them (physical/ddl/roles.ts), generate's
 * through its served workload's extension, so a view's body and every plan of a read of it are one value. An
 * installation no extension hands a role's views to computes them by this function, once per role. What their bodies
 * need of the installation is read from the same definitions (worldViewTypes), so the plan they are lowered under names
 * every domain a body casts to, and the installation planned from it installs each.
 */
import {
	extendNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { WorldAnalysis } from "#compiler/analysis/derived/world.ts"
import type { CheckedSchema, RoleWorld } from "#compiler/analysis/schema.ts"
import { unwrap } from "#compiler/core/canonical.ts"
import {
	type Identity,
	identifierOf,
	identity,
	nameFaultText,
	parseDeclaredName
} from "#compiler/core/identity.ts"
import type { IdentityKind } from "#compiler/core/ids.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import { missing } from "#compiler/ir/physical.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { baseOf } from "#compiler/ir/scalar.ts"
import { leakyEquality } from "#compiler/physical/access/catalog.ts"
import { rosterConstants } from "#compiler/physical/ddl/constants.ts"
import { dagObjects, noServedTypes, type ServedTypes } from "#compiler/physical/ddl/domains.ts"
import type { InstallNames, NamedRole } from "#compiler/physical/ddl/names.ts"
import { derivedReading, lowerWorldView } from "#compiler/physical/derived/definition.ts"
import type { Expr, ObjectName, Select } from "#compiler/sql/ast.ts"
import { bindView, type ReadCatalog, type WorldBinding } from "#compiler/sql/bind.ts"
import { provedSelect, target } from "#compiler/sql/build.ts"
import { nameOf } from "#compiler/sql/constants.ts"

/** A view's column and what it reads: a heading column's own value, or the decoded name beside a closed id's. */
export interface ViewColumn {
	readonly name: string
	readonly value: Expr
}

/**
 * A view's columns over the heading `heading`, each column `c` read as `read(c)` under its view name `columnName(c)`: each
 * closed id followed by its decoded column, `<field>_name`, the handle its code names, read from its roster's names
 * constant under `names`, `(N())[c + 1]::text`, the decoded column's identity named by `named`, the installation's
 * naming door where it creates the view, which records each identity it names. A set has no decoded column.
 */
export const viewColumns = <C extends HeadingColumn>(
	names: Pick<InstallNames, "schema" | "codes">,
	named: <K extends IdentityKind>(of: Identity<K>) => string,
	heading: NonEmptyReadonlyArray<C>,
	columnName: (c: C) => string,
	read: (c: C, position: number) => Expr
): NonEmptyReadonlyArray<ViewColumn> => {
	const columns = mapNonEmpty(heading, (c, position): NonEmptyReadonlyArray<ViewColumn> => {
		const own: ViewColumn = { name: columnName(c), value: read(c, position) }
		const base = baseOf(c.type)
		if (base.carrier !== "code") {
			return [own]
		}
		const field = parseDeclaredName(c.name)
		if (!field.ok) {
			return missing(
				`physical: the closed id field ${JSON.stringify(c.name)}, a name ${nameFaultText(field.error)}`
			)
		}
		const codes =
			names.codes.rosters.get(base.roster.closed) ??
			missing(`physical: the codes of roster ${base.roster.closed}, which the codebook holds`)
		const constant: ObjectName = {
			schema: names.schema,
			name: identifierOf(rosterConstants(codes).names)
		}
		return [
			own,
			{ name: named(identity.decodedColumn(field.value)), value: nameOf(constant, own.value) }
		]
	})
	return extendNonEmpty(columns[0], columns.slice(1).flat())
}

/**
 * A role's world view (see the header): its query entry's name; how the binding reads it (WorldBinding: its name, its
 * definition, its view scope's ordinal, the names its body mints, its columns and its leaky ones); the body the
 * installation creates, bound under its view scope; its heading, whose types its columns are; and the relations its
 * definition reads, which the view is created after.
 */
export interface WorldView {
	readonly entry: string
	readonly binding: WorldBinding
	/** Its body as the lowering states it, before the binding pass, which the isolation facts read
	 * (program/isolation/member-facts.ts roleWorld), each target the view's column of `binding` at its place. */
	readonly definition: Select
	readonly bound: Select
	readonly analysis: WorldAnalysis
}

/** A role of a login with its world views (`roleWorldViews`), as its compile hands them to the installation. */
export interface RoleWorldViews {
	readonly login: string
	readonly role: string
	readonly views: ReadonlyArray<WorldView>
}

/** What a role's world views are derived from (`roleWorldViews`). */
export interface WorldViewsInput {
	readonly names: InstallNames
	readonly evidence: EvidenceCatalog
	readonly checked: CheckedSchema<RoleWorld>
	/** The view each relation of the role is read through, as the installation names it (names.ts NamedRole). */
	readonly views: NamedRole["views"]
	/** The catalog of the installation the views' bodies read, which binds them (physical/access/catalog.ts). */
	readonly catalog: ReadCatalog
}

/** A role's query entries, in the order of their names, each with its checked definition: what its world views are
 * derived from (roleWorldViews) and what their bodies need of the installation is read from (worldViewTypes). */
const worldEntries = (checked: CheckedSchema<RoleWorld>) =>
	checked.entries
		.flatMap((e) => (e.kind === "world" ? [{ entry: e.entry, analysis: e.analysis }] : []))
		.toSorted((a, b) => compareStrings(a.entry.name, b.entry.name))

/**
 * What a role's world views need of the installation that creates them (physical/ddl/domains.ts ServedTypes): the
 * objects of each query entry's definition (dagObjects), as a derived definition's are an installation's own, every
 * structural text refinement and contract it types a value by and every library function it calls, the type of each
 * claim of a context it reads among them, which its body casts the claim to (lower/conservative/claims judgedType).
 * They are read from the definitions roleWorldViews lowers, so the plan a role's compile lowers its views under, which
 * generate plans from its logins' workloads beside them (program/workload/compile.ts planWorkload), names every domain a
 * body casts to, and the installation planned from the same types installs each.
 */
export const worldViewTypes = (checked: CheckedSchema<RoleWorld>): ServedTypes => {
	const held = worldEntries(checked).map(({ analysis }) =>
		dagObjects(analysis.loc, [], analysis.query.dag.roots)
	)
	return {
		...noServedTypes,
		typed: held.flatMap((h) => h.contracts),
		texts: held.flatMap((h) => h.texts),
		library: held.flatMap((h) => h.library)
	}
}

/**
 * The world views of a role (see the header), one per query entry, in the order of the entries' names, the `k`-th's
 * body bound under the view scope `k` (sql/naming.ts ViewScope): each definition lowered as its role's view reads it
 * (physical/derived/definition.ts lowerWorldView), the role's world over the base it is checked against.
 */
export const roleWorldViews = (input: WorldViewsInput): ReadonlyArray<WorldView> => {
	const { names, evidence, checked } = input
	const role = checked.world.role
	return worldEntries(checked).map(({ entry, analysis }, at): WorldView => {
		const viewName = input.views.get(entry.name)
		if (viewName?.kind !== "query") {
			return missing(`physical: the query entry ${role.name}.${entry.name} is named no view`)
		}
		const name: ObjectName = {
			schema: identifierOf(viewName.schema),
			name: identifierOf(viewName.name)
		}
		const label = `${role.name}.${entry.name}`
		const lowered = unwrap(
			lowerWorldView(label, analysis.query, { names, catalog: evidence, role: checked })
		)
		const decodes = analysis.heading.some((c) => baseOf(c.type).carrier === "code")
		const reading = decodes
			? unwrap(derivedReading(lowered, `the decoded view of ${label}`))
			: undefined
		const columns =
			reading === undefined
				? undefined
				: viewColumns(
						names,
						identifierOf,
						analysis.heading,
						(c) => identifierOf(identity.column(c.name)),
						(_, position) => reading.read(position)
					)
		const definition: Select =
			reading === undefined || columns === undefined
				? lowered.query
				: provedSelect(
						"keyed",
						columns.map((c) => target(c.value)),
						[reading.from],
						undefined
					)
		const ordinal = at + 1
		const body = bindView(definition, ordinal, input.catalog)
		const viewColumnNames =
			columns === undefined
				? mapNonEmpty(analysis.heading, (c) => identifierOf(identity.column(c.name)))
				: mapNonEmpty(columns, (c) => c.name)
		return {
			entry: entry.name,
			binding: {
				name,
				prepared: body.prepared,
				ordinal,
				minted: body.minted,
				columns: viewColumnNames,
				leaky: new Set(
					analysis.heading.flatMap((c) =>
						leakyEquality(c.type) ? [identifierOf(identity.column(c.name))] : []
					)
				)
			},
			definition,
			bound: body.bound,
			analysis
		}
	})
}
