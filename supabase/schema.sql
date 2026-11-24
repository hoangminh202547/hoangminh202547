-- ============================================================================
-- ScanShift / Vận Hành TPCN — Supabase PostgreSQL Schema, RLS & Realtime
-- Chạy toàn bộ file SQL này trong Supabase Dashboard -> SQL Editor
-- ============================================================================

-- 1. Bảng hồ sơ người dùng liên kết với Supabase Auth
CREATE TABLE IF NOT EXISTS public.user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Bảng phân quyền RBAC tập trung (4 vai trò + phân quyền chi tiết theo phân hệ)
CREATE TABLE IF NOT EXISTS public.user_access (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'staff'
    CHECK (role IN ('store_manager', 'supervisor', 'shift_lead', 'staff')),
  active BOOLEAN NOT NULL DEFAULT true,
  scope_all BOOLEAN NOT NULL DEFAULT false,
  -- Phân hệ Quét & Xuất mã vạch
  barcode_view BOOLEAN NOT NULL DEFAULT true,
  barcode_create BOOLEAN NOT NULL DEFAULT true,
  barcode_edit BOOLEAN NOT NULL DEFAULT true,
  barcode_delete BOOLEAN NOT NULL DEFAULT false,
  -- Phân hệ Lịch làm việc
  schedule_view BOOLEAN NOT NULL DEFAULT true,
  schedule_create BOOLEAN NOT NULL DEFAULT true,
  schedule_edit BOOLEAN NOT NULL DEFAULT true,
  schedule_delete BOOLEAN NOT NULL DEFAULT false,
  schedule_approve BOOLEAN NOT NULL DEFAULT false,
  -- Xuất báo cáo, Nhật ký & Quản trị hệ thống
  allow_export BOOLEAN NOT NULL DEFAULT true,
  activity_view BOOLEAN NOT NULL DEFAULT false,
  allow_supabase BOOLEAN NOT NULL DEFAULT false,
  note TEXT NOT NULL DEFAULT '',
  granted_by TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Bảng Quét mã vạch tập trung (có version để phát hiện xung đột)
CREATE TABLE IF NOT EXISTS public.barcode_scans (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  code TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'BARCODE',
  session_name TEXT NOT NULL DEFAULT 'Mặc định',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1 AND quantity <= 999999),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT '',
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barcode_scans_owner_email ON public.barcode_scans (owner_email);
CREATE INDEX IF NOT EXISTS idx_barcode_scans_updated_at ON public.barcode_scans (updated_at DESC);

-- 4. Bảng Lịch làm việc tập trung (có phê duyệt & version)
CREATE TABLE IF NOT EXISTS public.work_schedules (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  title TEXT NOT NULL,
  work_date TEXT NOT NULL,
  shift_type TEXT NOT NULL CHECK (shift_type IN ('morning', 'afternoon', 'evening', 'full_day', 'custom')),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'confirmed', 'completed', 'cancelled')),
  note TEXT NOT NULL DEFAULT '',
  approved_by TEXT NOT NULL DEFAULT '',
  approved_at TIMESTAMPTZ NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_schedules_work_date ON public.work_schedules (work_date, start_time);
CREATE INDEX IF NOT EXISTS idx_work_schedules_owner_email ON public.work_schedules (owner_email);

-- 5. Bảng Nhật ký hoạt động (chỉ ghi thêm, không sửa/xóa)
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT 'staff',
  module TEXT NOT NULL CHECK (module IN ('barcode', 'schedule', 'access', 'system', 'export')),
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'approve', 'cancel', 'export', 'sync', 'migrate')),
  target_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON public.activity_logs (created_at DESC);

-- ============================================================================
-- Seed tài khoản Quản lý siêu thị gốc (Super Admin)
-- ============================================================================
INSERT INTO public.user_access (
  id, email, display_name, role, active, scope_all,
  barcode_view, barcode_create, barcode_edit, barcode_delete,
  schedule_view, schedule_create, schedule_edit, schedule_delete, schedule_approve,
  allow_export, activity_view, allow_supabase, note, granted_by
)
VALUES (
  'hoangminh202547_at_gmail_dot_com',
  'hoangminh202547@gmail.com',
  'Quản lý siêu thị (Gốc)',
  'store_manager',
  true,
  true,
  true, true, true, true,
  true, true, true, true, true,
  true, true, true,
  'Tài khoản quản trị gốc hệ thống',
  'system'
)
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- Functions kiểm tra quyền tại Database (chống nâng quyền từ client)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.current_user_email()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT LOWER(TRIM(COALESCE(auth.jwt() ->> 'email', '')));
$$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_user_email() = 'hoangminh202547@gmail.com';
$$;

