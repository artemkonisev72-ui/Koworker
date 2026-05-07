import { env } from '$env/dynamic/private';
import nodemailer, { type Transporter } from 'nodemailer';

type SendVerificationEmailInput = {
	to: string;
	name?: string | null;
	token: string;
	baseUrl?: string;
};

type SendPasswordResetEmailInput = SendVerificationEmailInput;

let cachedTransporter: Transporter | null | undefined;
const BRAND_NAME = 'Koworker';

type TransactionalEmailInput = {
	preheader: string;
	logoUrl: string;
	greeting: string;
	title: string;
	body: string;
	ctaLabel: string;
	actionUrl: string;
	fallbackLabel?: string | null;
	securityNote: string;
};

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

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function getGreeting(name: string | null | undefined): string {
	return name?.trim() ? `Здравствуйте, ${name.trim()}!` : 'Здравствуйте!';
}

function renderTransactionalEmail({
	preheader,
	logoUrl,
	greeting,
	title,
	body,
	ctaLabel,
	actionUrl,
	fallbackLabel,
	securityNote
}: TransactionalEmailInput): string {
	const preheaderHtml = escapeHtml(preheader);
	const logoUrlHtml = escapeHtml(logoUrl);
	const greetingHtml = escapeHtml(greeting);
	const titleHtml = escapeHtml(title);
	const bodyHtml = escapeHtml(body);
	const ctaLabelHtml = escapeHtml(ctaLabel);
	const actionUrlHtml = escapeHtml(actionUrl);
	const fallbackHtml = fallbackLabel
		? [
				`<p style="margin:0 0 8px;font-size:13px;line-height:1.55;color:#78716c;">${escapeHtml(fallbackLabel)}:</p>`,
				`<p style="margin:0 0 24px;font-size:13px;line-height:1.55;color:#455e4e;word-break:break-all;"><a href="${actionUrlHtml}" target="_blank" rel="noopener noreferrer" style="color:#455e4e;text-decoration:underline;text-underline-offset:2px;">${actionUrlHtml}</a></p>`
			]
		: [];
	const securityNoteHtml = escapeHtml(securityNote);

	return [
		'<!doctype html>',
		'<html lang="ru">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${titleHtml}</title>`,
		'</head>',
		'<body style="margin:0;padding:0;background-color:#f9f8f6;color:#2d2b2a;">',
		`<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${preheaderHtml}</span>`,
		'<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:#f9f8f6;border-collapse:collapse;">',
		'<tr>',
		'<td align="center" style="padding:32px 14px;">',
		'<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;border-collapse:collapse;">',
		'<tr>',
		'<td align="center" style="padding:0 0 18px;">',
		`<img src="${logoUrlHtml}" width="48" height="48" alt="${BRAND_NAME}" style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none;border-radius:14px;margin:0 auto 8px;">`,
		`<div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.2;font-weight:600;color:#2d2b2a;">${BRAND_NAME}</div>`,
		'</td>',
		'</tr>',
		'<tr>',
		'<td style="background-color:#ffffff;border:1px solid #e7e5e4;border-radius:18px;padding:34px 30px;box-shadow:0 18px 48px rgba(83,63,45,0.13);font-family:Inter,' +
			"'Segoe UI',Arial,sans-serif;" +
			'">',
		`<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#4e4844;">${greetingHtml}</p>`,
		`<h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.2;font-weight:500;color:#2d2b2a;letter-spacing:0;">${titleHtml}</h1>`,
		`<p style="margin:0 0 24px;font-size:16px;line-height:1.65;color:#4e4844;">${bodyHtml}</p>`,
		'<table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:0 auto 28px;">',
		'<tr>',
		`<td align="center" bgcolor="#455e4e" style="border-radius:16px;background-color:#455e4e;"><a href="${actionUrlHtml}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:16px 34px;font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.2;font-weight:800;color:#f9f8f6;text-decoration:none;border-radius:16px;">${ctaLabelHtml}</a></td>`,
		'</tr>',
		'</table>',
		...fallbackHtml,
		`<p style="margin:0;padding-top:18px;border-top:1px solid #e7e5e4;font-size:13px;line-height:1.55;color:#78716c;">${securityNoteHtml}</p>`,
		'</td>',
		'</tr>',
		'<tr>',
		`<td align="center" style="padding:18px 10px 0;font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.5;color:#78716c;">${BRAND_NAME} AI</td>`,
		'</tr>',
		'</table>',
		'</td>',
		'</tr>',
		'</table>',
		'</body>',
		'</html>'
	].join('');
}

