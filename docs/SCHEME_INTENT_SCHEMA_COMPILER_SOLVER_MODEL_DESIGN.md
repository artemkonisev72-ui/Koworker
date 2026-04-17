# SchemeIntent + SchemaCompiler + SolverModel

## 1. Метаданные документа
- Название: `SchemeIntent + SchemaCompiler + SolverModel`
- Статус: `Proposed`
- Проект: `Coworker`
- Дата: `2026-04-17`
- Авторы: `Codex + Team`
- Связанные документы:
  - `docs/SCHEMA_CHECK_MODE_DESIGN.md`
  - `docs/LLM_GRAPH_OBJECT_DICTIONARY_V2_DESIGN.md`

## 2. Проблема

Сейчас initial schema flow построен вокруг прямой генерации `schemaData v2` моделью.
Точка входа: `src/lib/server/ai/gemini.ts`, функция `generateInitialSchema(...)`.
На сервере это вызывается из `src/routes/api/schema/start/+server.ts`, причём с `fastMode: true`.

Это означает, что LLM на первом же шаге обязана одновременно:
- понять физический смысл задачи;
- определить класс конструкции (`beam | planar_frame | spatial_frame`);
- восстановить топологию;
- выбрать правильные опоры и нагрузки;
- назначить узлы;
- придумать `nodeRefs`;
- придумать `id`;
- отдать корректный `schemaData v2`;
- не нарушить контракт `normalize-v2.ts` / `validate-v2.ts`;
- не перепутать знаки, локальные оси и типы эпюр.

Для LLM это слишком широкий набор зависимых решений. Ошибка на любом раннем шаге почти всегда размножается:
- неверный тип конструкции -> неверные supports;
- неверные supports -> неверная ось эпюр;
- неверная топология -> бессмысленные `nodeRefs`;
- неверные `nodeRefs` -> схема может стать формально валидной, но физически ложной.

Нормализатор и валидатор уже умеют:
- чистить контракт;
- восстанавливать часть geometry;
- канонизировать локальные оси;
- исправлять часть эпюр.

Но они не могут надёжно исправить неверный физический смысл. Если модель неверно поняла исходную схему, backend уже опаздывает.

## 3. Цели

- Убрать из ответственности LLM всё, что лучше делать детерминированно на сервере.
- Свести задачу LLM к извлечению физического смысла, а не к сборке финального render-ready JSON.
- Сделать initial schema generation устойчивой, даже если задача сложная или содержит изображение.
- Сделать flow `start -> revise -> confirm -> solve` основанным на едином каноническом представлении конструкции.
- Развести:
  - семантику конструкции;
  - визуальную схему;
  - расчётную модель.

## 4. Не-цели

- Полный CAD-редактор.
- Свободное ручное рисование геометрии.
- Полная замена `schemaData v2` как формата рендера на фронте.
- Немедленный рефактор всего solve pipeline за один этап.

## 5. Ключевая идея

Вместо прямой генерации `schemaData` вводятся три слоя:

1. `SchemeIntent`
   Семантическое представление конструкции, которое генерирует LLM.

2. `SchemaCompiler`
   Детерминированный серверный компилятор, который превращает `SchemeIntent` в `schemaData v2`.

3. `SolverModel`
   Каноническая расчётная модель, которая строится из утверждённой схемы и используется solver pipeline.

Итоговое правило:

> LLM не строит финальную схему напрямую.
> LLM описывает смысл.
> Сервер строит схему.
> Сервер строит расчётную модель.

## 6. Целевая архитектура

### 6.1 Новый end-to-end flow

`user prompt/image`
-> `Problem understanding`
-> `SchemeIntent`
-> `SchemaCompiler`
-> `schemaData v2`
-> `user review`
-> `approved SchemaIntent`
-> `SchemaCompiler`
-> `approved schemaData v2`
-> `SolverModel`
-> `solver/LLM numeric pipeline`
-> `graphs/results`

### 6.2 Слои ответственности

#### LLM отвечает только за:
- распознавание типа конструкции;
- перечисление стержней, узлов-смыслов, опор, нагрузок;
- смысл привязок;
- смысл направлений;
- перечень требуемых результатных компонент;
- явные неоднозначности.

#### SchemaCompiler отвечает за:
- deterministic ids;
- deterministic `nodeRefs`;
- перевод semantic joints в реальные nodes;
- scaffold coordinates;
- template-based layout;
- нормализацию object catalog;
- attachment geometry;
- визуальный `schemaData v2`.

