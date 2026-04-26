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
	const greeting = name?.trim() ? `Здравствуйте, ${name.trim()}!` : 'Здравствуйте!';
	const text = [
		greeting,
		'',
		'Подтвердите адрес электронной почты, чтобы завершить активацию аккаунта.',
		'',
		`Ссылка для подтверждения: ${verificationUrl}`,
		'',
		'Если вы не создавали этот аккаунт, просто проигнорируйте это письмо.'
	].join('\n');

	const html = [
		'<div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111;">',
		`<p>${greeting}</p>`,
		'<p>Подтвердите адрес электронной почты, чтобы завершить активацию аккаунта.</p>',
		`<p><a href="${verificationUrl}">Подтвердить почту</a></p>`,
		'<p>Если вы не создавали этот аккаунт, просто проигнорируйте это письмо.</p>',
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
		subject: 'Подтвердите адрес электронной почты',
		text,
		html
	});

	return { delivered: true, verificationUrl };
}
