import { Resend } from 'resend';

export async function sendMagicLink(opts: {
	to: string;
	url: string;
	apiKey: string;
	from: string;
}): Promise<void> {
	const resend = new Resend(opts.apiKey);
	const { error } = await resend.emails.send({
		from: opts.from,
		to: opts.to,
		subject: 'Your Elite Walls sign-in link',
		text: `Click to sign in: ${opts.url}\n\nThis link expires in 10 minutes. If you did not request it you can ignore this email.`,
		html: `
			<p>Click to sign in to Elite Walls Quoting:</p>
			<p><a href="${opts.url}">${opts.url}</a></p>
			<p style="color:#666">This link expires in 10 minutes. If you did not request it you can ignore this email.</p>
		`
	});
	if (error) {
		throw new Error(`Resend send failed: ${error.message ?? 'unknown'}`);
	}
}
