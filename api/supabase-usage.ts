import { handleSupabaseUsageRequest } from './_supabaseUsageService';

function cleanEnv(val: string | undefined): string {
  return (val || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

export async function GET(request: Request): Promise<Response> {
  const authHeader = request.headers.get('authorization') || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  const supabaseUrlRaw =
    request.headers.get('x-supabase-url') ||
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    '';

  const anonKeyRaw =
    request.headers.get('x-supabase-anon-key') ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    '';

  const urlObj = new URL(request.url);
  const forceRefresh = urlObj.searchParams.get('refresh') === '1';

  const result = await handleSupabaseUsageRequest({
    jwt,
    supabaseUrlRaw,
    anonKeyRaw: cleanEnv(anonKeyRaw),
    forceRefresh,
  });

  return Response.json(result.body, {
    status: result.status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
