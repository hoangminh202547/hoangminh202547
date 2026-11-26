-- ============================================================================
-- Migration 003: Hardening & Fix Row Level Security (RLS) across all 14 ERP tables & Storage
-- Idempotent & Zero-Data-Loss: Safe to run on top of schema.sql + 002_full_erp.sql
-- Keeps RLS strictly enabled on ALL tables; zero permissive USING (true) / WITH CHECK (true).
-- ============================================================================

-- 1. Harden current_user_email() with auth.users fallback if JWT email claim is omitted
CREATE OR REPLACE FUNCTION public.current_user_email()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT LOWER(TRIM(COALESCE(
    NULLIF(auth.jwt() ->> 'email', ''),
    (SELECT u.email FROM auth.users u WHERE u.id = auth.uid()),
    ''
  )));
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.current_user_email() = 'hoangminh202547@gmail.com';
$$;

CREATE OR REPLACE FUNCTION public.has_active_access()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
    );
$$;

CREATE OR REPLACE FUNCTION public.is_store_manager()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND ua.role = 'store_manager'
    );
$$;

CREATE OR REPLACE FUNCTION public.is_supervisor_or_manager()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND ua.role IN ('store_manager', 'supervisor')
    );
$$;

CREATE OR REPLACE FUNCTION public.is_lead_or_above()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND ua.role IN ('store_manager', 'supervisor', 'shift_lead')
    );
$$;

CREATE OR REPLACE FUNCTION public.can_scope_all()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND (ua.scope_all = true OR ua.role IN ('store_manager', 'supervisor', 'shift_lead'))
    );
$$;

CREATE OR REPLACE FUNCTION public.can_approve_schedules()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND (ua.schedule_approve = true OR ua.role IN ('store_manager', 'supervisor', 'shift_lead'))
    );
$$;

-- 2. Normalize email on INSERT as well as UPDATE/DELETE for user_access & protect super admin
CREATE OR REPLACE FUNCTION public.protect_super_admin_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF LOWER(TRIM(OLD.email)) = 'hoangminh202547@gmail.com' THEN
      RAISE EXCEPTION 'Không thể xóa tài khoản Quản lý siêu thị gốc.';
    END IF;
    RETURN OLD;
  END IF;

  NEW.email := LOWER(TRIM(NEW.email));
  IF NEW.email = 'hoangminh202547@gmail.com' THEN
    NEW.role := 'store_manager';
    NEW.active := true;
    NEW.scope_all := true;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := COALESCE(NEW.created_at, NOW());
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_access_protect ON public.user_access;
CREATE TRIGGER trg_user_access_protect
  BEFORE INSERT OR UPDATE OR DELETE ON public.user_access
  FOR EACH ROW EXECUTE FUNCTION public.protect_super_admin_access();

-- Normalize email on user_profiles before write so LOWER(email) = current_user_email() stays consistent
CREATE OR REPLACE FUNCTION public.normalize_user_profile_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.email := LOWER(TRIM(NEW.email));
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_profiles_normalize ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_normalize
  BEFORE INSERT OR UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.normalize_user_profile_row();

-- 3. Ensure RLS is strictly enabled on all 14 public tables
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.barcode_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_feedbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expiry_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 4. Rebuilt Explicit Policies (SELECT / INSERT / UPDATE / DELETE)
-- ============================================================================

-- A. user_profiles
DROP POLICY IF EXISTS "Profiles read own or manager" ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles read active team" ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles insert own" ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles update own" ON public.user_profiles;

CREATE POLICY "Profiles read active team"
  ON public.user_profiles FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR LOWER(TRIM(email)) = public.current_user_email()
    OR public.has_active_access()
  );

CREATE POLICY "Profiles insert own"
  ON public.user_profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    id = auth.uid()
    AND LOWER(TRIM(email)) = public.current_user_email()
  );

CREATE POLICY "Profiles update own"
  ON public.user_profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND LOWER(TRIM(email)) = public.current_user_email()
  );

