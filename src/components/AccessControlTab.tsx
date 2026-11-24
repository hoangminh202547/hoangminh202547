import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Edit3,
  Lock,
  MailPlus,
  Search,
  ShieldCheck,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import {
  ROLE_DEFAULT_PERMS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  SUPER_ADMIN_EMAIL,
  normalizeEmail,
} from '../lib/permissions';
import type { AuthorizedEmail, UserRole } from '../types';
import { ConfirmDialog } from './ConfirmDialog';

interface AccessControlTabProps {
  members: AuthorizedEmail[];
  loading: boolean;
  currentUserEmail: string;
  onSaveMember: (params: {
    email: string;
    displayName: string;
    role: UserRole;
    allowBarcode: boolean;
    allowSchedule: boolean;
    allowExport: boolean;
    allowSupabase: boolean;
    active: boolean;
    note: string;
    isEdit: boolean;
  }) => Promise<void>;
  onToggleActive: (member: AuthorizedEmail) => Promise<void>;
  onDeleteMember: (member: AuthorizedEmail) => Promise<void>;
  onNotify: (type: 'success' | 'error' | 'info', message: string) => void;
}

const ROLE_ORDER: UserRole[] = ['staff', 'manager', 'admin', 'viewer'];

export function AccessControlTab({
  members,
  loading,
  currentUserEmail,
  onSaveMember,
  onToggleActive,
  onDeleteMember,
  onNotify,
}: AccessControlTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | UserRole>('ALL');

  // Add/Edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<AuthorizedEmail | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [emailInput, setEmailInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [roleInput, setRoleInput] = useState<UserRole>('staff');
  const [allowBarcode, setAllowBarcode] = useState(true);
  const [allowSchedule, setAllowSchedule] = useState(true);
  const [allowExport, setAllowExport] = useState(true);
  const [allowSupabase, setAllowSupabase] = useState(false);
  const [activeInput, setActiveInput] = useState(true);
  const [noteInput, setNoteInput] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<AuthorizedEmail | null>(null);

  const openAddModal = () => {
    setEditingMember(null);
    setEmailInput('');
    setNameInput('');
    setRoleInput('staff');
    const defaults = ROLE_DEFAULT_PERMS.staff;
    setAllowBarcode(defaults.allowBarcode);
    setAllowSchedule(defaults.allowSchedule);
    setAllowExport(defaults.allowExport);
    setAllowSupabase(defaults.allowSupabase);
    setActiveInput(true);
    setNoteInput('');
    setModalOpen(true);
  };

  const openEditModal = (member: AuthorizedEmail) => {
    setEditingMember(member);
    setEmailInput(member.email);
    setNameInput(member.displayName);
    setRoleInput(member.role);
    setAllowBarcode(member.allowBarcode);
    setAllowSchedule(member.allowSchedule);
    setAllowExport(member.allowExport);
    setAllowSupabase(member.allowSupabase);
    setActiveInput(member.active);
    setNoteInput(member.note || '');
    setModalOpen(true);
  };

  const handleRoleChange = (nextRole: UserRole) => {
    setRoleInput(nextRole);
    const defaults = ROLE_DEFAULT_PERMS[nextRole];
    setAllowBarcode(defaults.allowBarcode);
    setAllowSchedule(defaults.allowSchedule);
    setAllowExport(defaults.allowExport);
    setAllowSupabase(defaults.allowSupabase);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = normalizeEmail(emailInput);
    if (!cleanEmail || !cleanEmail.includes('@')) {
      onNotify('error', 'Vui lòng nhập địa chỉ Gmail hợp lệ.');
      return;
    }
    if (!nameInput.trim()) {
      onNotify('error', 'Vui lòng nhập tên hiển thị cho tài khoản này.');
      return;
    }

    setSubmitting(true);
    try {
      await onSaveMember({
        email: cleanEmail,
        displayName: nameInput.trim(),
        role: roleInput,
        allowBarcode,
        allowSchedule,
        allowExport,
        allowSupabase,
        active: activeInput,
        note: noteInput.trim(),
        isEdit: Boolean(editingMember),
      });
      setModalOpen(false);
    } catch (err) {
      onNotify(
        'error',
        err instanceof Error ? err.message : 'Không thể lưu phân quyền.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const stats = useMemo(() => {
    const activeCount = members.filter((m) => m.active).length;
    const managerAdminCount = members.filter(
      (m) => m.active && (m.role === 'admin' || m.role === 'manager')
    ).length;
    const lockedCount = members.filter((m) => !m.active).length;
    return {
      total: members.length + 1, // +1 for bootstrapped Super Admin
      activeCount: activeCount + (members.some((m) => m.email === SUPER_ADMIN_EMAIL) ? 0 : 1),
      managerAdminCount:
        managerAdminCount + (members.some((m) => m.email === SUPER_ADMIN_EMAIL) ? 0 : 1),
      lockedCount,
    };
  }, [members]);

  const filteredMembers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return members.filter((m) => {
      const matchRole = roleFilter === 'ALL' || m.role === roleFilter;
      const matchSearch =
        !q ||
        m.email.toLowerCase().includes(q) ||
        m.displayName.toLowerCase().includes(q) ||
        m.note.toLowerCase().includes(q);
      return matchRole && matchSearch;
    });
  }, [members, roleFilter, searchQuery]);

  const renderPermissionSummary = (m: AuthorizedEmail) => {
    const list: string[] = [];
    if (m.role === 'viewer') {
      list.push('Chỉ xem');
      if (m.allowExport) list.push('Xuất Excel');
      return list.join(' · ');
    }
    if (m.allowBarcode) list.push('Quét mã vạch');
    if (m.allowSchedule) list.push('Lịch làm việc');
    if (m.allowExport) list.push('Xuất Excel');
    if (m.allowSupabase) list.push('Supabase');
    return list.length > 0 ? list.join(' · ') : 'Chưa bật tính năng';
  };

  return (
    <div className="space-y-6">
      {/* KPI summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Tổng email được cấp</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {stats.total}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Đang hoạt động</p>
          <p className="mt-1 text-2xl font-bold text-emerald-600 tabular-nums">
            {stats.activeCount}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Quản trị &amp; Quản lý</p>
          <p className="mt-1 text-2xl font-bold text-blue-600 tabular-nums">
            {stats.managerAdminCount}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-medium text-slate-500">Đang tạm khóa</p>
          <p className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
            {stats.lockedCount}
          </p>
        </div>
      </div>

      {/* Super Admin Reference Card */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-slate-900">
                Quản trị viên gốc (Super Admin)
              </h2>
              <span className="text-xs font-medium text-emerald-700">
                · Toàn quyền hệ thống
              </span>
            </div>
            <p className="mt-0.5 text-sm font-mono text-slate-700">
              {SUPER_ADMIN_EMAIL}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={openAddModal}
          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
        >
          <MailPlus className="h-4 w-4" />
          <span>Cấp quyền Gmail mới</span>
        </button>
      </div>

      {/* Filter + Member List */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm theo email hoặc tên nhân sự..."
              className="w-full min-h-[44px] pl-10 pr-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>

          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as 'ALL' | UserRole)}
            className="min-h-[44px] px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-700"
            aria-label="Lọc theo vai trò"
          >
            <option value="ALL">Mọi vai trò ({members.length})</option>
            <option value="admin">Quản trị viên</option>
            <option value="manager">Quản lý</option>
            <option value="staff">Nhân viên</option>
            <option value="viewer">Chỉ xem</option>
          </select>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="h-14 bg-slate-100 rounded-lg animate-pulse"
              />
            ))}
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="py-12 px-6 text-center">
            <p className="text-base font-bold text-slate-900">
              Chưa có tài khoản Gmail nào khác được cấp quyền
            </p>
            <p className="mt-1.5 text-sm text-slate-600 max-w-md mx-auto">
              Nhấn "Cấp quyền Gmail mới" để thêm địa chỉ Gmail của nhân viên hoặc quản lý và phân công quyền truy cập từng chức năng.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {filteredMembers.map((member) => {
              const isRootAdmin = member.email === SUPER_ADMIN_EMAIL;
              const isSelf =
                normalizeEmail(member.email) === normalizeEmail(currentUserEmail);

              return (
                <div
                  key={member.id}
                  className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 hover:bg-slate-50/70 transition-colors"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-medium">
                      <span
                        className={
                          member.active ? 'text-emerald-700' : 'text-red-600'
                        }
                      >
                        {member.active ? 'Đang hoạt động' : 'Tạm khóa'}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className="text-blue-700">
                        {ROLE_LABELS[member.role]}
                      </span>
                      {isSelf && (
                        <>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className="text-slate-500">Tài khoản của bạn</span>
                        </>
                      )}
                    </div>

                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <h3 className="text-base font-bold text-slate-900">
                        {member.displayName}
                      </h3>
                      <span className="text-sm font-mono text-slate-600 break-all">
                        {member.email}
                      </span>
                    </div>

                    <p className="text-sm text-slate-600">
                      Quyền: {renderPermissionSummary(member)}
                    </p>

                    {member.note && (
                      <p className="text-xs text-slate-500">
                        Ghi chú: {member.note}
                      </p>
                    )}
                  </div>

                  {!isRootAdmin && (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onToggleActive(member)}
                        className={`min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg border transition-colors whitespace-nowrap ${
                          member.active
                            ? 'text-amber-700 bg-white border-amber-200 hover:bg-amber-50'
                            : 'text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100'
                        }`}
                      >
                        {member.active ? (
                          <>
                            <Lock className="h-4 w-4" />
                            <span>Tạm khóa</span>
                          </>
                        ) : (
                          <>
                            <Unlock className="h-4 w-4" />
                            <span>Mở khóa</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => openEditModal(member)}
                        className="min-h-[44px] inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap"
                      >
                        <Edit3 className="h-4 w-4" />
                        <span>Sửa quyền</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDeleteTarget(member)}
                        className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
                        aria-label={`Thu hồi quyền của ${member.email}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-xs p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="access-modal-title"
        >
          <div className="w-full sm:max-w-lg bg-white border border-slate-200 rounded-t-2xl sm:rounded-xl max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3
                id="access-modal-title"
                className="text-lg font-bold text-slate-900"
              >
                {editingMember
                  ? 'Chỉnh sửa phân quyền Gmail'
                  : 'Cấp quyền cho tài khoản Gmail mới'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="min-h-[44px] min-w-[44px] -mr-2 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form
              onSubmit={handleSubmit}
              className="p-6 space-y-4 overflow-y-auto"
            >
              <div>
                <label
                  htmlFor="access-email"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  Địa chỉ Gmail *
                </label>
                <input
                  id="access-email"
                  type="email"
                  required
                  disabled={Boolean(editingMember)}
                  maxLength={254}
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder="nhanvien@gmail.com"
                  className="w-full min-h-[44px] px-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg disabled:bg-slate-100 disabled:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label
                  htmlFor="access-name"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  Tên nhân sự / Bộ phận *
                </label>
                <input
                  id="access-name"
                  type="text"
                  required
                  maxLength={120}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="VD: Trần Thị B - Thủ kho"
                  className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <span className="block text-sm font-medium text-slate-700 mb-1.5">
                  Vai trò truy cập
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                  {ROLE_ORDER.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => handleRoleChange(r)}
                      className={`min-h-[42px] px-3 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
                        roleInput === r
                          ? 'bg-blue-600 border-blue-600 text-white'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {ROLE_LABELS[r]}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  {ROLE_DESCRIPTIONS[roleInput]}
                </p>
              </div>

              <div>
                <span className="block text-sm font-medium text-slate-700 mb-2">
                  Quyền sử dụng từng chức năng
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <label className="min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={allowBarcode}
                      onChange={(e) => setAllowBarcode(e.target.checked)}
                      className="h-4 w-4 accent-blue-600"
                    />
                    <span className="text-sm text-slate-800">
                      Quét &amp; xem mã vạch
                    </span>
                  </label>

                  <label className="min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={allowSchedule}
                      onChange={(e) => setAllowSchedule(e.target.checked)}
                      className="h-4 w-4 accent-blue-600"
                    />
                    <span className="text-sm text-slate-800">
                      Lịch làm việc
                    </span>
                  </label>

                  <label className="min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={allowExport}
                      onChange={(e) => setAllowExport(e.target.checked)}
                      className="h-4 w-4 accent-blue-600"
                    />
                    <span className="text-sm text-slate-800">
                      Xuất Excel (.xlsx)
                    </span>
                  </label>

                  <label className="min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={allowSupabase}
                      onChange={(e) => setAllowSupabase(e.target.checked)}
                      className="h-4 w-4 accent-blue-600"
                    />
                    <span className="text-sm text-slate-800">
                      Đồng bộ Supabase
                    </span>
                  </label>
                </div>
              </div>

              <label className="min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={activeInput}
                  onChange={(e) => setActiveInput(e.target.checked)}
                  className="h-4 w-4 accent-emerald-600"
                />
                <span className="text-sm font-medium text-slate-800">
                  Kích hoạt quyền truy cập ngay
                </span>
              </label>

              <div>
                <label
                  htmlFor="access-note"
                  className="block text-sm font-medium text-slate-700 mb-1.5"
                >
                  Ghi chú phân quyền
                </label>
                <input
                  id="access-note"
                  type="text"
                  maxLength={300}
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  placeholder="VD: Phụ trách kiểm kho ca sáng..."
                  className="w-full min-h-[44px] px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="pt-2 flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="min-h-[44px] px-5 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="min-h-[44px] inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>
                    {submitting
                      ? 'Đang lưu...'
                      : editingMember
                        ? 'Cập nhật phân quyền'
                        : 'Cấp quyền truy cập'}
                  </span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Revoke confirmation */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Thu hồi quyền truy cập Gmail này?"
        description={
          deleteTarget
            ? `Tài khoản "${deleteTarget.email}" sẽ không còn đăng nhập và truy cập dữ liệu ứng dụng được nữa.`
            : ''
        }
        confirmLabel="Thu hồi quyền"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await onDeleteMember(deleteTarget);
          }
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