#### SolverModel builder отвечает за:
- локальные оси стержней;
- каноническое направление осей;
- support conditions;
- loads в member-local координатах;
- beam/frame sign conventions;
- канонический набор требуемых эпюр/компонент.

## 7. Новый контракт `SchemeIntent`

`SchemeIntent` должен быть минимальным, детерминируемым и не содержать UI-специфики.

### 7.1 Root shape

```ts
export interface SchemeIntentV1 {
  version: 'intent-1.0';
  taskDomain: 'mechanics';
  structureKind: 'beam' | 'planar_frame' | 'spatial_frame';
  modelSpace: 'planar' | 'spatial';
  confidence: 'high' | 'medium' | 'low';
  source: {
    hasImage: boolean;
    language: 'ru' | 'en';
  };
  joints: IntentJoint[];
  members: IntentMember[];
  supports: IntentSupport[];
  loads: IntentLoad[];
  jointsExtra?: IntentJointFeature[];
  requestedResults?: IntentRequestedResult[];
  assumptions: string[];
  ambiguities: string[];
}
```

### 7.2 Intent joints

```ts
export interface IntentJoint {
  key: string;             // semantic key, e.g. "A", "B", "J1"
  role?: 'start' | 'end' | 'corner' | 'free_end' | 'fixed_end' | 'generic';
  label?: string;          // display hint only
}
```

Правила:
- `key` обязателен и уникален в пределах intent.
- Это ещё не `nodeId`.
- Модель не генерирует `N1`, `N2`, `nodeRefs`.

### 7.3 Intent members

```ts
export interface IntentMember {
  key: string;             // semantic member key, e.g. "m1"
  kind: 'bar' | 'cable' | 'spring' | 'damper';
  startJoint: string;      // joint.key
  endJoint: string;        // joint.key
  relation?: 'horizontal' | 'vertical' | 'inclined' | 'collinear_with_prev';
  lengthHint?: number | string;
  angleHintDeg?: number;
  groupHint?: string;
  label?: string;
}
```

Правила:
- `startJoint` / `endJoint` указывают на semantic joints.
- Если известна длина, она идёт в `lengthHint`.
- Если длина неизвестна, допускается только relation hint.
- Для beam задач обычно достаточно `horizontal` без конкретных координат.

### 7.4 Intent supports

```ts
export interface IntentSupport {
  key: string;
  kind: 'fixed_wall' | 'hinge_fixed' | 'hinge_roller' | 'internal_hinge' | 'slider';
  jointKey?: string;
  memberKey?: string;
  s?: number;              // only if support is attached along member
  sideHint?: 'left' | 'right' | 'top' | 'bottom';
  guideHint?: 'horizontal' | 'vertical' | 'member_local';
}
```

Правила:
- Support не задаёт `nodeRefs`.
- Support указывает либо `jointKey`, либо `(memberKey + s)`.
- `sideHint` остаётся смысловой подсказкой, а не готовой screen geometry.

### 7.5 Intent loads

```ts
export interface IntentLoad {
  key: string;
  kind: 'force' | 'moment' | 'distributed';
  target:
    | { jointKey: string }
    | { memberKey: string; s: number }
    | { memberKey: string; fromS: number; toS: number };
  directionHint?:
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | '+x'
    | '-x'
    | '+y'
    | '-y'
    | 'cw'
    | 'ccw'
    | 'member_local_positive'
    | 'member_local_negative';
  magnitudeHint?: number | string | { start: number | string; end: number | string };
  distributionKind?: 'uniform' | 'linear' | 'trapezoid';
  label?: string;
}
```

Правила:
- Для `force` / `moment` target должен быть точечным.
- Для `distributed` target должен быть интервальным.
- LLM не задаёт финальный `geometry.directionAngle`; это делает compiler.

### 7.6 Requested results

```ts
export interface IntentRequestedResult {
  targetMemberKey?: string;
  kind: 'N' | 'Q' | 'M' | 'Vy' | 'Vz' | 'T' | 'My' | 'Mz';
}
```

Правила:
- Beam: канон `N | Q | M`.
- Planar frame: канон `N | Vy | Mz`.
- Spatial frame: канон `N | Vy | Vz | T | My | Mz`.

### 7.7 Явный режим неопределённости

Если модель не уверена, она не должна угадывать.

Вместо этого она обязана добавить ambiguity:

```json
{
  "ambiguities": [
    "Неоднозначно, является ли правая опора шарнирно-подвижной или жесткой заделкой."
  ]
}
```

Если ambiguity влияет на топологию, схема не должна автоматически считаться утверждаемой без пользовательского review.