function renderVerificationEmail(
	name: string | null | undefined,
	verificationUrl: string,
	logoUrl: string
): { text: string; html: string } {
	const greeting = getGreeting(name);
	const text = [
		greeting,
		'',
		'Подтвердите адрес электронной почты, чтобы завершить активацию аккаунта.',
		'',
		`Ссылка для подтверждения: ${verificationUrl}`,
		'',
		'Если вы не создавали этот аккаунт, просто проигнорируйте это письмо.'
	].join('\n');

	const html = renderTransactionalEmail({
		preheader: 'Завершите активацию аккаунта Koworker.',
		logoUrl,
		greeting,
		title: 'Подтвердите электронную почту',
		body: 'Подтвердите адрес электронной почты, чтобы завершить активацию аккаунта.',
		ctaLabel: 'Подтвердить почту',
		actionUrl: verificationUrl,
		fallbackLabel: 'Ссылка для подтверждения',
		securityNote: 'Если вы не создавали этот аккаунт, просто проигнорируйте это письмо.'
	});

	return { text, html };
}

function renderPasswordResetEmail(
	name: string | null | undefined,
	resetUrl: string,
	logoUrl: string
): { text: string; html: string } {
	const greeting = getGreeting(name);
	const text = [
		greeting,
		'',
		'Вы запросили смену пароля для аккаунта Koworker.',
		'',
		'Если вы не запрашивали смену пароля, просто проигнорируйте это письмо.'
	].join('\n');

	const html = renderTransactionalEmail({
		preheader: 'Смените пароль Koworker.',
		logoUrl,
		greeting,
		title: 'Смена пароля',
		body: 'Вы запросили смену пароля для аккаунта Koworker.',
		ctaLabel: 'Сменить пароль',
		actionUrl: resetUrl,
		securityNote: 'Если вы не запрашивали смену пароля, просто проигнорируйте это письмо.'
	});

	return { text, html };
}

export async function sendVerificationEmail({
	to,
	name,
	token,
	baseUrl
}: SendVerificationEmailInput): Promise<{ delivered: boolean; verificationUrl: string }> {
	const resolvedBaseUrl = getBaseUrl(baseUrl);
	const url = new URL('/verify-email', resolvedBaseUrl);
	url.searchParams.set('token', token);
	const verificationUrl = url.toString();
	const logoUrl = new URL('/pwa-192x192.png', resolvedBaseUrl).toString();
	const { text, html } = renderVerificationEmail(name, verificationUrl, logoUrl);
	const transporter = getTransporter();

	if (!transporter) {
		if (process.env.NODE_ENV === 'production') {
			throw new Error('[auth-email] SMTP is not configured in production');
		}
		console.info(
			`[auth-email] SMTP is not configured. Verification link for ${to}: ${verificationUrl}`
		);
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

export async function sendPasswordResetEmail({
	to,
	name,
	token,
	baseUrl
}: SendPasswordResetEmailInput): Promise<{ delivered: boolean; resetUrl: string }> {
	const resolvedBaseUrl = getBaseUrl(baseUrl);
	const url = new URL('/reset-password', resolvedBaseUrl);
	url.searchParams.set('token', token);
	const resetUrl = url.toString();
	const logoUrl = new URL('/pwa-192x192.png', resolvedBaseUrl).toString();
	const { text, html } = renderPasswordResetEmail(name, resetUrl, logoUrl);
	const transporter = getTransporter();

	if (!transporter) {
		if (process.env.NODE_ENV === 'production') {
			throw new Error('[auth-email] SMTP is not configured in production');
		}
		console.info(`[auth-email] SMTP is not configured. Password reset link for ${to}: ${resetUrl}`);
		return { delivered: false, resetUrl };
	}

	await transporter.sendMail({
		from: env.SMTP_FROM,
		to,
		subject: 'Смена пароля Koworker',
		text,
		html
	});

	return { delivered: true, resetUrl };
}
