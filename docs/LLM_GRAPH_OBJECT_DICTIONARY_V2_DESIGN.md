# LLM Graph Object Dictionary v2

## 1. Метаданные
- Название: `LLM Graph Object Dictionary v2`
- Проект: `Coworker`
- Статус: `Proposed`
- Дата: `2026-04-11`
- Назначение: единый словарь графических объектов и план крупных изменений в генерации/валидации/рендеринге схем и графиков.

## 2. Зачем это нужно
Текущая проблема: LLM возвращает вариативные структуры полей и геометрии, из-за чего:
- схема нестабильно валидируется;
- элементы могут "слипаться" в `(0,0)`;
- много нормализационной логики в разных местах;
- сложно расширять библиотеку визуальных примитивов.

Цель v2:
- стандартизировать контракт между LLM и приложением;
- ускорить генерацию за счет фиксированного словаря и двухшаговой сборки сцены;
- упростить сопровождение: один каталог типов, одна валидация, единый рендер-реестр.

## 3. Scope
### 3.1 В scope
- Новый словарь объектов (канонический DSL `2.0`).
- Полные правила валидации и нормализации.
- План изменений backend/frontend/LLM-пайплайна.
- План миграции и обратной совместимости.

### 3.2 Не в scope
- CAD-редактор произвольной геометрии.
- Ручной "рисовальный" UI.
- Полная замена существующего solve-пайплайна.

## 4. Дизайн-принципы
1. Детерминированность: одинаковый ввод -> одинаковый каркас схемы.
2. Якорная модель: все объекты привязаны к `node`.
3. Канонические поля: для каждого `type` фиксированный набор ключей.
4. Отказ от "тихой магии": нормализация допустима, но без изменения физического смысла.
5. Безопасность: строгая серверная валидация до сохранения и рендера.
6. Совместимость: чтение `v1` остается, `v2` включается по флагу.

## 5. Канонический контракт DSL v2

```json
{
  "version": "2.0",
  "meta": {
    "taskDomain": "mechanics",
    "catalogVersion": "2026-04-11",
    "language": "ru"
  },
  "coordinateSystem": {
    "xUnit": "m",
    "yUnit": "m",
    "origin": { "x": 0, "y": 0 },
    "axisOrientation": "right-handed"
  },
  "nodes": [],
  "objects": [],
  "results": [],
  "annotations": [],
  "assumptions": [],
  "ambiguities": []
}
```

### 5.1 Корневые поля
- `version` (required): всегда `"2.0"`.
- `meta` (required): служебные метаданные генерации.
- `coordinateSystem` (optional): единицы/origin/ориентация осей.
- `nodes` (required): массив опорных точек.
- `objects` (required): массив физических/нагрузочных/кинематических объектов.
- `results` (optional): массив результатных объектов (`epure`, `trajectory` при пост-обработке).
- `annotations` (optional): подписи и комментарии.
- `assumptions` (optional): принятые допущения.
- `ambiguities` (optional): неоднозначности, которые нужно подтвердить пользователю.

## 6. Сущность `node` (скелетная геометрия)

`node` выносится в отдельный массив `nodes`, а не в `objects`.

```json
{
  "id": "N1",
  "x": 0,
  "y": 0,
  "label": "A",
  "visible": false,
  "meta": {}
}
```

### 6.1 Обязательные поля
- `id: string` (уникальный, непустой)
- `x: number` (конечный)
- `y: number` (конечный)

### 6.2 Необязательные
- `label: string`
- `visible: boolean` (для debug-режима)
- `meta: object`

### 6.3 Правила
- `abs(x), abs(y) <= MAX_COORD_ABS`
- `id` уникален в `nodes`

## 7. Общий контракт для `objects[*]`

```json
{
  "id": "obj_1",
  "type": "bar",
  "nodeRefs": ["N1", "N2"],
  "geometry": {},
  "style": {},
  "label": "l",
  "meta": {}
}
```

### 7.1 Общие поля
- `id: string` (required, уникальный)
- `type: string` (required, только из словаря)
- `nodeRefs: string[]` (required для большинства типов)
- `geometry: object` (required)
- `style: object` (optional)
- `label: string` (optional)
- `meta: object` (optional)

## 8. Словарь типов объектов

Ниже указан канонический набор. Типы из запроса пользователя являются обязательными.

