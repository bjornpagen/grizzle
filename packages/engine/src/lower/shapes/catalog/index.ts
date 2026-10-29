export {
	CatalogContext,
	type CatalogOptions,
	type ParentPolicy
} from "#compiler/lower/shapes/catalog/context.ts"
export { CatalogEditor } from "#compiler/lower/shapes/catalog/edit.ts"
export { NoMatch } from "#compiler/lower/shapes/catalog/exprs.ts"
export { catalogDispatch } from "#compiler/lower/shapes/catalog/native.ts"
export { tryBoundNeighbor } from "#compiler/lower/shapes/catalog/neighbor.ts"
export {
	type CatalogResult,
	catalogPass,
	rewriteCatalog
} from "#compiler/lower/shapes/catalog/rewrite.ts"
