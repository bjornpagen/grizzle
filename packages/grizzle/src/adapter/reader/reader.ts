import type { PageRuntime } from "#adapter/page/template.ts"
import type { ParamCodecs } from "#adapter/reader/relations.ts"
import type { ReadProgram } from "#adapter/reader/run.ts"
import type { Row, RowDecoder } from "#compiler/plan/common.ts"
import type { CompiledTemplate } from "#compiler/plan/read.ts"

/**
 * The read forms a login's workload compiles to, once per role, ahead of `grizzle generate` serving them
 * (served/project.ts): a query's template, its program, its parameters' codecs and its decoder bound, and a paged
 * member's page template beside them. A served Db runs none of them: it runs the served file they were projected into
 * (served/load.ts).
 *
 * A compiled read: its template, the program its rows are delivered through, and its parameters' codecs.
 */
export interface ReadArtifacts {
	readonly compiled: CompiledTemplate
	readonly program: ReadProgram
	readonly codecs: ParamCodecs
}

/** A compiled read and its decoder bound to the program's layouts: each delivered Row read to a record of type A. */
export interface Bound<A> {
	readonly compiled: ReadArtifacts
	readonly read: (row: Row) => A
}

/**
 * A query compiled once for a role for its rows, ahead of `grizzle generate` serving it: its query value, its decoder,
 * and its compiled read with the decoder bound. The layer compiles one for each query, ordered query and key of the
 * login's workloads that does not page, for every role it runs on.
 */
export interface RowsForm<A> {
	readonly query: unknown
	readonly decoder: () => RowDecoder<A>
	readonly bound: Bound<A>
}

/**
 * An ordered query's page compiled once for a role: the query template compiled for a page, its page runtime template
 * and its parameters' codecs.
 */
export interface CompiledPage {
	readonly compiled: CompiledTemplate
	readonly runtime: PageRuntime
	readonly codecs: ParamCodecs
}

/** A paged member's ordered query compiled once for a role: its rows form and its page template. */
export interface ReadForm<A> extends RowsForm<A> {
	readonly page: CompiledPage
}