## 8.1 Физические тела

### `bar`
Линия между двумя узлами.

Обязательные поля:
- `nodeRefs: [startNodeId, endNodeId]`

`geometry`:
- `thickness?: number`
- `lineType?: "solid" | "dashed"`

Пример:
```json
{
  "id": "bar_1",
  "type": "bar",
  "nodeRefs": ["A", "B"],
  "geometry": { "lineType": "solid", "thickness": 3 }
}
```

### `cable`
Гибкая нить/трос между узлами.

Обязательные:
- `nodeRefs: [startNodeId, endNodeId]`

`geometry`:
- `sag?: number` (провисание, >= 0)

### `spring`
Пружина между узлами.

Обязательные:
- `nodeRefs: [startNodeId, endNodeId]`

`geometry`:
- `turns?: integer` (>= 3)
- `amplitude?: number` (> 0)

### `damper`
Демпфер между узлами.

Обязательные:
- `nodeRefs: [startNodeId, endNodeId]`

`geometry`:
- `bodyLength?: number`
- `rodLength?: number`

### `rigid_disk`
Жесткий диск/колесо.

Обязательные:
- `nodeRefs: [centerNodeId]`
- `geometry.radius: number` (> 0)

Дополнительно:
- `geometry.innerRadius?: number`
- `geometry.spokes?: integer`

## 8.2 Опоры и связи

### `fixed_wall`
Жесткая заделка с штриховкой.

Обязательные:
- `nodeRefs: [nodeId]`

`geometry`:
- `angle?: number` (градусы, дефолт `90`)
- `hatchSide?: "left" | "right"`

### `hinge_fixed`
Шарнирно-неподвижная опора.

Обязательные:
- `nodeRefs: [nodeId]`

`geometry`:
- `angle?: number`

### `hinge_roller`
Шарнирно-подвижная опора.

Обязательные:
- `nodeRefs: [nodeId]`

`geometry`:
- `surfaceAngle?: number` (угол поверхности)
- `rollerCount?: integer` (>= 1)

### `internal_hinge`
Внутренний шарнир на стыке.

Обязательные:
- `nodeRefs: [nodeId]`

`geometry`:
- `radius?: number`

### `slider`
Ползун на направляющей.

Обязательные:
- `nodeRefs: [nodeId, guideStartNodeId, guideEndNodeId]`

`geometry`:
- `width?: number`
- `height?: number`

## 8.3 Силовые факторы

### `force`
Сосредоточенная сила (стрелка).

Обязательные:
- `nodeRefs: [applicationNodeId]`
- `geometry.direction`: нормализованное направление

Разрешенные формы направления:
- `direction: { "x": number, "y": number }`
- `directionAngle: number` (градусы)
- `cardinal: "up" | "down" | "left" | "right"`

`geometry`:
- `magnitude?: number`
- `sense?: "push" | "pull"`

Пример:
```json
{
  "id": "F1",
  "type": "force",
  "nodeRefs": ["B"],
  "geometry": {
    "directionAngle": -90,
    "magnitude": 12,
    "unit": "kN"
  },
  "label": "P"
}
```

### `moment`
Сосредоточенный момент вокруг узла.

Обязательные:
- `nodeRefs: [centerNodeId]`
- `geometry.direction: "cw" | "ccw"`

`geometry`:
- `magnitude?: number` (если численно неизвестно, допускается символьная метка через `label`)
- `radius?: number`
- `unit?: string`

Пример:
```json
{
  "id": "M_in",
  "type": "moment",
  "nodeRefs": ["A"],
  "geometry": { "direction": "cw" },
  "label": "Mвх"
}
```

### `distributed`
Распределенная нагрузка на участке.

Обязательные:
- `nodeRefs: [startNodeId, endNodeId]`
- `geometry.kind: "uniform" | "linear" | "trapezoid"`
- хотя бы одно из:
  - `geometry.intensity: number`
  - `geometry.intensity: { "start": number, "end": number }`

`geometry`:
- `directionAngle?: number` (дефолт `-90`)
- `arrowCount?: integer`
- `unit?: string`

Пример:
```json
{
  "id": "q1",
  "type": "distributed",
  "nodeRefs": ["A", "B"],
  "geometry": {
    "kind": "trapezoid",
    "intensity": { "start": 5, "end": 12 },
    "directionAngle": -90,
    "unit": "kN/m"
  }
}
```

