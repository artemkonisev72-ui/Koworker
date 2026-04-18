import { env } from '$env/dynamic/private';
import nodemailer, { type Transporter } from 'nodemailer';

type SendVerificationEmailInput = {
	to: string;
	name?: string | null;
	token: string;
	baseUrl?: string;
};

let cachedTransporter: Transporter | null | undefined;

function parseSmtpPort(value: string): number {
	const parsed = Number.parseInt(value || '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 587;
}

function hasSmtpConfig(): boolean {
	return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

function getBaseUrl(baseUrlOverride?: string): string {
	const candidate = (baseUrlOverride || env.APP_BASE_URL || '').trim();
	if (candidate) return candidate;
	return 'http://localhost:5173';
}

function getTransporter(): Transporter | null {
	if (cachedTransporter !== undefined) return cachedTransporter;

	if (!hasSmtpConfig()) {
		cachedTransporter = null;
		return cachedTransporter;
	}

	cachedTransporter = nodemailer.createTransport({
		host: env.SMTP_HOST,
		port: parseSmtpPort(env.SMTP_PORT || ''),
		secure: env.SMTP_SECURE === 'true',
		auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
	});

	return cachedTransporter;
}

function renderVerificationEmail(name: string | null | undefined, verificationUrl: string): { text: string; html: string } {
	const safeName = name?.trim() ? `${name.trim()}, ` : '';
	const text = [
		`Hello ${safeName}please confirm your email address.`,
		'',
		`Verification link: ${verificationUrl}`,
		'',
		'If you did not create this account, ignore this email.'
	].join('\n');

	const html = [
		'<div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">',
		`<p>Hello ${safeName}please confirm your email address.</p>`,
		`<p><a href="${verificationUrl}">Confirm email</a></p>`,
		'<p>If you did not create this account, ignore this email.</p>',
		'</div>'
	].join('');

	return { text, html };
}

export async function sendVerificationEmail({
	to,
	name,
	token,
	baseUrl
}: SendVerificationEmailInput): Promise<{ delivered: boolean; verificationUrl: string }> {
	const url = new URL('/verify-email', getBaseUrl(baseUrl));
	url.searchParams.set('token', token);
	const verificationUrl = url.toString();
	const { text, html } = renderVerificationEmail(name, verificationUrl);
	const transporter = getTransporter();

	if (!transporter) {
		if (process.env.NODE_ENV === 'production') {
			throw new Error('[auth-email] SMTP is not configured in production');
		}
		console.info(`[auth-email] SMTP is not configured. Verification link for ${to}: ${verificationUrl}`);
		return { delivered: false, verificationUrl };
	}

	await transporter.sendMail({
		from: env.SMTP_FROM,
		to,
		subject: 'Confirm your email address',
		text,
		html
	});

	return { delivered: true, verificationUrl };
}
