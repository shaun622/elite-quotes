export const STEPS = [
	{ n: 1, label: 'Client + Site' },
	{ n: 2, label: 'Plan view' },
	{ n: 3, label: 'Elevation' },
	{ n: 4, label: 'Materials' },
	{ n: 5, label: 'Pricing' },
	{ n: 6, label: 'Review & export' }
] as const;

export type StepNumber = (typeof STEPS)[number]['n'];

export function isValidStep(n: number): n is StepNumber {
	return Number.isInteger(n) && n >= 1 && n <= STEPS.length;
}
