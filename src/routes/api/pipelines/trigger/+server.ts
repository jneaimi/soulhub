import type { RequestHandler } from './$types';

// ADR-002 — pipeline module retired 2026-05-16. Stub kept for 30 days so
// external callers (cron, curl scripts) get a clear 410 Gone instead of a
// silent 404. Use POST /api/scheduler/run-now or the Naseej recipe runner
// at POST /api/recipes/run.
const MESSAGE = 'Pipeline module retired; use POST /api/scheduler/run-now or POST /api/recipes/run';

export const GET: RequestHandler = () => new Response(MESSAGE, { status: 410 });
export const POST: RequestHandler = () => new Response(MESSAGE, { status: 410 });
export const PUT: RequestHandler = () => new Response(MESSAGE, { status: 410 });