-- B. user_access (RBAC strictly store_manager for mutations; self-read for login resolution)
DROP POLICY IF EXISTS "Access read own or manager" ON public.user_access;
DROP POLICY IF EXISTS "Access insert store_manager only" ON public.user_access;
DROP POLICY IF EXISTS "Access update store_manager only" ON public.user_access;
DROP POLICY IF EXISTS "Access delete store_manager only" ON public.user_access;

CREATE POLICY "Access read own or manager"
  ON public.user_access FOR SELECT
  TO authenticated
  USING (
    LOWER(TRIM(email)) = public.current_user_email()
    OR public.is_store_manager()
  );

CREATE POLICY "Access insert store_manager only"
  ON public.user_access FOR INSERT
  TO authenticated
  WITH CHECK (public.is_store_manager());

CREATE POLICY "Access update store_manager only"
  ON public.user_access FOR UPDATE
  TO authenticated
  USING (public.is_store_manager())
  WITH CHECK (public.is_store_manager());

CREATE POLICY "Access delete store_manager only"
  ON public.user_access FOR DELETE
  TO authenticated
  USING (
    public.is_store_manager()
    AND LOWER(TRIM(email)) <> 'hoangminh202547@gmail.com'
  );

-- C. barcode_scans (Fix supervisor/team migration INSERT + explicit owner/scope checks)
DROP POLICY IF EXISTS "Barcode select by permission" ON public.barcode_scans;
DROP POLICY IF EXISTS "Barcode insert by permission" ON public.barcode_scans;
DROP POLICY IF EXISTS "Barcode update by permission" ON public.barcode_scans;
DROP POLICY IF EXISTS "Barcode delete by permission" ON public.barcode_scans;

CREATE POLICY "Barcode select by permission"
  ON public.barcode_scans FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND ua.barcode_view = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(TRIM(barcode_scans.owner_email)) = public.current_user_email()
          OR barcode_scans.owner_id = auth.uid()::text
        )
    )
  );

CREATE POLICY "Barcode insert by permission"
  ON public.barcode_scans FOR INSERT
  TO authenticated
  WITH CHECK (
    (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.user_access ua
        WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
          AND ua.active = true
          AND ua.barcode_create = true
      )
    )
    AND (
      LOWER(TRIM(owner_email)) = public.current_user_email()
      OR owner_id = auth.uid()::text
      OR public.can_scope_all()
    )
  );

CREATE POLICY "Barcode update by permission"
  ON public.barcode_scans FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND ua.barcode_edit = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(TRIM(barcode_scans.owner_email)) = public.current_user_email()
          OR barcode_scans.owner_id = auth.uid()::text
        )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND ua.barcode_edit = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(TRIM(barcode_scans.owner_email)) = public.current_user_email()
          OR barcode_scans.owner_id = auth.uid()::text
        )
    )
  );

CREATE POLICY "Barcode delete by permission"
  ON public.barcode_scans FOR DELETE
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND ua.barcode_delete = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(TRIM(barcode_scans.owner_email)) = public.current_user_email()
          OR barcode_scans.owner_id = auth.uid()::text
        )
    )
  );

-- D. work_schedules
DROP POLICY IF EXISTS "Schedule select by permission" ON public.work_schedules;
DROP POLICY IF EXISTS "Schedule insert by permission" ON public.work_schedules;
DROP POLICY IF EXISTS "Schedule update by permission" ON public.work_schedules;
DROP POLICY IF EXISTS "Schedule delete by permission" ON public.work_schedules;

CREATE POLICY "Schedule select by permission"
  ON public.work_schedules FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND ua.schedule_view = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(TRIM(work_schedules.owner_email)) = public.current_user_email()
          OR work_schedules.owner_id = auth.uid()::text
        )
    )
  );

CREATE POLICY "Schedule insert by permission"
  ON public.work_schedules FOR INSERT
  TO authenticated
  WITH CHECK (
    (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.user_access ua
        WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
          AND ua.active = true
          AND ua.schedule_create = true
      )
    )
    AND (
      LOWER(TRIM(owner_email)) = public.current_user_email()
      OR owner_id = auth.uid()::text
      OR public.can_scope_all()
    )
  );

