/**
 * The runtime plan: every engine name a served login's layer and its Dbs run by, each re-exported from the one module
 * that holds it. No module it re-exports loads the compiler (schema builders, law model, query or write compilers), so
 * the runtime entry (@bjornpagen/grizzle/runtime) loads none; .fallowrc.json's runtime zone holds the facade and every
 * module it reaches to that, and refuses any other value import.
 */
export { noOpaque, readsAsData } from "#compiler/core/host.ts"
