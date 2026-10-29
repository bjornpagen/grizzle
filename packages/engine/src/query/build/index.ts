/**
 * The query builder runtime.
 *
 * query(S), v, the rule builder and the query values, all recording QueryDesc (ir/desc.ts). Builders are pure and
 * synchronous and never touch a database; a malformed argument the TypeScript signatures already forbid
 * throws CompileError MalformedDescription from a JavaScript caller, and every semantic diagnostic is the checker's.
 * The public barrel public/query.ts exports them under their precise signatures (types/query).
 *
 * - query.ts: query(S), QueryBuilder.rule and recursive, the Query and Ordered values (rule, attach, named, bind,
 *   orderBy, take, approximateNearest), v, and the rebuild of a query value from its Description;
 * - rule.ts: the rule builder (match, where, find, interior, param) and Finished.attach;
 * - terms.ts: comparisons, inSet, and, or, allen, pointIn, the producers and the aggregates;
 * - attach.ts: attachments and their parent variables; state.ts: sources and the builder state of query values;
 * - heading.ts: headings as the builder knows them; scope.ts and walk.ts: hygiene.
 */
export { arm } from "#compiler/query/build/attach.ts"
export {
	isOrderedValue,
	isQueryValue,
	type OrderedValue,
	type QueryValue,
	queryFromDesc,
	queryOver,
	queryValueDesc,
	varsOver
} from "#compiler/query/build/query.ts"
