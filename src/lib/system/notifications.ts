/**
 * System Notification Store — persisted queue of notifications requiring human attention.
 *
 * Notifications are written by SystemHealth and consumed by the dashboard UI.
 * Persisted to .data/notifications.json across restarts.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SystemNotification, NotificationSource, NotificationSeverity, SystemAction } from './types.js';

const MAX_NOTIFICATIONS = 200;

export class NotificationStore {
	private notifications: SystemNotification[] = [];
	private filePath: string;
	private dirty = false;

	constructor(dataDir: string) {
		this.filePath = resolve(dataDir, 'notifications.json');
	}

	async load(): Promise<void> {
		try {
			const raw = await readFile(this.filePath, 'utf-8');
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				this.notifications = parsed;
			}
		} catch {
			// File doesn't exist yet — start empty
			this.notifications = [];
		}
	}

	async save(): Promise<void> {
		if (!this.dirty) return;
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, JSON.stringify(this.notifications, null, 2), 'utf-8');
		this.dirty = false;
	}

	/**
	 * Create a notification. Deduplicates by title+source — if an active
	 * (non-dismissed, non-resolved) notification with the same title exists,
	 * it's updated instead of duplicated.
	 */
	add(opts: {
		source: NotificationSource;
		severity: NotificationSeverity;
		title: string;
		detail: string;
		actions?: SystemAction[];
	}): SystemNotification {
		// Dedup: find existing active notification with same title + source
		const existing = this.notifications.find(
			(n) => n.title === opts.title && n.source === opts.source && !n.dismissed && !n.resolved
		);
		if (existing) {
			existing.detail = opts.detail;
			existing.severity = opts.severity;
			if (opts.actions) existing.actions = opts.actions;
			this.dirty = true;
			return existing;
		}

		const notification: SystemNotification = {
			id: randomUUID().slice(0, 8),
			source: opts.source,
			severity: opts.severity,
			title: opts.title,
			detail: opts.detail,
			actions: opts.actions ?? [],
			created: Date.now(),
		};

		this.notifications.unshift(notification);

		// Cap total notifications
		if (this.notifications.length > MAX_NOTIFICATIONS) {
			this.notifications = this.notifications.slice(0, MAX_NOTIFICATIONS);
		}

		this.dirty = true;
		return notification;
	}

	/** Get active (non-dismissed, non-resolved) notifications */
	getActive(): SystemNotification[] {
		return this.notifications.filter((n) => !n.dismissed && !n.resolved);
	}

	/** Get all notifications (including dismissed/resolved) */
	getAll(limit = 50): SystemNotification[] {
		return this.notifications.slice(0, limit);
	}

	/** Get a single notification by ID */
	get(id: string): SystemNotification | undefined {
		return this.notifications.find((n) => n.id === id);
	}

	/** Dismiss a notification */
	dismiss(id: string): boolean {
		const n = this.notifications.find((n) => n.id === id);
		if (!n) return false;
		n.dismissed = Date.now();
		this.dirty = true;
		return true;
	}

	/** Mark a notification as resolved with a result */
	resolve(id: string, actionId: string, result: string): boolean {
		const n = this.notifications.find((n) => n.id === id);
		if (!n) return false;
		n.resolved = { actionId, at: Date.now(), result };
		this.dirty = true;
		return true;
	}

	/** Remove all dismissed/resolved notifications older than maxAgeDays */
	prune(maxAgeDays = 7): number {
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		const before = this.notifications.length;
		this.notifications = this.notifications.filter(
			(n) => !((n.dismissed || n.resolved) && n.created < cutoff)
		);
		const pruned = before - this.notifications.length;
		if (pruned > 0) this.dirty = true;
		return pruned;
	}

	/** Count of active notifications */
	get activeCount(): number {
		return this.notifications.filter((n) => !n.dismissed && !n.resolved).length;
	}
}
