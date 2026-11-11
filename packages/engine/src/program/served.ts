import { keyedBy } from "#compiler/analysis/physical/props.ts"
import type { DecoderForm, RowDecoder } from "#compiler/core/decoder.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { isList } from "#compiler/core/record.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { OuterRefs } from "#compiler/ir/dag.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { PageFill } from "#compiler/ir/products.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import type { Footprint } from "#compiler/logical/routes.ts"
import { keySetOf } from "#compiler/lower/conservative/keys.ts"
import type { PageStatementSlot } from "#compiler/lower/conservative/types.ts"
import type { SentStatement } from "#compiler/lower/shapes/index.ts"
import type {
	PageProgram,
	PageRequestProgram,
	PageTemplate
} from "#compiler/lower/shapes/page/compile.ts"
import type { PageVariant } from "#compiler/lower/shapes/page/seek.ts"
import { sentSpec } from "#compiler/lower/template.ts"
import { loginStartupOptions } from "#compiler/physical/ddl/roles.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { pageStatementSlotOf } from "#compiler/runtime/lower/slots.ts"
import { unitColumn } from "#compiler/runtime/lower/tree.ts"
import type {
	ServedFootprint,
	ServedKey,
	ServedPage,
	ServedPageProgram,
	ServedPageRequest,
	ServedRead,
	ServedRoleForm,
	ServedSession,
	ServedVariants
} from "#compiler/served/forms.ts"
import { servedHeading, servedProgram, servedSource } from "#compiler/served/read.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import { emitText } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"

/**
 * A query compiled for a role's rows, served (served/forms.ts ServedRead): its declared parameters, its artifact and
 * delivered spine (served/read.ts), its records' decoder, the key its rows are delivered under (`key`: its own,
 * templateKey, or its page's, pageKey), and its footprint, the workload plan's
 * (program/workload/compile.ts WorkloadFootprints), its tables named as installed (servedFootprint).
 */
export const servedRead = (
	template: QueryTemplate,
	desc: QueryDesc,
	decoder: RowDecoder<unknown>,
	key: ServedKey,
	footprint: ServedFootprint
): ServedRead => ({
	params: template.params,
	source: servedSource(template.run),
	spine: servedSpine(desc),
	decoder: decoder.form,
	key,
	footprint
})

/** The root of a program's DAG reads no enclosing node: it is evaluated once per execution. */
const evaluatedOnce: OuterRefs = new Map()

/**
 * The key a template's rows are delivered under (served/forms.ts ServedKey), read off the optimized program its
 * statement delivers: an ordered result's, the fields of its completed order; a set's, the KeySetProof of its root's
 * rows (lower/conservative/keys.ts keySetOf) over the physical analysis's canonical minimal key among its heading
 * (analysis/physical/props.ts keyedBy), its root evaluated once, or, where that proves none, every head field of every
 * part its rows are delivered by, a heading group's each, in group order, the private column of a relation of no column
 * none of them.
 */
export const templateKey = (template: QueryTemplate): ServedKey => {
	const { query, plan } = template.programs.optimized
	const root = query.dag.roots[0]
	if (root.kind === "OrderedResult") {
		return { kind: "list", fields: root.order.keys.map((k) => k.column) }
	}
	const heading = root.heading.map((c) => c.name)
	const within = keyedBy(plan.analysis.of(root).props, heading)
	const proof = keySetOf(within?.key ?? heading, within, evaluatedOnce, undefined)
	return {
		kind: "set",
		fields:
			proof.kind === "proved"
				? proof.key.columns
				: [
						...new Set(
							template.run.roots.flatMap((tree) =>
								tree.statement.heading.flatMap((c) => (c.name === unitColumn ? [] : [c.name]))
							)
						)
					]
	}
}

/**
 * A read program's footprint as its served read names it (served/forms.ts ServedFootprint): each stored relation's
 * table, by its installed identifier, with each routed field's installed column to its parameter's declared name, and
 * each materialized derived relation's view, by its installed identifier, routed by nothing, all under the
 * installation's names `names`, which the naming door derives.
 */
export const servedFootprint = (footprint: Footprint, names: PhysicalNames): ServedFootprint =>
	Object.fromEntries([
		...[...footprint.tables].map(
			([relation, routes]) =>
				[
					names.relation(relation).name,
					Object.fromEntries(
						[...routes].map(([field, param]) => [names.column(relation, field), param] as const)
					)
				] as const
		),
		...[...footprint.views].map((view) => [names.relation(view).name, {}] as const)
	])

/** The key a page's rows are delivered under: the fields of the completed order it pages by (served/forms.ts ServedPage). */
export const pageKey = (page: ServedPage): ServedKey => ({
	kind: "list",
	fields: page.order.keys.map((k) => k.column)
})

/**
 * A page's program as the runtime runs it: its statement's spec, and its large form's, emitted under the codes
 * `codes`, and its parts.
 */
