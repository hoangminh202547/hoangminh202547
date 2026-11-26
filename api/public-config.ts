function cleanEnv(val: string | undefined): string {
  return (val || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

export function GET(): Response {
  const url = cleanEnv(
    process.env.VITE_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL
  ).replace(/\/+$/, '');

  const anonKey = cleanEnv(
    process.env.VITE_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );

  return Response.json(
    {
      url,
      anonKey,
      configured: Boolean(url && anonKey),
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  );
}