## 8.4 Кинематика

### `velocity`
Вектор скорости из узла.

Обязательные:
- `nodeRefs: [nodeId]`
- направление (аналогично `force`)

`geometry`:
- `magnitude?: number`
- `unit?: string` (например, `m/s`)

### `acceleration`
Вектор ускорения из узла.

Обязательные:
- `nodeRefs: [nodeId]`
- направление

`geometry`:
- `magnitude?: number`
- `unit?: string` (например, `m/s^2`)
- `arrowStyle?: "single" | "double"`

### `angular_velocity`
Угловая скорость, привязанная к телу/узлу.

Обязательные:
- минимум один из:
  - `nodeRefs: [centerNodeId]`
  - `meta.targetObjectId`
- `geometry.direction: "cw" | "ccw"`

`geometry`:
- `magnitude?: number`
- `unit?: string` (например, `rad/s`)

### `angular_acceleration`
Угловое ускорение (выделено отдельным type для явности).

Обязательные:
- аналогично `angular_velocity`
- `geometry.direction: "cw" | "ccw"`

`geometry`:
- `magnitude?: number`
- `unit?: string` (например, `rad/s^2`)

### `trajectory`
Траектория как кривая по точкам.

Обязательные:
- `geometry.points: Array<{x:number,y:number}>` (>= 2)

`geometry`:
- `lineType?: "dotted" | "dashdot" | "solid"`

## 8.5 Результаты

### `epure`
Эпюра усилий вдоль базового элемента.

Обязательные:
- `type: "epure"` (в массиве `results`)
- `meta.baseObjectId` (обычно `bar`)
- `geometry.baseLine: {startNodeId, endNodeId}`
- `geometry.values: Array<{s:number, value:number}>` (s в [0..1] либо в длине)

`geometry`:
- `kind?: "N" | "Q" | "M" | "custom"`
- `fillHatch?: boolean`
- `showSigns?: boolean`
- `extrema?: Array<{s:number, value:number, label?:string}>`

Пример:
```json
{
  "id": "epure_M1",
  "type": "epure",
  "meta": { "baseObjectId": "bar_1" },
  "geometry": {
    "kind": "M",
    "baseLine": { "startNodeId": "A", "endNodeId": "B" },
    "values": [
      { "s": 0.0, "value": 0.0 },
      { "s": 0.5, "value": 10.0 },
      { "s": 1.0, "value": -2.0 }
    ],
    "showSigns": true,
    "fillHatch": true
  }
}
```

## 8.6 Рекомендуемые служебные типы (добавление к запросу)
Эти типы не противоречат запросу, но заметно повышают читаемость и стабильность:
- `label`
- `dimension`
- `axis`
- `ground`

## 9. Единые style-поля

Рекомендуемый формат:

```json
{
  "strokeColor": "#1f2937",
  "strokeWidth": 2,
  "lineType": "solid",
  "fillColor": "#ffffff",
  "fillOpacity": 0.0,
  "accent": "load|kinematic|result|support"
}
```

Правило: `style` влияет только на отрисовку и не должен менять физическую семантику.

## 10. Нормализация (сервер)

## 10.1 Алиасы типов (`v1 -> v2`)
- `beam_segment -> bar`
- `point_load -> force`
- `distributed_load -> distributed`
- `support_fixed -> fixed_wall`
- `support_pin -> hinge_fixed`
- `support_roller -> hinge_roller`
- `hinge -> internal_hinge`
- `joint -> node` или `internal_hinge` (по контексту)

## 10.2 Алиасы полей
- координаты:
  - `point`, `at`, `position`, `center`, `node` -> `nodeRefs` или `nodes`
- направления:
  - `clockwise`, `counterclockwise`, русские формулировки -> `cw/ccw`
- интенсивность распределенной:
  - `q`, `w`, `loadValue`, `intensityStart/intensityEnd`, `startIntensity/endIntensity`
- парсинг чисел:
  - `"12 kN"` -> `12`
  - `"5,5"` -> `5.5`

## 10.3 Ограничение нормализации
Если после нормализации смысл остается неоднозначным, генерация не принимается:
- пишем ошибку валидации;
- возвращаем подробный reason;
- просим LLM регенерировать строго по контракту.

