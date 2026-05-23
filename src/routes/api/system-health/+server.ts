import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '$lib/config.js';

const execFileAsync = promisify(execFile);

// Find pm2 relative to project root, not hardcoded home path
const PM2_BIN = resolve(process.cwd(), 'node_modules', '.bin', 'pm2');

interface Pm2Process {
	name: string;
	pm2_env: { status: string };
}

interface HealthStatus {
	server: {
		nodeRunning: boolean;
		tunnelRunning: boolean;
		port: number;
	};
	vault: {
		configured: boolean;
		path: string;
	};
}

async function isPm2ProcessRunning(name: string): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync(PM2_BIN, ['jlist'], { timeout: 5000 });
		const processes: Pm2Process[] = JSON.parse(stdout);
		const proc = processes.find((p) => p.name === name);
		return proc?.pm2_env?.status === 'online';
	} catch {
		return false;
	}
}

/** GET /api/system-health — server + vault status */
export const GET: RequestHandler = async () => {
	const nodeRunning = true;
	const tunnelRunning = await isPm2ProcessRunning('soul-hub-tunnel');

	const health: HealthStatus = {
		server: {
			nodeRunning,
			tunnelRunning,
			port: config.server.port,
		},
		vault: {
			configured: !!config.resolved.vaultDir,
			path: config.resolved.vaultDir,
		},
	};

	return json(health);
};
