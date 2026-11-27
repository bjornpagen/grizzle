import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import type { DecoderForm, RowDecoder } from "#compiler/core/decoder.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { isList } from "#compiler/core/record.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { PageFill } from "#compiler/ir/products.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import type { Footprint } from "#compiler/logical/routes.ts"
import type {
	PageProgram,
	PageRequestProgram,
	PageTemplate
} from "#compiler/lower/shapes/page/compile.ts"
import type { PageVariant } from "#compiler/lower/shapes/page/seek.ts"
import { sentSpec } from "#compiler/lower/template.ts"
import { loginStartupOptions, ownerStartupOptions } from "#compiler/physical/ddl/roles.ts"
import type { IndexResolver } from "#compiler/physical/indexes/ref.ts"
import type { QueryTemplate } from "#compiler/program/compile.ts"
import { pageStatementSlotOf } from "#compiler/runtime/lower/slots.ts"
import type {
	ServedFootprint,
	ServedKey,
	ServedPage,
	ServedPageProgram,
	ServedPageRequest,
	ServedRead,
	ServedReadLive,
	ServedRoleForm,
	ServedSession,
	ServedVariants
} from "#compiler/served/forms.ts"
import { servedHeading, servedProgram, servedSource } from "#compiler/served/read.ts"
import { servedSpine } from "#compiler/served/spine.ts"
import { type Advice, transactionAdvice } from "#compiler/sql/advice.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"
import * as C from "#compiler/sql/catalog.ts"
import { emitCatalog, costChosen, emitText } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"

/**
 * A query compiled for a role's rows, served as one call reads it (served/forms.ts ServedRead): the declared parameters
 * a call supplies (QueryTemplate params), its artifact and delivered spine
 * (served/read.ts), its records' decoder, the key its rows are delivered under (`key`: its own, templateKey, or its
 * page's, pageKey), and how it is called (`live`): answered, or what wakes its watch, from its footprint, the workload
 * plan's (program/workload/compile.ts WorkloadFootprints), its tables named as installed (servedReadLive).
 */
export const servedRead = (
	template: QueryTemplate,
	desc: QueryDesc,
	decoder: RowDecoder<unknown>,
	key: ServedKey,
	live: ServedReadLive,
	advice: Advice
): ServedRead => ({
	params: template.params,
	source: servedSource(template.run),
	spine: servedSpine(desc),
	decoder: decoder.form,
	key,
	live,
	advice
})

/**
 * What a read of `template` is planned under (served/forms.ts ServedRead `advice`): its statement's plan, each read
 * resolved by the installation that serves it (`resolve`).
 */
export const readAdvice = (template: QueryTemplate, resolve: IndexResolver): Advice =>
	transactionAdvice([template.run.statement.spec.plan], resolve)

/**
 * What a page of `page` is planned under (served/forms.ts ServedPage `advice`): every window variant's statement's
 * plan, one scope's, each read resolved by the installation that serves it (`resolve`).
 */
export const pageAdvice = (page: PageTemplate, resolve: IndexResolver): Advice => {
	const { requests } = page.artifact
	return transactionAdvice(
		[requests.first, requests.after, requests.last, requests.before, requests.at].map(
			(r) => r.program.statement.sql.plan
		),
		resolve
	)
}

/**
 * The key a template's rows are delivered under (served/forms.ts ServedKey): the fields of the completed orders of the
 * ordered result its optimized program's root is, which every served read's is (check/checker.ts rootOrder), each
 * once, the first heading group's in its order and each later group's own after them. A group's order is a key of its
 * rows, and rows of two groups differ on the run every group's order begins with (ir/rel.ts GroupOrders), so no two
 * rows share a key, a field a group lacks read as none (live/key.ts keyOf).
 */
export const templateKey = (template: QueryTemplate): ServedKey => {
	const root = template.programs.optimized.query.dag.roots[0]
	if (root.kind !== "OrderedResult") {
		defect("a served read's root is its ordered result (check/checker.ts rootOrder)")
	}
	return { fields: [...new Set(root.orders.flatMap((o) => o.keys.map((k) => k.column)))] }
}

/**
 * What wakes a read program's watch as its served read holds it (served/forms.ts ServedReadLive): constant where its
 * footprint holds no table, a read of closed relations alone; otherwise routed by its footprint (servedFootprint).
 */
