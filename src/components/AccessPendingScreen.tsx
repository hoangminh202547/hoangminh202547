import { LogOut, RefreshCw, ShieldAlert } from 'lucide-react';
import { SUPER_ADMIN_EMAIL } from '../lib/permissions';

interface AccessPendingScreenProps {
  email: string;
  deactivated: boolean;
  checking: boolean;
  onRecheck: () => void;
  onSignOut: () => void;
}

export function AccessPendingScreen({
  email,
  deactivated,
  checking,
  onRecheck,
  onSignOut,
}: AccessPendingScreenProps) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 sm:p-6">
      <div className="max-w-lg w-full bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
        <div className="flex items-start gap-3.5">
          <div className="h-11 w-11 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              {deactivated
                ? 'Tài khoản đang tạm khóa quyền truy cập'
                : 'Email chưa được cấp quyền truy cập'}
            </h1>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">
              Tài khoản{' '}
              <span className="font-mono font-medium text-slate-900">
                {email}
              </span>{' '}
              {deactivated
                ? 'hiện đang bị tạm khóa trong bảng phân quyền.'
                : 'chưa có trong danh sách thành viên được phép sử dụng ứng dụng.'}
            </p>
          </div>
        </div>

        <div className="mt-5 p-4 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-700 space-y-1.5">
          <p className="font-medium text-slate-900">Cách để được cấp quyền:</p>
          <p>
            Hãy liên hệ Quản lý siêu thị (
            <span className="font-mono text-slate-900">{SUPER_ADMIN_EMAIL}</span>
            ) để thêm địa chỉ email của bạn vào mục <strong>Phân quyền</strong> và chọn vai trò phù hợp.
          </p>
        </div>

        <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <button
            type="button"
            onClick={onRecheck}
            disabled={checking}
            className="min-h-[44px] flex-1 inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap"
          >
            <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
            <span>{checking ? 'Đang kiểm tra...' : 'Kiểm tra lại quyền'}</span>
          </button>

          <button
            type="button"
            onClick={onSignOut}
            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            <LogOut className="h-4 w-4" />
            <span>Đổi tài khoản khác</span>
          </button>
        </div>
      </div>
    </div>
  );
}
