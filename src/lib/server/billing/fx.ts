async function getDb() {
	const { prisma } = await import('$lib/server/db.js');
	return prisma as any;
}

export const USD_RUB_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const CBR_DAILY_XML_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';

function extractUsdRubFromCbrXml(xml: string): number | null {
	const usdBlock = xml.match(/<Valute[^>]*ID="R01235"[\s\S]*?<\/Valute>/);
	if (!usdBlock) return null;
	const nominalText = usdBlock[0].match(/<Nominal>([^<]+)<\/Nominal>/)?.[1];
	const valueText = usdBlock[0].match(/<Value>([^<]+)<\/Value>/)?.[1];
	const nominal = Number(nominalText?.replace(',', '.'));
	const value = Number(valueText?.replace(',', '.'));
	if (!Number.isFinite(nominal) || nominal <= 0 || !Number.isFinite(value) || value <= 0)
		return null;
	return value / nominal;
}

export async function refreshUsdRubRate(): Promise<{ rate: number; observedAt: Date }> {
	const response = await fetch(CBR_DAILY_XML_URL);
	if (!response.ok) throw new Error(`CBR FX request failed (${response.status})`);
	const xml = await response.text();
	const rate = extractUsdRubFromCbrXml(xml);
	if (!rate) throw new Error('CBR FX response does not contain USD/RUB');
	const db = await getDb();
	const observedAt = new Date();
	await db.fxRateSnapshot.create({
		data: {
			baseCurrency: 'USD',
			quoteCurrency: 'RUB',
			rate,
			source: 'cbr.ru XML_daily.asp',
			observedAt,
			rawPayload: { xml }
		}
	});
	return { rate, observedAt };
}

export async function getLatestUsdRubRate(): Promise<{ rate: number; observedAt: Date } | null> {
	const db = await getDb();
	const snapshot = await db.fxRateSnapshot.findFirst({
		where: { baseCurrency: 'USD', quoteCurrency: 'RUB' },
		orderBy: { observedAt: 'desc' }
	});
	if (!snapshot) return null;
	return { rate: Number(snapshot.rate), observedAt: snapshot.observedAt };
}

export async function refreshUsdRubRateIfStale(
	maxAgeMs = USD_RUB_REFRESH_INTERVAL_MS,
	now = new Date()
): Promise<{ rate: number; observedAt: Date; refreshed: boolean }> {
	const latest = await getLatestUsdRubRate();
	if (latest && now.getTime() - latest.observedAt.getTime() < maxAgeMs) {
		return { ...latest, refreshed: false };
	}
	const refreshed = await refreshUsdRubRate();
	return { ...refreshed, refreshed: true };
}
