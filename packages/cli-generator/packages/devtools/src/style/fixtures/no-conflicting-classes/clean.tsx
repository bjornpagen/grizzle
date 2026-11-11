import { cn } from "#style/fixtures/support/cn.ts"

export function ComposedFixture({ active }: Readonly<{ active: boolean }>) {
	return (
		<div className="flex flex-col p-2 px-4 hover:p-4">
			<span className="text-sm leading-6 text-muted-foreground" />
			<span className="ring-3 shadow-sm ring-ring/50" />
			<span className={cn("p-2", active && "p-4")} />
			<span className={cn("flex", active && "flex")} />
			<span className={active ? "p-2" : "p-2 m-2"} />
			<span className="border border-input mx-auto ml-2" />
		</div>
	)
}