CREATE OR REPLACE FUNCTION public.get_my_access()
RETURNS public.user_access
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ua.*
  FROM public.user_access ua
  WHERE LOWER(ua.email) = public.current_user_email()
    AND ua.active = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_store_manager()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND ua.role = 'store_manager'
    );
$$;

CREATE OR REPLACE FUNCTION public.can_scope_all()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND (ua.scope_all = true OR ua.role IN ('store_manager', 'supervisor', 'shift_lead'))
    );
$$;

-- Trigger tự động cập nhật updated_at và chặn sửa quyền tài khoản gốc
CREATE OR REPLACE FUNCTION public.touch_updated_at_and_protect_admin()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.protect_super_admin_access()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF LOWER(OLD.email) = 'hoangminh202547@gmail.com' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Không thể xóa tài khoản Quản lý siêu thị gốc.';
    END IF;
    NEW.role := 'store_manager';
    NEW.active := true;
    NEW.scope_all := true;
  END IF;
  NEW.email := LOWER(TRIM(NEW.email));
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_access_protect ON public.user_access;
CREATE TRIGGER trg_user_access_protect
  BEFORE UPDATE OR DELETE ON public.user_access
  FOR EACH ROW EXECUTE FUNCTION public.protect_super_admin_access();

DROP TRIGGER IF EXISTS trg_barcode_touch ON public.barcode_scans;
CREATE TRIGGER trg_barcode_touch
  BEFORE UPDATE ON public.barcode_scans
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_and_protect_admin();

DROP TRIGGER IF EXISTS trg_schedule_touch ON public.work_schedules;
CREATE TRIGGER trg_schedule_touch
  BEFORE UPDATE ON public.work_schedules
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_and_protect_admin();

-- Trigger bảo vệ quy trình phê duyệt lịch làm việc (người không có schedule_approve không được chuyển sang confirmed/completed)
CREATE OR REPLACE FUNCTION public.enforce_schedule_approval_perm()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_can_approve BOOLEAN;
BEGIN
  IF public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(ua.schedule_approve, false) OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
  INTO v_can_approve
  FROM public.user_access ua
  WHERE LOWER(ua.email) = public.current_user_email()
    AND ua.active = true
  LIMIT 1;

  IF TG_OP = 'INSERT' AND NEW.status IN ('confirmed', 'completed') AND NOT COALESCE(v_can_approve, false) THEN
    RAISE EXCEPTION 'Bạn không có quyền tạo lịch ở trạng thái đã phê duyệt.';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('confirmed', 'completed') AND NOT COALESCE(v_can_approve, false) THEN
      RAISE EXCEPTION 'Bạn không có quyền phê duyệt hoặc xác nhận hoàn thành ca làm.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_schedule_approval_perm ON public.work_schedules;
CREATE TRIGGER trg_schedule_approval_perm
  BEFORE INSERT OR UPDATE ON public.work_schedules
  FOR EACH ROW EXECUTE FUNCTION public.enforce_schedule_approval_perm();

-- ============================================================================
-- Bật Row Level Security (RLS) cho TOÀN BỘ bảng
-- ============================================================================
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.barcode_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;

-- Xóa policy cũ nếu chạy lại script
DROP POLICY IF EXISTS "Profiles read own or manager" ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles insert own" ON public.user_profiles;
DROP POLICY IF EXISTS "Profiles update own" ON public.user_profiles;

DROP POLICY IF EXISTS "Access read own or manager" ON public.user_access;
DROP POLICY IF EXISTS "Access insert store_manager only" ON public.user_access;
DROP POLICY IF EXISTS "Access update store_manager only" ON public.user_access;
DROP POLICY IF EXISTS "Access delete store_manager only" ON public.user_access;

DROP POLICY IF EXISTS "Barcode select by permission" ON public.barcode_scans;
DROP POLICY IF EXISTS "Barcode insert by permission" ON public.barcode_scans;
DROP POLICY IF EXISTS "Barcode update by permission" ON public.barcode_scans;
DROP POLICY IF EXISTS "Barcode delete by permission" ON public.barcode_scans;

DROP POLICY IF EXISTS "Schedule select by permission" ON public.work_schedules;
DROP POLICY IF EXISTS "Schedule insert by permission" ON public.work_schedules;
DROP POLICY IF EXISTS "Schedule update by permission" ON public.work_schedules;
DROP POLICY IF EXISTS "Schedule delete by permission" ON public.work_schedules;

