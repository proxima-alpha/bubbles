## Project
Bubbles is a personal AI chat web app with RAG-based memory.

## Stack
- Frontend: Next.js 14, TypeScript, Tailwind, shadcn/ui, React Query, Axios
- Backend: NestJS, TypeScript, Prisma
- DB: PostgreSQL + pgvector
- Embedding: Ollama nomic-embed-text
- Infra: Docker Compose

## Rules
- Do not implement features outside the requested scope.
- Do not refactor unrelated code.
- Do not add dependencies without asking.
- Do not change architecture without asking.
- Keep changes small and spec-driven.
- Check existing code before adding new files.
- Update research.md before planning a spec.
- Write plans in specs/spec-NNN.md before coding.
- Only code after explicit /apply.
- Run tests only after explicit /test.
- Mock LLM calls in tests.

## Working Style
- Think before coding. State assumptions explicitly when they matter.
- If requirements are unclear or have multiple valid interpretations, ask instead of guessing.
- Prefer the simplest implementation that satisfies the request.
- Do not add speculative abstractions, configurability, or error handling for impossible scenarios.
- Make surgical changes only. Every changed line should trace directly to the request.
- Do not clean up unrelated code, comments, or formatting.
- Remove only the unused code created by your own change.
- For multi-step tasks, write a short goal-driven plan in the required spec and include a clear verification step.

## Backend
- Use NestJS modules/controllers/services.
- Use DTOs with class-validator.
- Use Prisma for DB access.
- Use @nestjs/config for env.
- Keep LLM providers behind an adapter interface.

## Frontend
- Use Next.js App Router.
- Prefer Server Components.
- Use Client Components only when state/events are needed.
- Use Axios + React Query for API calls.
- Prefer shadcn/ui components.

## Memory/RAG
- Do not store duplicate memories.
- User must be able to view, edit, and delete memories.
- Context should include system prompt, user settings, recent messages, relevant memories, and current input.
- Do not send full chat history every time.

## Completion Report
Report only:
- What changed
- What was checked
- One next step
