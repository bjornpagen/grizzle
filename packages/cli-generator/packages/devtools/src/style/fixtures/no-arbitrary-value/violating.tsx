export function ArbitraryValueFixture() {
	return (
		<div
			className="bg-[red]" // violation
		>
			<span
				className="text-[13px]" // violation
			/>
			<span
				className="z-[999]" // violation
			/>
			<span
				className="border-[3px]" // violation
			/>
			<span
				className="[padding:37px]" // violation
			/>
			<span
				className="[padding:var(--spacing)]" // violation
			/>
			<span
				className="bg-[#fff]" // violation
			/>
			<span
				className="rounded-[min(var(--radius-md),10px)]" // violation
			/>
			<span
				className="pb-(--fixture-gap)" // violation
			/>
			<span
				className="bg-[var(--color-blue-500)]" // violation
			/>
			<span
				className="bg-primary/[0.5]" // violation
			/>
			<span
				className="[--fixture-gap:--spacing(4)]" // violation
			/>
			<span
				className="hover:shadow-[0_4px_12px_rgba(0,0,0,0.1)]" // violation
			/>
			<span
				className="min-[800px]:p-2" // violation
			/>
			<span
				className="supports-[display:grid]:grid" // violation
			/>
			<span
				className="data-[size=var(--fixture)]:p-2" // violation
			/>
			<span className="data-[size=sm]:p-2 [&_svg]:size-4 bg-primary/80" />
		</div>
	)
}