const servedPageProgram = <F extends PageFill>(
	program: PageProgram<F>,
	codes: Codebook
): ServedPageProgram<F> => {
	const slotOf = pageStatementSlotOf(codes)
	const { statement, parts, roots } = program
	const spec = (form: SentStatement<PageStatementSlot<F>>) => sentSpec(form, parts, roots, slotOf)
	const forms = statement.forms
	return servedProgram({
		statement: {
			params: statement.params,
			forms:
				forms.kind === "one"
					? forms
					: {
							kind: "chosen",
							choices: forms.choices,
							large: { statement: { params: forms.large.params }, spec: spec(forms.large) }
						},
			spec: spec(statement)
		},
		parts,
		roots
	})
}

/**
 * An ordered query's page, served (served/forms.ts ServedPage): its order, comparators and heading, and each window
 * variant's program with its statement's spec emitted now under the installation's codes `codes`.
 */
export const servedPage = (page: PageTemplate, codes: Codebook): ServedPage => {
	const { requests } = page.artifact
	const request = <V extends PageVariant>(
		program: PageRequestProgram<V>
	): ServedPageRequest<V> => ({
		...program,
		program: servedPageProgram(program.program, codes)
	})
	return {
		order: page.order,
		comparators: page.comparators.map((c) => ({
			field: c.field,
			direction: c.direction,
			type: c.type
		})),
		heading: servedHeading(page.heading),
		requests: {
			first: request(requests.first),
			after: request(requests.after),
			last: request(requests.last),
			before: request(requests.before)
		}
	}
}

/** A transaction's BEGIN at `isolation`, read only and read write. */
const beginAt = (isolation: Isolation): ServedSession["begin"][Isolation] => ({
	readOnly: emitText({ kind: "begin", isolation, readOnly: true }, emptyNameMap).text,
	readWrite: emitText({ kind: "begin", isolation, readOnly: false }, emptyNameMap).text
})

/**
 * The texts every session of a login sends that its file carries, emitted now (served/forms.ts ServedSession): the
 * startup options pinning its role's defaults (physical/ddl/roles.ts loginStartupOptions), each transaction's BEGIN at
 * each isolation level, read only or read write, and its COMMIT and ROLLBACK.
 */
export const servedSession: ServedSession = {
	startup: loginStartupOptions,
	begin: { serializable: beginAt("serializable"), readCommitted: beginAt("readCommitted") },
	commit: emitText({ kind: "commit" }, emptyNameMap).text,
	rollback: emitText({ kind: "rollback" }, emptyNameMap).text
}

/** The rosters a decoder form's columns read: a closed id's and a set's. */
const decoderRosters = (form: DecoderForm, out: Set<string>): void => {
	switch (form.kind) {
		case "record":
			for (const [, field] of form.fields) {
				if (field.kind === "column") {
					if (field.column.kind === "code" || field.column.kind === "bits") {
						out.add(field.column.roster)
					}
				} else {
					decoderRosters(field.child, out)
				}
			}
			return
		case "merge":
		case "oneOf":
			decoderRosters(form.first, out)
			decoderRosters(form.second, out)
			return
		case "arm":
			decoderRosters(form.parent, out)
			decoderRosters(form.child, out)
			return
		case "refused":
			return
	}
}

/**
 * Every Roster a served value holds, a type's among them, each container read once however many hold it. The walk is
 * the file writer's own (served/json.ts ServedWriter), which writes each Roster it meets wherever a form holds it as a
 * reference to the file's rosters, and a load revives each from them: so the rosters a load needs are exactly the ones
 * this reaches, whichever form holds a type, and no form added later can hold one the file lacks.
 */
const heldRosters = (value: unknown, out: Set<string>, seen: Set<object>): void => {
	if (typeof value !== "object" || value === null || seen.has(value)) {
		return
	}
	seen.add(value)
	if (value instanceof Roster) {
		out.add(value.closed)
		return
	}
	if (value instanceof Map) {
		for (const [k, v] of value) {
			heldRosters(k, out, seen)
			heldRosters(v, out, seen)
		}
		return
	}
	if (value instanceof Set || isList(value)) {
		for (const v of value) {
			heldRosters(v, out, seen)
		}
		return
	}
	for (const v of Object.values(value)) {
		heldRosters(v, out, seen)
	}
}

/**
 * The rosters a login's served roles read, by declared name: every Roster their forms hold (a closed id's or a set's
 * type), every closed id's and set's column their decoders read, and every roster a classifier names a domain of, one
 * typing a column its role's writes write (program/schema.ts raisableOf): the rosters whose codes the file carries
 * (served/forms.ts ServedFile rosters).
 */
export const servedRosters = (roles: ReadonlyArray<ServedRoleForm>): ReadonlySet<string> => {
	const out = new Set<string>()
	const seen = new Set<object>()
	for (const role of roles) {
		heldRosters(role, out, seen)
		for (const domain of role.refusals.laws.rosterDomains) {
			out.add(domain.roster)
		}
		for (const member of role.members) {
			switch (member.kind) {
				case "change":
					variantRosters(member.variants, out)
					break
				case "refresh":
					break
				case "read":
				case "paged":
				case "key":
					decoderRosters(member.read.decoder, out)
					break
			}
		}
	}
	return out
}

/** The rosters each change of a ChangeSet's variants reads in its reads decoder. */
const variantRosters = (variants: ServedVariants, out: Set<string>): void => {
	if (variants.kind === "change") {
		decoderRosters(variants.change.decoder, out)
		return
	}
	variantRosters(variants.holding, out)
	variantRosters(variants.lacking, out)
}
