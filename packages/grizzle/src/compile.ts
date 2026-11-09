/**
 * @bjornpagen/grizzle/compile: grizzle's one compile of a login's served workload, in process, for an application's
 * tests: compileServed compiles a login, with its own workloads or others in their place, into the served file
 * `grizzle generate` would commit for them, which served(...) and DbLayer.make serve; explainMember plans a served
 * member's statements on a Db. A running application never loads it: it loads the schema, the law model and the
 * compiler.
 */
export {
	compileServed,
	explainMember,
	type MemberCall,
	type ServedRefusal,
	type WorkloadPlace
} from "#adapter/public/compile.ts"