## 11. Валидация

## 11.1 Глобальная
- `version === "2.0"`
- `nodes` не пустой для схем, где есть объекты с `nodeRefs`
- уникальность `id` внутри `nodes`, `objects`, `results`
- конечные числа
- координатные лимиты
- ограничение размеров массивов (anti-abuse)

## 11.2 Межобъектная
- все `nodeRefs[*]` существуют в `nodes`
- `meta.baseObjectId` у `epure` существует и ссылается на допустимый тип
- для `slider` направляющая задается валидной парой узлов

## 11.3 Тип-специфичная
- `moment.direction in {"cw","ccw"}`
- `distributed` содержит `kind` и интенсивность
- `rigid_disk.radius > 0`
- `trajectory.points.length >= 2`
- `bar` имеет два разных узла

## 11.4 Политика ошибок
- Ошибки должны быть человекочитаемыми:
  - путь (`objects[3].geometry.intensity`)
  - причина
  - подсказка по правильному формату

## 12. Протокол генерации LLM (новый)

## 12.1 Шаг A: каркас узлов
LLM возвращает:
- `nodes`
- первичный список `objects` без детализации стиля
- `assumptions`, `ambiguities`

## 12.2 Шаг B: детализация объектов
LLM возвращает:
- заполненные `geometry`, `nodeRefs`, `label`, `style`
- строго только из словаря v2

## 12.3 Шаг C: self-check
LLM (или серверный пост-процесс) проверяет:
- нет ли коллапса координат;
- все опоры/силы реально привязаны к корректным узлам;
- нет неразрешенных типов.

## 12.4 Ограничения prompt
- Запрет на свободный формат.
- Только JSON.
- Только типы и поля из словаря.
- Язык пояснений (`assumptions`, `ambiguities`) = язык исходного запроса.

## 13. План изменений по кодовой базе

## 13.1 Новые файлы
- `src/lib/schema/object-catalog-v2.ts`
  - реестр типов, обязательных/опциональных полей, алиасов.
- `src/lib/schema/schema-v2.ts`
  - TS-типы `SchemaDataV2`, `NodeV2`, `ObjectV2`, `ResultV2`.
- `src/lib/schema/normalize-v2.ts`
  - нормализация типов/полей/чисел.
- `src/lib/schema/validate-v2.ts`
  - глобальная + тип-специфичная валидация.
- `src/lib/components/scheme-renderers/*`
  - рендереры по типам (`bar.ts`, `force.ts`, `moment.ts`, ...).

## 13.2 Изменяемые файлы
- `src/lib/server/ai/gemini.ts`
  - новые prompt-шаблоны для v2;
  - поддержка staged generation (A/B/C).
- `src/lib/server/schema/flow.ts`
  - роутинг v1/v2, логирование метрик валидации.
- `src/routes/api/schema/start/+server.ts`
  - генерация и сохранение v2 при включенном флаге.
- `src/routes/api/schema/[draftId]/revise/+server.ts`
  - revision в контракте v2.
- `src/lib/components/SchemeView.svelte`
  - переход на renderer-registry и поддержку `nodes + objects + results`.

## 13.3 База данных
Минимально:
- добавить поле `schemaVersion` в `TaskDraft`/`Message` (или хранить в JSON и индексировать выборочно).
- сохранить обратную совместимость чтения старых `schemaData`.

## 14. План миграции

## 14.1 Фаза 0 (подготовка)
- Ввести feature flag: `schemaDslV2Enabled`.
- Добавить чтение v2 без активации генерации.

## 14.2 Фаза 1 (dual-read, single-write v1)
- Backend умеет валидировать v2, но запись из LLM пока v1.
- Сбор метрик на тестовых payload.

## 14.3 Фаза 2 (dual-write)
- LLM генерирует v2.
- Параллельно строится v1-совместимый snapshot (адаптер v2->v1) для fallback.

## 14.4 Фаза 3 (v2 by default)
- Для новых draft включается v2.
- v1 остается read-only для старых сообщений.

## 14.5 Фаза 4 (стабилизация)
- Удаление временного адаптера после целевых метрик качества.

## 15. План реализации (помесячно/по задачам)