CREATE POLICY "Schedule update by permission"
  ON public.work_schedules FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND (ua.schedule_edit = true OR ua.schedule_approve = true)
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(TRIM(work_schedules.owner_email)) = public.current_user_email()
          OR work_schedules.owner_id = auth.uid()::text
        )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND (ua.schedule_edit = true OR ua.schedule_approve = true)
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(TRIM(work_schedules.owner_email)) = public.current_user_email()
          OR work_schedules.owner_id = auth.uid()::text
        )
    )
  );

CREATE POLICY "Schedule delete by permission"
  ON public.work_schedules FOR DELETE
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND ua.schedule_delete = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(TRIM(work_schedules.owner_email)) = public.current_user_email()
          OR work_schedules.owner_id = auth.uid()::text
        )
    )
  );

-- E. activity_logs (append-only for active users)
DROP POLICY IF EXISTS "Activity select by permission" ON public.activity_logs;
DROP POLICY IF EXISTS "Activity insert by authenticated active user" ON public.activity_logs;

CREATE POLICY "Activity select by permission"
  ON public.activity_logs FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(TRIM(ua.email)) = public.current_user_email()
        AND ua.active = true
        AND (
          ua.activity_view = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(TRIM(activity_logs.actor_email)) = public.current_user_email()
          OR activity_logs.actor_id = auth.uid()::text
        )
    )
  );

CREATE POLICY "Activity insert by authenticated active user"
  ON public.activity_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_active_access()
    AND (
      LOWER(TRIM(actor_email)) = public.current_user_email()
      OR actor_id = auth.uid()::text
    )
  );

-- F. system_settings (Split FOR ALL into explicit INSERT/UPDATE/DELETE for store_manager)
DROP POLICY IF EXISTS "Settings read active" ON public.system_settings;
DROP POLICY IF EXISTS "Settings write manager" ON public.system_settings;
DROP POLICY IF EXISTS "Settings insert manager" ON public.system_settings;
DROP POLICY IF EXISTS "Settings update manager" ON public.system_settings;
DROP POLICY IF EXISTS "Settings delete manager" ON public.system_settings;

CREATE POLICY "Settings read active"
  ON public.system_settings FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Settings insert manager"
  ON public.system_settings FOR INSERT
  TO authenticated
  WITH CHECK (public.is_store_manager());

CREATE POLICY "Settings update manager"
  ON public.system_settings FOR UPDATE
  TO authenticated
  USING (public.is_store_manager())
  WITH CHECK (public.is_store_manager());

CREATE POLICY "Settings delete manager"
  ON public.system_settings FOR DELETE
  TO authenticated
  USING (public.is_store_manager());

-- G. shift_definitions (Fix shift_lead & schedule_approve access matching "Thiết lập ca" UI)
DROP POLICY IF EXISTS "Shifts read active" ON public.shift_definitions;
DROP POLICY IF EXISTS "Shifts write manager" ON public.shift_definitions;
DROP POLICY IF EXISTS "Shifts insert approver" ON public.shift_definitions;
DROP POLICY IF EXISTS "Shifts update approver" ON public.shift_definitions;
DROP POLICY IF EXISTS "Shifts delete approver" ON public.shift_definitions;

CREATE POLICY "Shifts read active"
  ON public.shift_definitions FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Shifts insert approver"
  ON public.shift_definitions FOR INSERT
  TO authenticated
  WITH CHECK (public.is_supervisor_or_manager() OR public.can_approve_schedules());

CREATE POLICY "Shifts update approver"
  ON public.shift_definitions FOR UPDATE
  TO authenticated
  USING (public.is_supervisor_or_manager() OR public.can_approve_schedules())
  WITH CHECK (public.is_supervisor_or_manager() OR public.can_approve_schedules());

CREATE POLICY "Shifts delete approver"
  ON public.shift_definitions FOR DELETE
  TO authenticated
  USING (public.is_supervisor_or_manager() OR public.can_approve_schedules());

-- H. attendance_logs (Ensure active check on self update + owner_id fallback)
DROP POLICY IF EXISTS "Attendance select" ON public.attendance_logs;
DROP POLICY IF EXISTS "Attendance insert" ON public.attendance_logs;
DROP POLICY IF EXISTS "Attendance update" ON public.attendance_logs;
DROP POLICY IF EXISTS "Attendance delete" ON public.attendance_logs;

