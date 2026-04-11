# Schema Check Mode - Technical Design Doc

## 1. Document Metadata
- Title: Schema Check Mode (Pre-solve Verification)
- Status: Proposed
- Target system: Coworker (SvelteKit + Node.js + Prisma + Pyodide sandbox + Gemini)
- Last updated: 2026-04-11
- Authors: Codex + Team

## 2. Context and Problem
Today the app can directly solve a task from user text/image. For engineering tasks this may fail when the model misunderstands initial geometry, supports, loads, moments, sign conventions, or labels.

The user request is to add a gated mode where the model must first build an initial JSXGraph-compatible scheme and wait for explicit user confirmation before solving.

## 3. Goals
- Add a new user mode: `Schema Check`.
- Force two-phase workflow: `Build scheme -> User approval -> Solve`.
- Make approved scheme the single source of truth for final solving.
- Support iterative user corrections of the scheme.
- Keep security constraints: LLM does not do numeric solving directly.

## 4. Non-goals
- Full CAD-level drawing editor.
- Arbitrary freehand user drawing tools in v1.
- Replacing existing graph/diagram rendering for solved results.

## 5. Product Requirements
1. User enables checkbox `Schema Check`.
2. App generates initial scheme from text and optional image.
3. User can:
   - confirm scheme and continue solving, or
   - request changes by text and regenerate scheme.
4. User may iterate corrections until satisfied.
5. Solve phase starts only after scheme confirmation.

## 6. High-level Solution
Implement a dedicated scheme verification flow with explicit state machine and a new structured `schemaData` DSL.

Key architecture decisions:
1. Separate scheme rendering model from function/diagram point arrays.
2. Persist revision history and approval state in DB.
3. Block solve API when no approved scheme exists.
4. Pass approved scheme into solve pipeline as hard context.

## 7. Data Model Changes (Prisma)

### 7.1 New entities
Add a draft entity for multi-step workflow.

```prisma
enum DraftStatus {
  DRAFT
  SCHEMA_GENERATED
  AWAITING_REVIEW
  NEEDS_REVISION
  SCHEMA_APPROVED
  SOLVING
  SOLVED
  CANCELED
  FAILED
}

model TaskDraft {
  id                 String      @id @default(cuid())
  chatId             String
  userId             String
  mode               String      @default("standard") // "standard" | "schema_check"
  status             DraftStatus @default(DRAFT)
  originalPrompt     String      @db.Text
  originalImageData  String?     @db.Text
  currentSchema      Json?
  approvedSchema     Json?
  revisionCount      Int         @default(0)
  createdAt          DateTime    @default(now())
  updatedAt          DateTime    @updatedAt

  chat               Chat        @relation(fields: [chatId], references: [id], onDelete: Cascade)

  @@index([chatId])
  @@index([userId, createdAt])
}

model TaskDraftRevision {
  id            String   @id @default(cuid())
  draftId       String
  revisionIndex Int
  userNotes     String?  @db.Text
  schema        Json
  assumptions   Json?
  createdAt     DateTime @default(now())

  draft         TaskDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)

  @@unique([draftId, revisionIndex])
  @@index([draftId, createdAt])
}
```

### 7.2 Message linkage (optional but recommended)
Attach `draftId` to assistant messages created in this flow for easy timeline reconstruction.

## 8. Schema DSL (`schemaData`) Contract

### 8.1 Root shape
```json
{
  "version": "1.0",
  "coordinateSystem": {
    "xUnit": "m",
    "yUnit": "m",
    "origin": { "x": 0, "y": 0 }
  },
  "elements": [],
  "annotations": [],
  "assumptions": []
}
```

### 8.2 Supported element types
- `beam_segment`
- `support_pin`
- `support_roller`
- `support_fixed`
- `point_load`
- `distributed_load`
- `moment`
- `hinge`
- `joint`
- `axis`
- `dimension`
- `label`

### 8.3 Common element fields
- `id: string`
- `type: string`
- `geometry: object`
- `style: object` (optional)
- `meta: object` (optional)

### 8.4 Validation rules
- Numeric values must be finite.
- Coordinates must be bounded (`abs(value) <= MAX_COORD`).
- `distributed_load` must have valid start/end and intensity.
- `moment` must include direction (`cw`/`ccw`) and magnitude.
- No duplicate IDs in one scheme.
- Max element count limit (for anti-abuse).

Server-side validation must happen before persistence and rendering.

## 9. API Design

### 9.1 Start schema flow
- `POST /api/schema/start`
- Input:
```json
{
  "chatId": "...",
  "message": "...",
  "imageData": { "base64": "...", "mimeType": "image/png" },
  "mode": "schema_check"
}
```
- Output:
```json
{
  "draftId": "...",
  "status": "AWAITING_REVIEW",
  "schema": { "...": "..." },
  "revisionIndex": 0,
  "assumptions": []
}
```

### 9.2 Revise scheme
- `POST /api/schema/{draftId}/revise`
- Input:
```json
{
  "notes": "move support B to x=6m, P should be 12kN downward"
}
```
- Output:
```json
{
  "status": "AWAITING_REVIEW",
  "revisionIndex": 1,
  "schema": { "...": "..." },
  "assumptions": []
}
```

### 9.3 Confirm scheme
- `POST /api/schema/{draftId}/confirm`
- Input: `{}` (or optional user confirmation note)
- Behavior:
  - set `approvedSchema = currentSchema`
  - transition status to `SCHEMA_APPROVED`
  - call solve pipeline with approved schema as mandatory context