export const servedReadLive = (footprint: Footprint, names: PhysicalNames): ServedReadLive =>
	footprint.tables.size === 0
		? { kind: "constant" }
		: { kind: "routed", footprint: servedFootprint(footprint, names) }

/**
 * A read program's footprint as its served read names it (served/forms.ts ServedFootprint): each stored relation's
 * table, an authored or a stored derived relation's, by its installed identifier, with each routed field's installed
 * column to its parameter's declared name, under the installation's names `names`, which the naming door derives.
 */
const servedFootprint = (footprint: Footprint, names: PhysicalNames): ServedFootprint =>
	Object.fromEntries(
		[...footprint.tables].map(
			([relation, routes]) =>
				[
					names.relation(relation).name,
					Object.fromEntries(
						[...routes].map(([field, param]) => [names.column(relation, field), param] as const)
					)
				] as const
		)
	)

/** The key a page's rows are delivered under: the fields of the completed order it pages by (served/forms.ts ServedPage). */
export const pageKey = (page: ServedPage): ServedKey => ({
	fields: page.order.keys.map((k) => k.column)
})

/** A page's program as the runtime runs it: its statement's spec, emitted under the codes `codes`, and its parts. */
const servedPageProgram = <F extends PageFill>(
	program: PageProgram<F>,
	codes: Codebook
): ServedPageProgram<F> => {
	const { statement, parts, roots } = program
	return servedProgram({
		statement: {
			params: statement.params,
			spec: sentSpec(statement, parts, roots, pageStatementSlotOf(codes))
		},
		parts,
		roots
	})
}

/**
 * An ordered query's page, served (served/forms.ts ServedPage): its order, comparators and heading, and each window
 * variant's program with its statement's spec emitted now under the installation's codes `codes`.
 */
export const servedPage = (page: PageTemplate, codes: Codebook, advice: Advice): ServedPage => {
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
			before: request(requests.before),
			at: request(requests.at)
		},
		advice
	}
}

/** A write's BEGIN at `isolation`. */
const beginWrite = (isolation: Isolation): EmittedText =>
	emitText({ kind: "beginWrite", isolation }, emptyNameMap, costChosen).text

const pgSettings = C.from("pg_settings", "s")

/** The setting `name` as pg_settings reports it, in its unit, as text: a scalar read of its one row. */
const settingText = (name: string): C.CatalogExpr =>
	C.asText(
		C.scalar(
			C.query(
				[pgSettings.col("setting")],
				[pgSettings.item],
				C.eq(pgSettings.col("name"), C.text(name))
			)
		)
	)

/**
 * The read of a session's reap window (served/forms.ts ServedSession reapWindow): one row, tcp_keepalives_idle,
 * tcp_keepalives_interval, tcp_keepalives_count and idle_session_timeout, each as pg_settings reports it over the
 * session's own connection. Over TCP, every connection a login's session makes, pg_settings reports each keepalive
 * setting at its effective value, the operating system's where PostgreSQL's is 0, by its show hook (REL_19_0
 * src/backend/libpq/pqcomm.c pq_getkeepalivesidle, pq_getkeepalivesinterval, pq_getkeepalivescount), in seconds, and
 * idle_session_timeout in milliseconds, 0 for none.
 */
const reapWindowRead: EmittedText = emitCatalog(
	C.query(
		[
			settingText("tcp_keepalives_idle"),
			settingText("tcp_keepalives_interval"),
			settingText("tcp_keepalives_count"),
			settingText("idle_session_timeout")
		],
		[],
		undefined
	)
)

/**
 * The texts every session of a login sends that its file carries, emitted now (served/forms.ts ServedSession): the
 * startup options pinning its role's defaults (physical/ddl/roles.ts loginStartupOptions), an owner's session's
 * (ownerStartupOptions), a read's BEGIN, a write's at each isolation level, its COMMIT and ROLLBACK, and the read of its
 * reap window (reapWindowRead).
 */
export const servedSession: ServedSession = {
	startup: loginStartupOptions,
	ownerStartup: ownerStartupOptions,
	begin: {
		read: emitText({ kind: "beginRead" }, emptyNameMap, costChosen).text,
		write: { serializable: beginWrite("serializable"), readCommitted: beginWrite("readCommitted") }
	},
	commit: emitText({ kind: "commit" }, emptyNameMap, costChosen).text,
	rollback: emitText({ kind: "rollback" }, emptyNameMap, costChosen).text,
	reapWindow: reapWindowRead
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
