CREATE OR REPLACE FUNCTION delete_memory_version(p_memory_id uuid)
RETURNS void AS $$
DECLARE
  v_parent_id uuid;
BEGIN
  SELECT parent_memory_id INTO v_parent_id FROM memory WHERE id = p_memory_id;

  DELETE FROM memory__keyword WHERE memory_id = p_memory_id;
  DELETE FROM memory_content__message WHERE memory_content_id IN (
    SELECT id FROM memory_content WHERE memory_id = p_memory_id
  );
  DELETE FROM memory_content WHERE memory_id = p_memory_id;

  IF v_parent_id IS NOT NULL THEN
    UPDATE memory SET is_active = true, deactivated_at = NULL WHERE id = v_parent_id;
  END IF;

  DELETE FROM memory WHERE id = p_memory_id;
END;
$$ LANGUAGE plpgsql;

SELECT delete_memory_version('cf4c2f77-4582-4e6d-b448-cada3d05b00d');