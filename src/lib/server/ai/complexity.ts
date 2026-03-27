/**
 * complexity.ts
 * Эвристическая оценка сложности задачи без вызова LLM.
 * Работает мгновенно — оценивает ключевые слова и структуру запроса.
 */

export type ComplexityTier = 1 | 2 | 3 | 4;

export interface ComplexityScore {
	score: number; // 1-10
	tier: ComplexityTier;
	reason: string;
}

// Ключевые слова, повышающие оценку сложности
const HIGH_COMPLEXITY_PATTERNS: Array<[RegExp, number, string]> = [
	[/диффер[её]нциальн|differential equation/i, 3, 'дифференциальное уравнение'],
	[/нелине[йь]н|nonlinear/i, 3, 'нелинейная система'],
	[/численн[ыйое]|численные методы|runge.kutta|euler method/i, 3, 'численные методы'],
	[/оптимизац|optimize|extremum|минимиз|максимиз/i, 2, 'задача оптимизации'],
	[/матриц|eigenvalu|determinant|определитель/i, 2, 'матричные вычисления'],
	[/ряд фурье|fourier series|преобразование лапласа|laplace/i, 2, 'преобразование рядов'],
	[/двойн[ойое] интеграл|тройн[ойое] интеграл|поверхностн/i, 2, 'кратный интеграл'],
	[/краев[ыайое] задач|граничн[ыайое] услов/i, 2, 'краевая задача'],
	[/механик|сопромат|термех|термодинам/i, 1, 'инженерная область'],
	[/интеграл|integral|производн|derivat/i, 1, 'исчисление'],
	[/предел[ы]|limit|ряд[ы]|series|сходимост/i, 1, 'математический анализ'],
];

// Ключевые слова, понижающие оценку (простые задачи)
const LOW_COMPLEXITY_PATTERNS: Array<[RegExp, number]> = [
	[/прост[ыойая]|simple|базов|basic/i, -2],
	[/^(найди|вычисли|посчитай|calculate)\s+\d/i, -1],
];

export function assessComplexity(message: string): ComplexityScore {
	let score = 3; // базовая оценка
	const reasons: string[] = [];

	// Длина запроса (+1 за каждые 200 символов сверх 300)
	const lengthBonus = Math.floor(Math.max(0, message.length - 300) / 200);
	if (lengthBonus > 0) {
		score += Math.min(lengthBonus, 2);
		reasons.push(`длинный запрос (${message.length} симв.)`);
	}

	// Количество подзадач (несколько вопросов или пунктов)
	const questionCount = (message.match(/[?？]\s|^\d+[.)]/gm) ?? []).length;
	if (questionCount >= 3) {
		score += 2;
		reasons.push(`${questionCount} подзадач`);
	}

	// Паттерны сложности
	for (const [pattern, weight, label] of HIGH_COMPLEXITY_PATTERNS) {
		if (pattern.test(message)) {
			score += weight;
			reasons.push(label);
			break; // считаем только самое тяжёлое совпадение
		}
	}

	// Паттерны простоты
	for (const [pattern, weight] of LOW_COMPLEXITY_PATTERNS) {
		if (pattern.test(message)) {
			score += weight;
		}
	}

	// Ограничиваем диапазон
	score = Math.max(1, Math.min(10, score));

	// Определяем tier
	let tier: ComplexityTier;
	if (score <= 2) tier = 1;
	else if (score <= 5) tier = 2;
	else if (score <= 7) tier = 3;
	else tier = 4;

	const reason = reasons.length > 0 ? reasons.join(', ') : 'стандартная задача';
	return { score, tier, reason };
}
