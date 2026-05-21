<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import StepShell from '$lib/components/wizard/StepShell.svelte';
	import { STEPS } from '$lib/wizard';
	import type { QuoteType } from '$lib/schemas/quote';
	import Step1Client from './_steps/Step1Client.svelte';
	import Step2Plan from './_steps/Step2Plan.svelte';
	import Step3Elevation from './_steps/Step3Elevation.svelte';
	import Step3ResiHeights from './_steps/Step3ResiHeights.svelte';
	import Step4Allowances from './_steps/Step4Allowances.svelte';
	import Step5Pricing from './_steps/Step5Pricing.svelte';
	import Step6Review from './_steps/Step6Review.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/** Type toggle in the header. Fires a one-off PUT to the canonical API
	 *  with the changed quoteType, then invalidates so all step components
	 *  re-mount with fresh data. */
	async function handleTypeChange(next: QuoteType) {
		const cur = (await fetch(`/api/quotes/${data.quoteId}.json`).then((r) => r.json())) as {
			data: typeof data.data;
			dataHash: string;
			versionNumber: number;
		};
		if (cur.data.quoteType === next) return;
		const updated = { ...cur.data, quoteType: next };
		const res = await fetch(`/api/quotes/${data.quoteId}.json`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				'If-Match': `"${cur.dataHash}"`,
				'Idempotency-Key': crypto.randomUUID()
			},
			body: JSON.stringify({ data: updated })
		});
		if (res.ok) await invalidateAll();
	}

	const stepsForType = $derived(() =>
		STEPS.map((s) => {
			if (s.n === 3 && data.data.quoteType === 'residential') {
				return { ...s, label: 'Heights' };
			}
			if (s.n === 4) return { ...s, label: 'Scope & allowances' };
			if (s.n === 5) return { ...s, label: 'Pricing' };
			if (s.n === 6) return { ...s, label: 'Review & export' };
			return s;
		})
	);
</script>

<svelte:head>
	<title>Quote EW-{data.quoteNumber} — Step {data.step} — Elite Walls</title>
</svelte:head>

<StepShell
	quoteId={data.quoteId}
	current={data.step}
	steps={stepsForType()}
	quoteNumber={data.quoteNumber}
	quoteType={data.data.quoteType}
	onTypeChange={handleTypeChange}
	wide={data.step === 2 || (data.step === 3 && data.data.quoteType === 'civil')}
>
	{#if data.step === 1}
		<Step1Client
			quoteId={data.quoteId}
			data={data.data}
			dataHash={data.dataHash}
			versionNumber={data.versionNumber}
			mapboxToken={data.mapboxToken}
		/>
	{:else if data.step === 2}
		<Step2Plan
			quoteId={data.quoteId}
			data={data.data}
			dataHash={data.dataHash}
			versionNumber={data.versionNumber}
			mapboxToken={data.mapboxToken}
		/>
	{:else if data.step === 3}
		{#if data.data.quoteType === 'civil'}
			<Step3Elevation
				quoteId={data.quoteId}
				data={data.data}
				dataHash={data.dataHash}
				versionNumber={data.versionNumber}
			/>
		{:else}
			<Step3ResiHeights
				quoteId={data.quoteId}
				data={data.data}
				dataHash={data.dataHash}
				versionNumber={data.versionNumber}
			/>
		{/if}
	{:else if data.step === 4}
		<Step4Allowances
			quoteId={data.quoteId}
			data={data.data}
			dataHash={data.dataHash}
			versionNumber={data.versionNumber}
		/>
	{:else if data.step === 5}
		<Step5Pricing
			quoteId={data.quoteId}
			data={data.data}
			dataHash={data.dataHash}
			versionNumber={data.versionNumber}
		/>
	{:else if data.step === 6}
		<Step6Review
			quoteId={data.quoteId}
			quoteNumber={data.quoteNumber}
			data={data.data}
		/>
	{/if}
</StepShell>