DROP POLICY IF EXISTS "Activity select by permission" ON public.activity_logs;
DROP POLICY IF EXISTS "Activity insert by authenticated active user" ON public.activity_logs;

-- Policies: user_profiles
CREATE POLICY "Profiles read own or manager"
  ON public.user_profiles FOR SELECT
  TO authenticated
  USING (id = auth.uid() OR public.is_store_manager() OR public.can_scope_all());

CREATE POLICY "Profiles insert own"
  ON public.user_profiles FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid() AND LOWER(email) = public.current_user_email());

CREATE POLICY "Profiles update own"
  ON public.user_profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND LOWER(email) = public.current_user_email());

-- Policies: user_access (chỉ Quản lý siêu thị được thêm/sửa/xóa phân quyền; người dùng chỉ đọc quyền của chính mình)
CREATE POLICY "Access read own or manager"
  ON public.user_access FOR SELECT
  TO authenticated
  USING (LOWER(email) = public.current_user_email() OR public.is_store_manager());

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
  USING (public.is_store_manager() AND LOWER(email) <> 'hoangminh202547@gmail.com');

-- Policies: barcode_scans
CREATE POLICY "Barcode select by permission"
  ON public.barcode_scans FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND ua.barcode_view = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(barcode_scans.owner_email) = public.current_user_email()
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
        WHERE LOWER(ua.email) = public.current_user_email()
          AND ua.active = true
          AND ua.barcode_create = true
      )
    )
    AND (LOWER(owner_email) = public.current_user_email() OR public.is_store_manager())
  );

CREATE POLICY "Barcode update by permission"
  ON public.barcode_scans FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND ua.barcode_edit = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(barcode_scans.owner_email) = public.current_user_email()
          OR barcode_scans.owner_id = auth.uid()::text
        )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND ua.barcode_edit = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(barcode_scans.owner_email) = public.current_user_email()
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
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND ua.barcode_delete = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(barcode_scans.owner_email) = public.current_user_email()
          OR barcode_scans.owner_id = auth.uid()::text
        )
    )
  );

-- Policies: work_schedules
CREATE POLICY "Schedule select by permission"
  ON public.work_schedules FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND ua.schedule_view = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(work_schedules.owner_email) = public.current_user_email()
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
        WHERE LOWER(ua.email) = public.current_user_email()
          AND ua.active = true
          AND ua.schedule_create = true
      )
    )
    AND (LOWER(owner_email) = public.current_user_email() OR public.can_scope_all())
  );

CREATE POLICY "Schedule update by permission"
  ON public.work_schedules FOR UPDATE
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND (ua.schedule_edit = true OR ua.schedule_approve = true)
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(work_schedules.owner_email) = public.current_user_email()
          OR work_schedules.owner_id = auth.uid()::text
        )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND (ua.schedule_edit = true OR ua.schedule_approve = true)
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(work_schedules.owner_email) = public.current_user_email()
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
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND ua.schedule_delete = true
        AND (
          ua.scope_all = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(work_schedules.owner_email) = public.current_user_email()
          OR work_schedules.owner_id = auth.uid()::text
        )
    )
  );

-- Policies: activity_logs (chỉ append-only, không UPDATE/DELETE)
CREATE POLICY "Activity select by permission"
  ON public.activity_logs FOR SELECT
  TO authenticated
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.user_access ua
      WHERE LOWER(ua.email) = public.current_user_email()
        AND ua.active = true
        AND (
          ua.activity_view = true
          OR ua.role IN ('store_manager', 'supervisor', 'shift_lead')
          OR LOWER(activity_logs.actor_email) = public.current_user_email()
        )
    )
  );

CREATE POLICY "Activity insert by authenticated active user"
  ON public.activity_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    LOWER(actor_email) = public.current_user_email()
    AND (
      public.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM public.user_access ua
        WHERE LOWER(ua.email) = public.current_user_email()
          AND ua.active = true
      )
    )
  );

-- ============================================================================
-- Bật Supabase Realtime (Postgres Changes + REPLICA IDENTITY FULL)
-- ============================================================================
ALTER TABLE public.barcode_scans REPLICA IDENTITY FULL;
ALTER TABLE public.work_schedules REPLICA IDENTITY FULL;
ALTER TABLE public.user_access REPLICA IDENTITY FULL;
ALTER TABLE public.activity_logs REPLICA IDENTITY FULL;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['barcode_scans', 'work_schedules', 'user_access', 'activity_logs']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END
$$;