## 8. Новый модуль `SchemaCompiler`

### 8.1 Назначение

`SchemaCompiler` принимает `SchemeIntentV1` и возвращает:

```ts
interface CompileSchemaIntentResult {
  schemaData: SchemaDataV2;
  warnings: string[];
  compilerFacts: {
    templateUsed: string | null;
    generatedNodeIds: string[];
    generatedObjectIds: string[];
  };
}
```

### 8.2 Размещение

Новый модуль:
- `src/lib/schema/intent.ts`
- `src/lib/schema/compiler.ts`
- `src/lib/schema/compiler.test.ts`

### 8.3 Ответственность компилятора

Компилятор обязан:
- проверить базовую связность intent;
- сгенерировать deterministic ids;
- превратить semantic joints в `nodes`;
- превратить semantic members/supports/loads в `objects`;
- назначить `coordinateSystem`, `meta.structureKind`, `modelSpace`;
- построить начальный scaffold coordinates;
- вызвать существующие `normalizeSchemaDataV2(...)` и `validateSchemaDataV2(...)`;
- вернуть либо корректный `schemaData`, либо compile-time ошибки.

Компилятор не должен:
- делать numeric solving;
- придумывать физический смысл, отсутствующий в intent;
- silently менять topology;
- рисовать эпюры на initial schema step.

### 8.4 Deterministic ids

Политика:
- joints -> `N1`, `N2`, `N3` в стабильном порядке;
- members -> `bar_1`, `bar_2`, ... по порядку в intent;
- supports -> `support_1`, `support_2`, ...;
- loads -> `load_1`, `load_2`, ...;
- results placeholders -> только если это явно нужно в schema review.

Стабильный порядок:
- сначала joints в том порядке, в каком они записаны в intent;
- затем members;
- затем supports;
- затем loads.

Это критично для стабильных revisions и diff.

### 8.5 Template-based layout

Компилятор должен сначала пытаться применить шаблон layout.

Минимальный набор шаблонов v1:
- simple beam;
- cantilever beam;
- two-support beam;
- single-bay planar frame;
- L-frame;
- simple spatial frame skeleton.

Если intent попадает в шаблон, layout генерируется шаблоном.
Если не попадает, включается generic topology-first placement.

### 8.6 Generic topology-first placement

Для fallback layout:
- beam:
  - все joints вдоль глобальной X;
  - start/end order берётся из member chain;
- planar frame:
  - сначала выделяются горизонтальные и вертикальные members;
  - узлы размещаются на coarse grid;
- spatial frame:
  - строится 3D scaffold, затем сохраняется 2D projection preset;
  - projected screen layout не влияет на семантику.

### 8.7 Conversion rules: members

`IntentMember` -> `ObjectV2(type="bar" | ...)`

Компилятор:
- создаёт `nodeRefs` по `startJoint/endJoint`;
- переводит `lengthHint` в `geometry.length`, если это число;
- переводит `relation/angleHintDeg` в `geometry.angleDeg` или `geometry.constraints`;
- заполняет `meta.intentKey`.

### 8.8 Conversion rules: supports

Компилятор:
- support на joint -> прямой объект с `nodeRefs: [jointNodeId]`;
- support along member -> создаёт attach-node, если это необходимо;
- `sideHint` переводит в `wallSide` или аналогичную geometry семантику;
- `slider` требует явного guide skeleton, который создаёт compiler.

### 8.9 Conversion rules: loads

Компилятор:
- point load at joint -> `force` с `nodeRefs: [jointNodeId]`;
- point load on member -> создаёт attachment node или geometry.attach;
- moment -> `moment` с `cw/ccw`;
- distributed -> `distributed` между двумя узлами или по member interval с attach semantics.

Правило:
- если server может выразить нагрузку через `geometry.attach`, он должен предпочесть attach вместо искусственного размножения узлов;
- но для типового beam UI допустим synthetic helper node, если это упрощает рендер и ревизии.

### 8.10 Coordinate system defaults

Beam:
- `structureKind = "beam"`
- `modelSpace = "planar"`
- `planeNormal = (0,0,1)`

Planar frame:
- `structureKind = "planar_frame"`
- `modelSpace = "planar"`
- `planeNormal = (0,0,1)` по умолчанию

Spatial frame:
- `structureKind = "spatial_frame"`
- `modelSpace = "spatial"`
- `referenceUp = (0,0,1)` по умолчанию
- `secondaryReference = (1,0,0)` по умолчанию
- `projectionPreset = "auto_isometric"` по умолчанию

## 9. Новый модуль `SolverModel`

