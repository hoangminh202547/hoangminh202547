import { useState } from 'react';
import {
  CalendarDays,
  Database,
  FileSpreadsheet,
  KeyRound,
  ScanBarcode,
} from 'lucide-react';
import { signInWithGmail as signInWithFirebaseGmail } from '../lib/firebase';
import {
  getSupabaseClient,
  isValidSupabaseConfig,
  signInWithSupabaseGooglePopup,
} from '../lib/supabase';
import type { SupabaseConfig } from '../types';

interface SignInScreenProps {
  supabaseConfig: SupabaseConfig;
  onSupabaseSessionReady?: () => void;
}

export function SignInScreen({
  supabaseConfig,
  onSupabaseSessionReady,
}: SignInScreenProps) {
  const supabaseAvailable = isValidSupabaseConfig(supabaseConfig);
  const [authMode, setAuthMode] = useState<'google' | 'password'>('google');
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      if (supabaseAvailable) {
        const client = getSupabaseClient(supabaseConfig);
        if (!client) throw new Error('Không thể khởi tạo kết nối Supabase.');
        await signInWithSupabaseGooglePopup(client);
        if (onSupabaseSessionReady) onSupabaseSessionReady();
      } else {
        await signInWithFirebaseGmail();
      }
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Đăng nhập Gmail thất bại. Vui lòng thử lại.';
      if (msg.includes('popup-closed-by-user')) {
        setError('Cửa sổ đăng nhập Gmail đã bị đóng trước khi hoàn tất.');
      } else if (msg.includes('popup-blocked')) {
        setError(
          'Trình duyệt đã chặn cửa sổ bật lên. Vui lòng cho phép popup để đăng nhập.'
        );
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabaseAvailable) return;
    const client = getSupabaseClient(supabaseConfig);
    if (!client) return;

    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      if (isSignUp) {
        const { data, error: signUpErr } = await client.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: {
            data: {
              full_name: displayName.trim() || email.split('@')[0],
            },
          },
        });
        if (signUpErr) throw signUpErr;
        if (data.session) {
          if (onSupabaseSessionReady) onSupabaseSessionReady();
        } else {
          setInfo(
            'Đã tạo tài khoản. Vui lòng kiểm tra email để xác nhận (hoặc tắt Confirm Email trong Supabase Auth để đăng nhập ngay).'
          );
        }
      } else {
        const { error: signInErr } = await client.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });
        if (signInErr) throw signInErr;
        if (onSupabaseSessionReady) onSupabaseSessionReady();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Đăng nhập Email thất bại.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between">
      {/* Top minimal bar */}
      <header className="w-full border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-8">
          <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
            <div className="h-9 w-9 rounded-lg bg-blue-600 text-white flex items-center justify-center">
              <ScanBarcode className="h-5 w-5" />
            </div>
            <span className="text-lg font-bold tracking-tight text-slate-900">
              ScanShift
            </span>
          </div>
          <span className="text-sm text-slate-500 hidden sm:inline whitespace-nowrap">
            Nền tảng Vận Hành TPCN · Quét Mã Vạch &amp; Lịch Làm Việc
          </span>
        </div>
      </header>

      {/* Main split layout */}
      <main className="flex-1 flex items-center justify-center px-4 sm:px-8 py-10 sm:py-16">
        <div className="max-w-5xl w-full grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
          {/* Left intro */}
          <div className="lg:col-span-7 space-y-6">
            <div>
              <p className="text-sm font-medium text-blue-600">
                Đồng bộ dữ liệu thời gian thực đa tài khoản
              </p>
              <h1 className="mt-2 text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight leading-tight text-balance">
                Quét mã vạch liên tục, xuất Excel và quản lý lịch làm việc trực tuyến
              </h1>
              <p className="mt-4 text-base text-slate-600 leading-relaxed max-w-2xl">
                Thiết kế tối ưu cho cả màn hình máy tính và điện thoại với font chữ Roboto rõ ràng. Toàn bộ dữ liệu được phân quyền bảo mật theo vai trò và đồng bộ trực tiếp qua Supabase Realtime.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center gap-2.5 text-slate-900 font-bold text-base">
                  <ScanBarcode className="h-5 w-5 text-blue-600 shrink-0" />
                  <span>Quét mã vạch liên tục</span>
                </div>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Quét bằng camera điện thoại, webcam hoặc súng quét USB. Tự động cộng dồn và kiểm tra xung đột phiên bản.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center gap-2.5 text-slate-900 font-bold text-base">
                  <FileSpreadsheet className="h-5 w-5 text-emerald-600 shrink-0" />
                  <span>Xuất báo cáo Excel</span>
                </div>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Tải về file <span className="font-mono text-slate-800">.xlsx</span> chuẩn gồm bảng chi tiết từng lần quét và bảng tổng hợp theo mã.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center gap-2.5 text-slate-900 font-bold text-base">
                  <CalendarDays className="h-5 w-5 text-blue-600 shrink-0" />
                  <span>Đăng ký &amp; Duyệt ca làm</span>
                </div>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Nhân viên đăng ký ca làm; Trưởng ca, Giám sát và Quản lý siêu thị phê duyệt và theo dõi tức thì.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center gap-2.5 text-slate-900 font-bold text-base">
                  <Database className="h-5 w-5 text-emerald-600 shrink-0" />
                  <span>Supabase Auth &amp; RLS</span>
                </div>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Tất cả tài khoản làm việc trên cùng một Database trung tâm với nhật ký hoạt động và phân quyền tại PostgreSQL.
                </p>
              </div>
            </div>
          </div>

          {/* Right sign-in card */}
          <div className="lg:col-span-5">
            <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
              <h2 className="text-xl font-bold text-slate-900">
                Đăng nhập tài khoản
              </h2>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                {supabaseAvailable
                  ? 'Đăng nhập qua Supabase Auth để đồng bộ trực tuyến với phân quyền bảo mật.'
                  : 'Sử dụng tài khoản Gmail để truy cập và cấu hình liên kết Supabase trực tiếp.'}
              </p>

              {supabaseAvailable && (
                <div className="mt-4 grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('google');
                      setError(null);
                      setInfo(null);
                    }}
                    className={`min-h-[40px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      authMode === 'google'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Gmail (OAuth)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAuthMode('password');
                      setError(null);
                      setInfo(null);
                    }}
                    className={`min-h-[40px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      authMode === 'password'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Email &amp; Mật khẩu
                  </button>
                </div>
              )}

              {authMode === 'google' ? (
                <div className="mt-6 space-y-3">
                  <button
                    type="button"
                    onClick={handleGoogleLogin}
                    disabled={loading}
                    className="gsi-material-button w-full"
                  >
                    <svg
                      version="1.1"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 48 48"
                      className="h-5 w-5 shrink-0"
                      aria-hidden="true"
                    >
                      <path
                        fill="#EA4335"
                        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                      />
                      <path
                        fill="#4285F4"
                        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                      />
                      <path
                        fill="#34A853"
                        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                      />
                    </svg>
                    <span>
                      {loading ? 'Đang kết nối Gmail...' : 'Đăng nhập bằng Gmail'}
                    </span>
                  </button>
                </div>
              ) : (
                <form onSubmit={handlePasswordSubmit} className="mt-5 space-y-3.5">
                  {isSignUp && (
                    <div>
                      <label
                        htmlFor="login-name"
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        Họ và tên
                      </label>
                      <input
                        id="login-name"
                        type="text"
                        required
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Nguyễn Văn A"
                        className="w-full min-h-[44px] px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="login-email"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Địa chỉ Email / Gmail
                    </label>
                    <input
                      id="login-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="nhanvien@gmail.com"
                      className="w-full min-h-[44px] px-3.5 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="login-password"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Mật khẩu
                    </label>
                    <input
                      id="login-password"
                      type="password"
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Tối thiểu 6 ký tự"
                      className="w-full min-h-[44px] px-3.5 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60"
                  >
                    <KeyRound className="h-4 w-4" />
                    <span>
                      {loading
                        ? 'Đang xử lý...'
                        : isSignUp
                          ? 'Đăng ký tài khoản'
                          : 'Đăng nhập'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsSignUp((v) => !v)}
                    className="w-full text-xs text-blue-600 hover:underline py-1"
                  >
                    {isSignUp
                      ? 'Đã có tài khoản? Quay lại đăng nhập'
                      : 'Chưa có mật khẩu? Tạo tài khoản mới'}
                  </button>
                </form>
              )}

              {error && (
                <div
                  role="alert"
                  className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
                >
                  {error}
                </div>
              )}

              {info && (
                <div
                  role="status"
                  className="mt-4 p-3 rounded-lg bg-blue-50 border border-blue-200 text-sm text-blue-800"
                >
                  {info}
                </div>
              )}

              <div className="mt-6 pt-5 border-t border-slate-100 text-xs text-slate-500 space-y-1.5">
                <p>· Hỗ trợ quét EAN-13, EAN-8, Code-128, Code-39, QR Code</p>
                <p>· Dữ liệu đồng bộ tức thì theo phân quyền tài khoản</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="py-4 px-4 sm:px-8 text-center text-xs text-slate-500 border-t border-slate-200 bg-white">
        ScanShift · Vận Hành TPCN · Quản lý Mã vạch &amp; Lịch làm việc
      </footer>
    </div>
  );
}