## 15.1 Этап 1: Контракт и инфраструктура
- [ ] Утвердить словарь типов и обязательные поля.
- [ ] Добавить TS-типы и каталог.
- [ ] Добавить validator + normalizer v2.

## 15.2 Этап 2: LLM-пайплайн
- [ ] Внедрить staged generation (A/B/C).
- [ ] Обновить prompt для strict JSON.
- [ ] Добавить точные сообщения ошибок для re-ask.

## 15.3 Этап 3: Рендер
- [ ] Перейти на registry renderer.
- [ ] Реализовать обязательные типы из словаря.
- [ ] Реализовать `epure` в `results`.

## 15.4 Этап 4: API и persistence
- [ ] Добавить `schemaVersion`.
- [ ] Поддержать v1/v2 в `start/revise/confirm/get`.
- [ ] Обновить логирование и диагностику.

## 15.5 Этап 5: Тесты и rollout
- [ ] Unit на каждый type.
- [ ] Integration на full flow.
- [ ] E2E для кейсов: балка, рама, кривошипно-шатунный механизм, кинематика, эпюры.

## 16. Тест-план

## 16.1 Unit
- `normalize-v2`: алиасы и парсинг чисел.
- `validate-v2`: по одному позитивному и негативному сценарию на каждый type.
- `object-catalog-v2`: полнота покрытия type-ключей.

## 16.2 Integration
- `start -> revise -> confirm -> solve` для `schema_check`.
- Ревизия с переносом узлов и изменением нагрузок.
- Reject на неизвестный type.

## 16.3 E2E
- Текстовая постановка.
- Текст + изображение.
- Нагрузки + моменты + кинематика в одной сцене.

## 17. Наблюдаемость
- Метрики:
  - `% successful schema generation (first pass)`;
  - `% validation fail by type`;
  - `mean revision count`;
  - `% fallback to adapter v2->v1`.
- Логи:
  - `draftId`, `schemaVersion`, `invalidType`, `invalidPath`, `normalizationActions`.

## 18. Риски и меры
- Риск: слишком жесткий контракт -> рост reject.
  - Мера: staged generation + подробные валидационные подсказки.
- Риск: рендер не успеет покрыть все типы.
  - Мера: registry + поэтапное включение типов.
- Риск: ломаем обратную совместимость.
  - Мера: dual-read, адаптер v2->v1, feature flag rollout.

## 19. Definition of Done
1. Все обязательные типы из словаря поддерживаются end-to-end.
2. `start/revise` стабильно проходят для типовых инженерных задач без ручного редактирования JSON.
3. Снижение ошибок валидации минимум на 50% относительно baseline.
4. Старые `v1` данные отображаются без регрессий.
5. Все unit/integration/e2e тесты зеленые.

## 20. Приложение A: Минимальный пример полной схемы v2

```json
{
  "version": "2.0",
  "meta": { "taskDomain": "mechanics", "catalogVersion": "2026-04-11", "language": "ru" },
  "coordinateSystem": { "xUnit": "m", "yUnit": "m", "origin": { "x": 0, "y": 0 }, "axisOrientation": "right-handed" },
  "nodes": [
    { "id": "A", "x": 0, "y": 0, "label": "A" },
    { "id": "B", "x": 6, "y": 0, "label": "B" },
    { "id": "C", "x": 3, "y": 0, "label": "C" }
  ],
  "objects": [
    { "id": "bar_1", "type": "bar", "nodeRefs": ["A", "B"], "geometry": {} },
    { "id": "sup_A", "type": "hinge_fixed", "nodeRefs": ["A"], "geometry": {} },
    { "id": "sup_B", "type": "hinge_roller", "nodeRefs": ["B"], "geometry": { "surfaceAngle": 0 } },
    { "id": "q1", "type": "distributed", "nodeRefs": ["A", "B"], "geometry": { "kind": "uniform", "intensity": 8, "directionAngle": -90, "unit": "kN/m" } },
    { "id": "M1", "type": "moment", "nodeRefs": ["A"], "geometry": { "direction": "ccw" }, "label": "M" },
    { "id": "F1", "type": "force", "nodeRefs": ["C"], "geometry": { "directionAngle": -90, "magnitude": 20, "unit": "kN" }, "label": "P" }
  ],
  "results": [],
  "annotations": [],
  "assumptions": ["Ось балки принята горизонтальной"],
  "ambiguities": []
}
```

