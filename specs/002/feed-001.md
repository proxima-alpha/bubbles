# Spec-002 Feedback — Provider 리팩토링 + 프로필 사진 + CodeDto

## 변경 사항

### 1. Provider를 인프라(ollama) → 브랜드(exaone, llama, claude, gpt, gemini)로 변경

**현재 문제:** `provider`가 서빙 인프라(`ollama`)를 의미함. 어떤 브랜드 모델인지 알 수 없음.

**변경 방향:** `provider`는 모델 브랜드를 의미. `common_code(model).parent_code`로 provider를 결정. 실제 서빙 인프라(ollama baseUrl 등)는 model code로 결정 — model별 ollama 기반 여부는 코드에 고정.

---

### 2. CodeDto 규칙 적용

공통코드 필드는 `common_code` join 후 `{ code, name }` 형태로 반환.

---

## 구현 대상

- [x] T1. seed.ts — provider 공통코드 변경

`ollama` 제거, 브랜드별 provider 추가. model의 `parent_code` 업데이트.

```ts
// provider codes
{ category_code: 'provider', code: 'exaone', name: 'EXAONE', order: 1 },
{ category_code: 'provider', code: 'llama', name: 'Llama', order: 2 },
{ category_code: 'provider', code: 'claude', name: 'Claude', order: 3 },
{ category_code: 'provider', code: 'gpt', name: 'GPT', order: 4 },
{ category_code: 'provider', code: 'gemini', name: 'Gemini', order: 5 },

// model: parent_code → provider brand
{ category_code: 'model', code: 'exaone3.5:2.4b', name: 'EXAONE 3.5 2.4B', parent_category_code: 'provider', parent_code: 'exaone', order: 1 },
```

- [x] T2. src/common/dto/code.dto.ts — CodeDto 정의

```ts
export class CodeDto {
  code: string;
  name: string;
}
```

- [x] T3. model.service.ts — getModelInfo에서 provider를 common_code parent_code로 조회

```ts
async getModelInfo(userId: string) {
  const user = await this.prisma.user.findUnique({ where: { id: userId } });
  if (!user?.model) throw new ForbiddenException('No model selected');

  const modelCode = await this.prisma.common_code.findUnique({
    where: { category_code_code: { category_code: 'model', code: user.model } },
  });

  const baseUrl = this.config.get<string>('OLLAMA_BASE_URL', 'http://localhost:11434');
  return {
    model: user.model,
    baseUrl,
    provider: modelCode?.parent_code ?? 'unknown',
  };
}
```

- [x] T4. user.service.ts — getProfile에서 model을 CodeDto로 반환

```ts
async getProfile(userId: string) {
  const user = await this.prisma.user.findUnique({ where: { id: userId } });
  if (!user?.model) return { email: user.email, model: null };

  const modelCode = await this.prisma.common_code.findUnique({
    where: { category_code_code: { category_code: 'model', code: user.model } },
  });

  return {
    email: user.email,
    model: modelCode ? { code: modelCode.code, name: modelCode.name } : null,
  };
}
```

- [x] T5. chat.service.ts — getHistory에서 provider, model을 CodeDto로 반환

`message.provider`, `message.model` 값으로 common_code join.

```ts
async getHistory(userId: string) {
  const messages = await this.prisma.message.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    include: {
      // prisma relation 없으므로 별도 쿼리로 join
    },
  });

  // provider/model code → name 매핑을 위해 common_code 일괄 조회
  const providerCodes = [...new Set(messages.map(m => m.provider).filter(Boolean))];
  const modelCodes = [...new Set(messages.map(m => m.model).filter(Boolean))];

  const [providers, models] = await Promise.all([
    this.prisma.common_code.findMany({ where: { category_code: 'provider', code: { in: providerCodes } } }),
    this.prisma.common_code.findMany({ where: { category_code: 'model', code: { in: modelCodes } } }),
  ]);

  const providerMap = Object.fromEntries(providers.map(p => [p.code, p.name]));
  const modelMap = Object.fromEntries(models.map(m => [m.code, m.name]));

  return messages.map(m => ({
    id: m.id,
    role: m.role,
    provider: m.provider ? { code: m.provider, name: providerMap[m.provider] ?? m.provider } : null,
    model: m.model ? { code: m.model, name: modelMap[m.model] ?? m.model } : null,
    content: m.content,
    createdAt: m.created_at,
  }));
}
```

- [x] T6. frontend chat/page.tsx — provider 이미지로 아바타 교체

- `Message` 인터페이스에 `provider: { code: string; name: string } | null` 추가
- AI 아바타: `/image/provider/thumb/${provider.code}.png` — 없으면 "?" fallback

```tsx
{msg.role === 'assistant' && (
  <div className="w-8 h-8 rounded-full overflow-hidden bg-gray-200 flex items-center justify-center text-xs font-bold mr-2 flex-shrink-0 self-end">
    {msg.provider ? (
      <img
        src={`/image/provider/thumb/${msg.provider.code}.png`}
        alt={msg.provider.name}
        className="w-full h-full object-cover"
        onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement!.textContent = '?'; }}
      />
    ) : '?'}
  </div>
)}
```

- [x] T7. frontend profile/page.tsx — UserProfile.model 타입 CodeDto로 업데이트

`model: string | null` → `model: { code: string; name: string } | null`

모델 표시명, 선택 라디오버튼 등 model.code / model.name으로 접근하도록 수정.

---

## 참고

- 기존 메시지 DB의 `provider = 'ollama'` 데이터는 CodeDto 변환 시 name fallback으로 code 그대로 표시됨 (별도 마이그레이션 불필요)
- 서빙 인프라(Ollama)는 model.service.ts 내부에만 존재, API response에 노출 안 됨
