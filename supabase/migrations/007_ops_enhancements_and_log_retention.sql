-- ============================================================================
-- Migration 007: Activity Log 60-Day Retention, Recent Warehouse Updates Index
--                & Active Staff Short-Name Directory Helper
-- Safe, additive & idempotent — preserves all existing operational data & RLS.
-- ============================================================================

-- 1. Purge activity_logs older than 60 days immediately
DELETE FROM public.activity_logs
WHERE created_at < NOW() - INTERVAL '60 days';

-- 2. Statement-level trigger to retain only the most recent 60 days of activity logs
CREATE OR REPLACE FUNCTION public.prune_old_activity_logs_60d()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.activity_logs
  WHERE created_at < NOW() - INTERVAL '60 days';
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_activity_logs_prune_60d ON public.activity_logs;
CREATE TRIGGER trg_activity_logs_prune_60d
  AFTER INSERT ON public.activity_logs
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.prune_old_activity_logs_60d();

-- 3. Indexes for fast recent updates & notification queries in Data Warehouse
CREATE INDEX IF NOT EXISTS idx_product_catalog_updated_at
  ON public.product_catalog (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_supplier_policies_updated_at
  ON public.supplier_policies (updated_at DESC);

-- 4. Active team directory helper (returns display_name & email of active staff)
--    Used by Expiry Control & Goods Return "Người PT" short-name selector
CREATE OR REPLACE FUNCTION public.get_authorized_staff_directory()
RETURNS TABLE (
  email TEXT,
  display_name TEXT,
  role TEXT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    LOWER(TRIM(ua.email)) AS email,
    COALESCE(
      NULLIF(TRIM(up.display_name), ''),
      NULLIF(TRIM(ua.display_name), ''),
      SPLIT_PART(LOWER(TRIM(ua.email)), '@', 1)
    ) AS display_name,
    ua.role
  FROM public.user_access ua
  LEFT JOIN public.user_profiles up
    ON LOWER(TRIM(up.email)) = LOWER(TRIM(ua.email))
  WHERE ua.active = true
    AND (SELECT public.has_active_access())
  ORDER BY display_name ASC;
$$;

REVOKE ALL ON FUNCTION public.get_authorized_staff_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_authorized_staff_directory() TO authenticated;

ANALYZE public.activity_logs;
ANALYZE public.product_catalog;
ANALYZE public.supplier_policies;

NOTIFY pgrst, 'reload schema';