### 9.1 Назначение

`SolverModel` — это не render model и не user-facing schema.
Это единственный канонический вход для solver pipeline.

```ts
export interface SolverModelV1 {
  version: 'solver-1.0';
  structureKind: 'beam' | 'planar_frame' | 'spatial_frame';
  modelSpace: 'planar' | 'spatial';
  members: SolverMember[];
  supports: SolverSupport[];
  loads: SolverLoad[];
  requestedResults: SolverRequestedResult[];
  signConvention: SolverSignConvention;
}
```

### 9.2 Solver member

```ts
export interface SolverMember {
  id: string;                  // canonical object id, e.g. bar_1
  startNodeId: string;
  endNodeId: string;
  length: number | null;
  localFrame: {
    x: { x: number; y: number; z: number };
    y: { x: number; y: number; z: number };
    z: { x: number; y: number; z: number };
  };
  axisOrigin: 'member_start' | 'free_end';
}
```

### 9.3 Solver support/load

Все supports и loads в `SolverModel` должны быть уже привязаны к:
- `memberId + local s`,
- или `nodeId`,
- с каноническими направлениями и знаками.

Это означает, что solver не должен парсить JSXGraph-style geometry и не должен угадывать orientation.

### 9.4 Sign conventions

`SolverSignConvention` фиксирует:
- beam rules;
- planar frame component mapping;
- spatial frame component mapping;
- rule for cantilever axis origin;
- rule for compressed fiber side in moment diagrams.

Эта семантика должна жить в одном месте и использоваться:
- solver output normalization;
- graph normalization;
- epure rendering.

## 10. Изменения в AI pipeline

### 10.1 Новый pipeline initial schema

Текущий:
- `generateInitialSchema(...) -> schemaData`

Новый:
- `generateInitialIntent(...) -> SchemeIntent`
- `compileSchemeIntent(...) -> schemaData`

Если compile/validate fails:
- сначала `repairIntentByIssues(...)`, а не repair полного `schemaData`.

### 10.2 Новый pipeline revise

Текущий:
- `reviseSchema(originalPrompt, currentSchema, revisionNotes)`

Новый:
- `reviseIntent(originalPrompt, currentIntent, revisionNotes)`
- `compileSchemeIntent(revisedIntent)`

Политика:
- LLM редактирует не `nodeRefs`, а semantic meaning;
- compiler пересобирает финальную схему полностью.

### 10.3 Новый pipeline solve

После `confirm`:
- approved intent становится source of truth;
- compiler строит approved `schemaData`;
- builder строит `SolverModel`;
- solve pipeline получает `SolverModel`, а не raw render schema.

### 10.4 Prompt simplification

Вместо гигантского prompt на генерацию `schemaData` prompt для LLM должен требовать:
- joints;
- members;
- supports;
- loads;
- requestedResults;
- assumptions;
- ambiguities.

LLM больше не должна генерировать:
- `nodeRefs`;
- `geometry.baseLine.startNodeId`;
- render coordinates;
- final ids;
- layout metadata.

## 11. API и persistence changes

### 11.1 TaskDraft

Текущий `TaskDraft.currentSchema` недостаточен как source of truth.

Нужно добавить:

```prisma
model TaskDraft {
  ...
  currentIntent      Json?
  approvedIntent     Json?
  currentSchema      Json?
  approvedSchema     Json?
  solverModel        Json?
}
```

Минимальная политика:
- `currentIntent` хранит последний semantic draft;
- `approvedIntent` фиксируется при confirm;
- `currentSchema` и `approvedSchema` остаются для UI/render;
- `solverModel` можно либо кэшировать, либо пересобирать детерминированно.

### 11.2 TaskDraftRevision

Revision history должна хранить:
- `intent`;
- `schema`;
- `assumptions`;
- `ambiguities`;
- `userNotes`.

Именно `intent` должен считаться основным объектом ревизии.

### 11.3 Public API behavior

Внешний API может временно остаться прежним:
- `POST /api/schema/start`
- `POST /api/schema/{draftId}/revise`
- `POST /api/schema/{draftId}/confirm`

Но внутри:
- `start` создаёт intent, потом schema;
- `revise` меняет intent, потом schema;
- `confirm` фиксирует approved intent, потом строит solver model.

## 12. Совместимость с текущими модулями

### 12.1 Что можно сохранить

Без радикальной замены можно сохранить:
- `schemaData v2` как render contract;
- `normalizeSchemaDataV2(...)`;
- `validateSchemaDataV2(...)`;
- `SchemeView.svelte`;
- `MessageRenderer.svelte`;
- graph normalization;
- beam/frame epure rendering.