CREATE POLICY "Attendance select"
  ON public.attendance_logs FOR SELECT
  TO authenticated
  USING (
    public.is_lead_or_above()
    OR (
      public.has_active_access()
      AND (
        LOWER(TRIM(owner_email)) = public.current_user_email()
        OR owner_id = auth.uid()::text
      )
    )
  );

CREATE POLICY "Attendance insert"
  ON public.attendance_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_active_access()
    AND (
      LOWER(TRIM(owner_email)) = public.current_user_email()
      OR owner_id = auth.uid()::text
      OR public.is_store_manager()
    )
  );

CREATE POLICY "Attendance update"
  ON public.attendance_logs FOR UPDATE
  TO authenticated
  USING (
    public.is_lead_or_above()
    OR (
      public.has_active_access()
      AND (
        LOWER(TRIM(owner_email)) = public.current_user_email()
        OR owner_id = auth.uid()::text
      )
    )
  )
  WITH CHECK (
    public.is_lead_or_above()
    OR (
      public.has_active_access()
      AND (
        LOWER(TRIM(owner_email)) = public.current_user_email()
        OR owner_id = auth.uid()::text
      )
    )
  );

CREATE POLICY "Attendance delete"
  ON public.attendance_logs FOR DELETE
  TO authenticated
  USING (public.is_store_manager());

-- I. customer_feedbacks (Require active access for self delete + owner_id fallback)
DROP POLICY IF EXISTS "Feedback select" ON public.customer_feedbacks;
DROP POLICY IF EXISTS "Feedback insert" ON public.customer_feedbacks;
DROP POLICY IF EXISTS "Feedback delete" ON public.customer_feedbacks;

CREATE POLICY "Feedback select"
  ON public.customer_feedbacks FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Feedback insert"
  ON public.customer_feedbacks FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_active_access()
    AND (
      LOWER(TRIM(owner_email)) = public.current_user_email()
      OR owner_id = auth.uid()::text
      OR public.is_store_manager()
    )
  );

CREATE POLICY "Feedback delete"
  ON public.customer_feedbacks FOR DELETE
  TO authenticated
  USING (
    public.is_supervisor_or_manager()
    OR (
      public.has_active_access()
      AND (
        LOWER(TRIM(owner_email)) = public.current_user_email()
        OR owner_id = auth.uid()::text
      )
    )
  );

