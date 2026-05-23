/**
 * Credential encryption — AES-256-GCM with PBKDF2-derived key.
 * Uses SOUL_HUB_SECRET env var as the master key material.
 */

import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

function getSecret(): string {
	const secret = process.env.SOUL_HUB_SECRET;
	if (!secret || secret.length < 16) {
		throw new Error(
			'SOUL_HUB_SECRET env var is required (min 16 chars) for credential encryption. ' +
			'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
		);
	}
	return secret;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
	return pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/** Encrypt a string. Returns base64-encoded `salt:iv:tag:ciphertext`. */
export function encrypt(plaintext: string): string {
	const secret = getSecret();
	const salt = randomBytes(SALT_LENGTH);
	const key = deriveKey(secret, salt);
	const iv = randomBytes(IV_LENGTH);

	const cipher = createCipheriv(ALGORITHM, key, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

/** Decrypt a base64-encoded `salt:iv:tag:ciphertext` string. */
export function decrypt(encoded: string): string {
	const secret = getSecret();
	const buf = Buffer.from(encoded, 'base64');

	const salt = buf.subarray(0, SALT_LENGTH);
	const iv = buf.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
	const tag = buf.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
	const ciphertext = buf.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

	const key = deriveKey(secret, salt);
	const decipher = createDecipheriv(ALGORITHM, key, iv);
	decipher.setAuthTag(tag);

	return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}