### 12.2 Что нужно изменить

Новые или изменённые модули:
- `src/lib/server/ai/gemini.ts`
  - новые `generateInitialIntent`, `reviseIntent`, `repairIntentByIssues`
- `src/routes/api/schema/start/+server.ts`
  - переход с `schemaData-first` на `intent-first`
- `src/routes/api/schema/[draftId]/revise/+server.ts`
  - аналогично
- `src/lib/schema/intent.ts`
- `src/lib/schema/compiler.ts`
- `src/lib/solver/model.ts`
- `src/lib/server/ai/pipeline.ts`
  - solve phase принимает `SolverModel`

## 13. Этапы внедрения

### Phase 1: Intent-only for start
- Ввести `SchemeIntentV1`.
- Добавить `generateInitialIntent(...)`.
- Добавить `SchemaCompiler`.
- `start` endpoint начинает работать через intent, но UI по-прежнему получает обычный `schemaData`.

### Phase 2: Intent-based revisions
- Добавить `reviseIntent(...)`.
- Добавить `repairIntentByIssues(...)`.
- Хранить `currentIntent` и revisions по intent.

### Phase 3: SolverModel
- Добавить builder `schemaData -> SolverModel`.
- Перевести solve pipeline на `SolverModel`.
- Solver output нормализовать через member-local semantics, а не через render schema.

### Phase 4: Prompt hardening and template routing
- Ввести template routing для частых задач.
- Убрать `fastMode` по умолчанию для start.
- Ввести отдельный lightweight pre-step для confidence/ambiguity.

## 14. Риски и решения

### Риск 1: Compiler станет слишком “умным”
Решение:
- compiler не должен додумывать физику;
- только deterministic expansion intent -> schema;
- все недостающие физические решения остаются ambiguity.

### Риск 2: Intent окажется слишком бедным
Решение:
- v1 держать минимальным;
- добавлять поля только если их реально не хватает compiler-у;
- не тащить в intent render-specific шум.

### Риск 3: Миграция будет слишком дорогой
Решение:
- оставить `schemaData v2` как внешний контракт;
- менять только внутренний pipeline;
- внедрять по фазам, начиная с `start`.

### Риск 4: Пользовательские ревизии станут сложнее
Решение:
- revisions делать на уровне intent patch semantics;
- пользователю это даже проще: “опора справа”, “сила вниз в середине”, а не правка `nodeRefs`.

## 15. Тестовая стратегия

### 15.1 Unit tests
- parse/validate `SchemeIntent`;
- deterministic id generation;
- member/support/load compilation;
- template selection;
- fallback topology placement;
- `schemaData -> SolverModel` canonicalization.

### 15.2 Snapshot / golden tests
- одно и то же intent всегда даёт одинаковый `schemaData`;
- одно и то же approved schema всегда даёт одинаковый `SolverModel`.

### 15.3 Corpus tests
- simple beam;
- cantilever beam;
- beam with point load at midspan;
- beam with distributed load;
- planar frame with corner;
- spatial frame with vertical member;
- text-only task;
- image-assisted task.

### 15.4 Acceptance metrics
- first-pass valid schema rate;
- first-pass physically correct topology rate;
- repair-needed rate;
- revision count before approval;
- wrong-support-type rate;
- wrong-load-attachment rate.

## 16. Решения по умолчанию

- Initial schema flow не должен строиться вокруг прямой генерации `schemaData`.
- `schemaData v2` сохраняется как UI/render contract.
- `SchemeIntent` становится source of truth для draft/revision/approval.
- `SchemaCompiler` становится единственным местом, где рождаются `nodeRefs`, ids и scaffold coordinates.
- `SolverModel` становится единственным каноническим входом для solve pipeline.
- `fastMode` не должен быть default для start после внедрения intent-first architecture.

## 17. Краткий итог

Эта архитектура не делает LLM “умнее”.
Она делает её задачу уже и проще.

Вместо требования:

> “Пойми задачу и сразу верни идеальный render-ready schema JSON”

мы переходим к требованию:

> “Пойми физический смысл и опиши его коротким семантическим контрактом”

После этого сервер детерминированно делает всё, в чём машина надёжнее модели:
- ids;
- nodeRefs;
- layout;
- compile в `schemaData`;
- compile в `SolverModel`;
- канонизацию осей и знаков.

Это и есть самый сильный долгосрочный выигрыш: мы меняем не prompt, а границу ответственности между LLM и приложением.
