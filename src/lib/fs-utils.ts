import { stat } from 'node:fs/promises';

/** Check if a path exists and is a directory */
export async function dirExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isDirectory();
	} catch {
		return false;
	}
}

/** Check if a path exists and is a file */
export async function fileExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

/** Get last modified time of a path (returns epoch 0 on error) */
export async function getLastModified(path: string): Promise<Date> {
	try {
		const s = await stat(path);
		return s.mtime;
	} catch {
		return new Date(0);
	}
}
