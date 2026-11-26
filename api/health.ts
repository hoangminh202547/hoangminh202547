export function GET(): Response {
  return Response.json({
    ok: true,
    timestamp: new Date().toISOString(),
  });
}