-- J. product_catalog (Split FOR ALL into explicit INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS "Catalog select" ON public.product_catalog;
DROP POLICY IF EXISTS "Catalog write" ON public.product_catalog;
DROP POLICY IF EXISTS "Catalog insert" ON public.product_catalog;
DROP POLICY IF EXISTS "Catalog update" ON public.product_catalog;
DROP POLICY IF EXISTS "Catalog delete" ON public.product_catalog;

CREATE POLICY "Catalog select"
  ON public.product_catalog FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Catalog insert"
  ON public.product_catalog FOR INSERT
  TO authenticated
  WITH CHECK (public.is_lead_or_above());

CREATE POLICY "Catalog update"
  ON public.product_catalog FOR UPDATE
  TO authenticated
  USING (public.is_lead_or_above())
  WITH CHECK (public.is_lead_or_above());

CREATE POLICY "Catalog delete"
  ON public.product_catalog FOR DELETE
  TO authenticated
  USING (public.is_lead_or_above());

-- K. supplier_policies (Split FOR ALL into explicit INSERT/UPDATE/DELETE)
DROP POLICY IF EXISTS "Policies select" ON public.supplier_policies;
DROP POLICY IF EXISTS "Policies write" ON public.supplier_policies;
DROP POLICY IF EXISTS "Policies insert" ON public.supplier_policies;
DROP POLICY IF EXISTS "Policies update" ON public.supplier_policies;
DROP POLICY IF EXISTS "Policies delete" ON public.supplier_policies;

CREATE POLICY "Policies select"
  ON public.supplier_policies FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Policies insert"
  ON public.supplier_policies FOR INSERT
  TO authenticated
  WITH CHECK (public.is_lead_or_above());

CREATE POLICY "Policies update"
  ON public.supplier_policies FOR UPDATE
  TO authenticated
  USING (public.is_lead_or_above())
  WITH CHECK (public.is_lead_or_above());

CREATE POLICY "Policies delete"
  ON public.supplier_policies FOR DELETE
  TO authenticated
  USING (public.is_lead_or_above());

-- L. expiry_tracking
DROP POLICY IF EXISTS "Expiry select" ON public.expiry_tracking;
DROP POLICY IF EXISTS "Expiry insert" ON public.expiry_tracking;
DROP POLICY IF EXISTS "Expiry update" ON public.expiry_tracking;
DROP POLICY IF EXISTS "Expiry delete" ON public.expiry_tracking;

CREATE POLICY "Expiry select"
  ON public.expiry_tracking FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Expiry insert"
  ON public.expiry_tracking FOR INSERT
  TO authenticated
  WITH CHECK (public.has_active_access());

CREATE POLICY "Expiry update"
  ON public.expiry_tracking FOR UPDATE
  TO authenticated
  USING (public.has_active_access())
  WITH CHECK (public.has_active_access());

CREATE POLICY "Expiry delete"
  ON public.expiry_tracking FOR DELETE
  TO authenticated
  USING (public.is_supervisor_or_manager());

-- M. return_records
DROP POLICY IF EXISTS "Returns select" ON public.return_records;
DROP POLICY IF EXISTS "Returns insert" ON public.return_records;
DROP POLICY IF EXISTS "Returns update" ON public.return_records;
DROP POLICY IF EXISTS "Returns delete" ON public.return_records;

CREATE POLICY "Returns select"
  ON public.return_records FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Returns insert"
  ON public.return_records FOR INSERT
  TO authenticated
  WITH CHECK (public.has_active_access());

CREATE POLICY "Returns update"
  ON public.return_records FOR UPDATE
  TO authenticated
  USING (public.has_active_access())
  WITH CHECK (public.has_active_access());

CREATE POLICY "Returns delete"
  ON public.return_records FOR DELETE
  TO authenticated
  USING (public.is_supervisor_or_manager());

-- N. promotions
DROP POLICY IF EXISTS "Promotions select" ON public.promotions;
DROP POLICY IF EXISTS "Promotions insert" ON public.promotions;
DROP POLICY IF EXISTS "Promotions update" ON public.promotions;
DROP POLICY IF EXISTS "Promotions delete" ON public.promotions;

CREATE POLICY "Promotions select"
  ON public.promotions FOR SELECT
  TO authenticated
  USING (public.has_active_access());

CREATE POLICY "Promotions insert"
  ON public.promotions FOR INSERT
  TO authenticated
  WITH CHECK (public.is_lead_or_above());

CREATE POLICY "Promotions update"
  ON public.promotions FOR UPDATE
  TO authenticated
  USING (public.is_lead_or_above())
  WITH CHECK (public.is_lead_or_above());

CREATE POLICY "Promotions delete"
  ON public.promotions FOR DELETE
  TO authenticated
  USING (public.is_supervisor_or_manager());

-- O. Storage (internal-media): Add missing UPDATE policy + tighten active check on DELETE
DROP POLICY IF EXISTS "Internal media read active" ON storage.objects;
DROP POLICY IF EXISTS "Internal media insert own folder" ON storage.objects;
DROP POLICY IF EXISTS "Internal media update own or admin" ON storage.objects;
DROP POLICY IF EXISTS "Internal media delete own or admin" ON storage.objects;

CREATE POLICY "Internal media read active"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'internal-media' AND public.has_active_access());

CREATE POLICY "Internal media insert own folder"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'internal-media'
    AND public.has_active_access()
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Internal media update own or admin"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'internal-media'
    AND (
      (public.has_active_access() AND (storage.foldername(name))[1] = auth.uid()::text)
      OR public.is_supervisor_or_manager()
    )
  )
  WITH CHECK (
    bucket_id = 'internal-media'
    AND (
      (public.has_active_access() AND (storage.foldername(name))[1] = auth.uid()::text)
      OR public.is_supervisor_or_manager()
    )
  );

CREATE POLICY "Internal media delete own or admin"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'internal-media'
    AND (
      (public.has_active_access() AND (storage.foldername(name))[1] = auth.uid()::text)
      OR public.is_supervisor_or_manager()
    )
  );
