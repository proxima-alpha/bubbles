CREATE OR REPLACE FUNCTION delete_memory_version(p_memory_id uuid)
RETURNS void AS $$
DECLARE
  v_parent_id uuid;
BEGIN
  SELECT parent_memory_id INTO v_parent_id FROM memory WHERE id = p_memory_id;

  DELETE FROM memory__keyword WHERE memory_id = p_memory_id;

  -- 이 버전에서만 쓰이던(다른 버전 조인이 하나도 안 남는) content만 실제 삭제
  DELETE FROM memory_content__message WHERE memory_content_id IN (
    SELECT mmc.memory_content_id FROM memory__memory_content mmc
    WHERE mmc.memory_id = p_memory_id
      AND NOT EXISTS (
        SELECT 1 FROM memory__memory_content other
        WHERE other.memory_content_id = mmc.memory_content_id AND other.memory_id <> p_memory_id
      )
  );
  DELETE FROM memory_content WHERE id IN (
    SELECT mmc.memory_content_id FROM memory__memory_content mmc
    WHERE mmc.memory_id = p_memory_id
      AND NOT EXISTS (
        SELECT 1 FROM memory__memory_content other
        WHERE other.memory_content_id = mmc.memory_content_id AND other.memory_id <> p_memory_id
      )
  );
  DELETE FROM memory__memory_content WHERE memory_id = p_memory_id;

  IF v_parent_id IS NOT NULL THEN
    UPDATE memory SET is_active = true, deactivated_at = NULL WHERE id = v_parent_id;
  END IF;

  DELETE FROM memory WHERE id = p_memory_id;
END;
$$ LANGUAGE plpgsql;

SELECT delete_memory_version('cf4c2f77-4582-4e6d-b448-cada3d05b00d');