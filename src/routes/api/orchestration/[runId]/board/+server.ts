import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { readBoard, listWorkerRequests } from '$lib/orchestration/board.js';

/** GET /api/orchestration/[runId]/board — read the board */
export const GET: RequestHandler = async ({ params }) => {
	const board = await readBoard(params.runId);
	const requests = await listWorkerRequests(params.runId);
	return json({ board, requests });
};
