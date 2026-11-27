import { installDigestCase } from "#test/unit/physical/digest-seeks.fixtures.ts"
const r = installDigestCase({ form: "a joined text", digest: false, keyed: false } as any)
if (!r.ok) { console.log("refused", r.error.reason._tag, r.error.message.slice(0, 500)); process.exit(0) }
console.log(JSON.stringify(r.value.programAccess, null, 1))
console.log(r.value.indexes.map((i: any) => i.relation + " " + JSON.stringify(i.index).slice(0, 200)).join("\n"))
