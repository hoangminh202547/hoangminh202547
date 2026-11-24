import { useState } from 'react';
import { CalendarDays, Database, FileSpreadsheet, ScanBarcode } from 'lucide-react';
import { signInWithGmail } from '../lib/firebase';

interface SignInScreenProps {
  onSuccess?: () => void;
}

export function SignInScreen({ onSuccess }: SignInScreenProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      await signInWithGmail();
      if (onSuccess) onSuccess();
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Đăng nhập Gmail thất bại. Vui lòng thử lại.';
      if (msg.includes('popup-closed-by-user')) {
        setError('Cửa sổ đăng nhập Gmail đã bị đóng trước khi hoàn tất.');
      } else if (msg.includes('popup-blocked')) {
        setError('Trình duyệt đã chặn cửa sổ bật lên. Vui lòng cho phép popup để đăng nhập.');
      } else {
        setError(msg);
      }
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
            Nền tảng Quét Mã Vạch &amp; Lịch Làm Việc
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
                Quản lý kho &amp; ca làm việc đa thiết bị
              </p>
              <h1 className="mt-2 text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight leading-tight text-balance">
                Quét mã vạch liên tục, xuất Excel và đăng ký lịch làm việc rõ ràng
              </h1>
              <p className="mt-4 text-base text-slate-600 leading-relaxed max-w-2xl">
                Thiết kế tối ưu cho cả màn hình máy tính và điện thoại với font chữ Roboto sắc nét. Dữ liệu được lưu trữ an toàn theo tài khoản Gmail và hỗ trợ đồng bộ trực tiếp sang Supabase.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center gap-2.5 text-slate-900 font-bold text-base">
                  <ScanBarcode className="h-5 w-5 text-blue-600 shrink-0" />
                  <span>Quét mã vạch liên tục</span>
                </div>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Quét bằng camera điện thoại, webcam hoặc súng quét USB. Tự động cộng dồn số lượng và lưu trữ tức thì.
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
                  <span>Đăng ký lịch làm việc</span>
                </div>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Chọn ca sáng, chiều, tối hoặc tùy chỉnh giờ; theo dõi lịch tuần và cập nhật trạng thái hoàn thành.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-4">
                <div className="flex items-center gap-2.5 text-slate-900 font-bold text-base">
                  <Database className="h-5 w-5 text-emerald-600 shrink-0" />
                  <span>Liên kết Supabase</span>
                </div>
                <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                  Kết nối tới Project Supabase của bạn để đồng bộ 2 chiều bảng mã vạch và lịch làm việc PostgreSQL.
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
                Sử dụng địa chỉ Gmail của bạn để đồng bộ dữ liệu quét mã vạch và lịch làm việc giữa máy tính và điện thoại.
              </p>

              <div className="mt-6">
                <button
                  type="button"
                  onClick={handleLogin}
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

              {error && (
                <div
                  role="alert"
                  className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
                >
                  {error}
                </div>
              )}

              <div className="mt-6 pt-5 border-t border-slate-100 text-xs text-slate-500 space-y-1.5">
                <p>· Hỗ trợ quét EAN-13, EAN-8, Code-128, Code-39, QR Code</p>
                <p>· Dữ liệu riêng tư theo từng tài khoản Gmail xác thực</p>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="py-4 px-4 sm:px-8 text-center text-xs text-slate-500 border-t border-slate-200 bg-white">
        ScanShift · Quản lý Mã vạch &amp; Lịch làm việc
      </footer>
    </div>
  );
}