- Output:
```json
{
  "status": "SOLVING"
}
```

### 9.4 Get draft state
- `GET /api/schema/{draftId}`
- Output current status, current revision, and latest scheme.

### 9.5 Cancel draft (optional)
- `POST /api/schema/{draftId}/cancel`

## 10. State Machine

Allowed transitions:
- `DRAFT -> SCHEMA_GENERATED -> AWAITING_REVIEW`
- `AWAITING_REVIEW -> NEEDS_REVISION -> SCHEMA_GENERATED -> AWAITING_REVIEW`
- `AWAITING_REVIEW -> SCHEMA_APPROVED -> SOLVING -> SOLVED`
- `* -> FAILED` on fatal errors
- `* -> CANCELED` by user action

Invalid transitions must return `409 Conflict`.

## 11. AI Pipeline Changes

### 11.1 New pipeline branches
1. `generateInitialSchema(...)`
2. `reviseSchema(...)`
3. `solveWithApprovedSchema(...)`

### 11.2 Prompting strategy
- Scheme generation prompts must forbid final solving.
- Must require explicit output keys:
  - `schemaData`
  - `assumptions`
  - `ambiguities`
- Solve prompt must include:
  - original task
  - approved schema JSON
  - all accepted revision notes

### 11.3 Hard solve gate
`solveWithApprovedSchema` is rejected if `approvedSchema == null`.

## 12. Python Sandbox Contract

### 12.1 Scheme phase output
Python returns JSON only:
```json
{
  "schemaData": { "...": "..." },
  "assumptions": [],
  "ambiguities": []
}
```

### 12.2 Solve phase output
Existing output shape remains:
- `result`
- `graphs` / `graph_points`
- optional additional values

### 12.3 Limits
- Keep timeout and queue limits from current hardening.
- Add separate max element count and max annotation length for scheme phase.

## 13. Frontend UX Changes

### 13.1 Input area
- Add checkbox: `Schema Check`.
- If checked, send request to `/api/schema/start` instead of direct `/api/chat`.

### 13.2 Review panel
- Display generated scheme in dedicated component.
- Two actions:
  - `Confirm scheme`
  - `Revise scheme`
- On revise, open dedicated text area for correction notes.

### 13.3 Timeline behavior
- Show revision number.
- Keep history of generated schemes and user notes.
- Block normal send/solve while draft is `AWAITING_REVIEW`.

## 14. Rendering: New `SchemeView` Component

Create `SchemeView.svelte` to render `schemaData` primitives with JSXGraph.

Responsibilities:
- map DSL elements to JSXGraph primitives
- render loads/moments with arrows and labels
- consistent engineering visual language
- no raw HTML injection

`GraphView.svelte` remains for numeric function/diagram outputs after solving.

## 15. Security and Integrity
- Authorization checks on every draft endpoint (`draft.userId == locals.user.id`).
- Validate and sanitize all user revision notes.
- Strict JSON schema validation for `schemaData`.
- Refuse solving without approved scheme.
- Add idempotency protection for confirm endpoint.
- Add optimistic lock (`updatedAt` or version field) to avoid race conditions.

## 16. Observability and Metrics
- Log state transitions with `draftId`, `chatId`, `userId`.
- Metrics:
  - drafts started
  - average revisions before approval
  - approval rate on first revision
  - solve success rate after approval
  - timeout rate in scheme phase vs solve phase

## 17. Rollout Plan
1. Add feature flag `schemaCheckModeEnabled`.
2. Enable for internal users first.
3. Observe latency and error metrics.
4. Roll out gradually to all users.

## 18. Testing Plan

### 18.1 Unit
- schema DSL validator
- state transition guard
- endpoint authorization

### 18.2 Integration
- full flow: `start -> revise -> confirm -> solve`
- concurrency/race tests on `confirm`
- rejection when solving without approval

### 18.3 E2E
- text-only scheme case
- image + text scheme case
- multi-revision case

## 19. Backward Compatibility
- Existing chat flow (`standard` mode) remains unchanged.
- New mode is opt-in via checkbox.

## 20. Risks and Mitigations

Risk: model generates visually valid but semantically wrong scheme.
- Mitigation: mandatory user approval loop + assumptions list.

Risk: complexity of DSL grows.
- Mitigation: strict versioning (`schemaData.version`) and migration strategy.

Risk: higher latency.
- Mitigation: split phases, cache reusable context, keep one-worker optimization on weak servers.

## 21. Implementation Map (Current Codebase)
- Backend:
  - `src/routes/api` new schema endpoints
  - `src/lib/server/ai/pipeline.ts` split flow branches
  - `src/lib/server/ai/gemini.ts` new prompts/functions
  - `src/lib/server/sandbox/*` reuse existing execution contract
- Frontend:
  - `src/routes/+page.svelte` checkbox + review UI
  - `src/lib/components/SchemeView.svelte` new renderer
  - `src/lib/components/MessageRenderer.svelte` support `schemeData`
- DB:
  - `prisma/schema.prisma` new models + migration

## 22. Acceptance Criteria
1. User can iteratively refine scheme before solving.
2. Solve is impossible until scheme confirmation.
3. Final solve consumes approved scheme as required context.
4. Existing non-schema flow remains operational.
5. Tests for new flow are green.

