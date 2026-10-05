-- memory__memory_content에 created_at 누락됨(컨벤션: 모든 테이블에 created_at) — 추가
ALTER TABLE "memory__memory_content" ADD COLUMN "created_at" TIMESTAMPTZ NOT NULL DEFAULT now();
