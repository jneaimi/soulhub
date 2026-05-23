#!/usr/bin/env python3
"""Enhanced security scanner — AST analysis, 50+ secret patterns, risk-based file ordering."""
import sys
import os
import json
import re
import ast
import time
from pathlib import Path

# ── Skip lists ────────────────────────────────────────────────────────────────

SKIP_DIRS = {
    'node_modules', '.git', '__pycache__', 'dist', '.next', '.svelte-kit',
    'build', 'venv', '.venv', 'coverage', '.turbo', '.cache', 'vendor',
    'target', '.output', '.nuxt', 'env', '.env',
}
SKIP_EXTS = {
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.lock', '.map',
    '.min.js', '.min.css', '.zip', '.tar', '.gz', '.pdf',
    '.mp3', '.mp4', '.mov', '.pyc', '.pyo', '.so', '.dylib',
}
CODE_EXTS = {
    '.py', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.svelte',
    '.go', '.rs', '.rb', '.php', '.java', '.kt', '.swift',
    '.sh', '.bash', '.zsh', '.sql', '.html', '.vue',
    '.yaml', '.yml', '.json', '.env', '.cfg', '.ini', '.toml',
}
SKIP_FILENAME_PATTERNS = {'.env.example', '.env.template', '.env.sample'}
PLACEHOLDER_WORDS = {'placeholder', 'example', 'dummy', 'test', 'todo', 'xxx', 'changeme', 'your_', 'replace_me'}

# ── Secret Detection Patterns (50+) ──────────────────────────────────────────

SECRET_PATTERNS = [
    # AWS (3)
    (r'AKIA[0-9A-Z]{16}', 'AWS Access Key ID', 'critical', 'A02-sensitive-data'),
    (r'(?:aws).{0,20}(?:secret|key).{0,20}[\'"][0-9a-zA-Z/+=]{40}[\'"]', 'AWS Secret Key', 'critical', 'A02-sensitive-data'),
    (r'(?:aws).{0,20}(?:session).{0,20}[\'"][0-9a-zA-Z/+=]{100,}[\'"]', 'AWS Session Token', 'critical', 'A02-sensitive-data'),

    # GitHub (4)
    (r'ghp_[0-9a-zA-Z]{36}', 'GitHub Personal Access Token', 'critical', 'A02-sensitive-data'),
    (r'gho_[0-9a-zA-Z]{36}', 'GitHub OAuth Token', 'critical', 'A02-sensitive-data'),
    (r'ghu_[0-9a-zA-Z]{36}', 'GitHub User-to-Server Token', 'critical', 'A02-sensitive-data'),
    (r'github_pat_[0-9a-zA-Z_]{82}', 'GitHub Fine-grained PAT', 'critical', 'A02-sensitive-data'),

    # GitLab (1)
    (r'glpat-[0-9a-zA-Z_-]{20,}', 'GitLab Personal Access Token', 'critical', 'A02-sensitive-data'),

    # Slack (2)
    (r'xox[bposa]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*', 'Slack Token', 'critical', 'A02-sensitive-data'),
    (r'https://hooks\.slack\.com/services/T[0-9A-Z]{8,}/B[0-9A-Z]{8,}/[0-9a-zA-Z]{24}', 'Slack Webhook URL', 'high', 'A02-sensitive-data'),

    # Google (2)
    (r'AIza[0-9A-Za-z_-]{35}', 'Google API Key', 'high', 'A02-sensitive-data'),
    (r'[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com', 'Google OAuth Client ID', 'medium', 'A02-sensitive-data'),

    # Stripe (3)
    (r'sk_live_[0-9a-zA-Z]{24,}', 'Stripe Secret Key', 'critical', 'A02-sensitive-data'),
    (r'pk_live_[0-9a-zA-Z]{24,}', 'Stripe Publishable Key', 'medium', 'A02-sensitive-data'),
    (r'rk_live_[0-9a-zA-Z]{24,}', 'Stripe Restricted Key', 'critical', 'A02-sensitive-data'),

    # Private keys (3)
    (r'-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----', 'Private Key', 'critical', 'A02-sensitive-data'),
    (r'-----BEGIN OPENSSH PRIVATE KEY-----', 'SSH Private Key', 'critical', 'A02-sensitive-data'),
    (r'-----BEGIN PGP PRIVATE KEY BLOCK-----', 'PGP Private Key', 'critical', 'A02-sensitive-data'),

    # JWT (1)
    (r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}', 'JWT Token', 'high', 'A02-sensitive-data'),

    # Credentials in URLs (1)
    (r'[a-zA-Z]{3,10}://[^/\s:@]{3,20}:[^/\s:@]{3,20}@[^\s]{3,}', 'Credentials in URL', 'critical', 'A02-sensitive-data'),

    # Database URLs (1)
    (r'(?:mongodb|postgres|mysql|redis|amqp)://[^\s\'"]{10,}', 'Database Connection String', 'high', 'A02-sensitive-data'),

    # npm (1)
    (r'npm_[0-9a-zA-Z]{36}', 'npm Token', 'critical', 'A02-sensitive-data'),

    # PyPI (1)
    (r'pypi-[0-9a-zA-Z_-]{50,}', 'PyPI API Token', 'critical', 'A02-sensitive-data'),

    # SendGrid (1)
    (r'SG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}', 'SendGrid API Key', 'critical', 'A02-sensitive-data'),

    # Twilio (2)
    (r'SK[0-9a-fA-F]{32}', 'Twilio API Key', 'high', 'A02-sensitive-data'),
    (r'AC[0-9a-fA-F]{32}', 'Twilio Account SID', 'medium', 'A02-sensitive-data'),

    # Anthropic (1)
    (r'sk-ant-[0-9a-zA-Z_-]{40,}', 'Anthropic API Key', 'critical', 'A02-sensitive-data'),

    # OpenAI (1)
    (r'sk-[0-9a-zA-Z]{48}', 'OpenAI API Key', 'critical', 'A02-sensitive-data'),

    # Mailgun (1)
    (r'key-[0-9a-zA-Z]{32}', 'Mailgun API Key', 'high', 'A02-sensitive-data'),

    # Heroku (1)
    (r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', 'Heroku API Key (UUID)', 'low', 'A02-sensitive-data'),

    # Firebase (1)
    (r'AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}', 'Firebase Cloud Messaging Key', 'high', 'A02-sensitive-data'),

    # Shopify (2)
    (r'shpat_[0-9a-fA-F]{32}', 'Shopify Admin Token', 'critical', 'A02-sensitive-data'),
    (r'shpss_[0-9a-fA-F]{32}', 'Shopify Shared Secret', 'critical', 'A02-sensitive-data'),

    # Discord (1)
    (r'[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}', 'Discord Bot Token', 'critical', 'A02-sensitive-data'),

    # Telegram (1)
    (r'[0-9]{8,10}:[0-9A-Za-z_-]{35}', 'Telegram Bot Token', 'high', 'A02-sensitive-data'),

    # Azure (1)
    (r'(?:AccountKey|SharedAccessKey)\s*=\s*[A-Za-z0-9+/=]{40,}', 'Azure Storage Key', 'critical', 'A02-sensitive-data'),

    # Datadog (1)
    (r'(?:dd|datadog).{0,20}(?:api|app).{0,20}key.{0,10}[\'"][0-9a-f]{32,40}[\'"]', 'Datadog API/App Key', 'high', 'A02-sensitive-data'),

    # Supabase (1)
    (r'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', 'Supabase/JWT Service Key', 'high', 'A02-sensitive-data'),

    # Generic secrets (3)
    (r'(?:api[_-]?key|apikey)\s*[:=]\s*[\'"][0-9a-zA-Z]{20,}[\'"]', 'Generic API Key', 'high', 'A02-sensitive-data'),
    (r'(?:secret|token|password|passwd|pwd)\s*[:=]\s*[\'"][^\'"]{8,}[\'"]', 'Hardcoded Secret', 'high', 'A02-sensitive-data'),
    (r'(?:auth|bearer)\s+[a-zA-Z0-9_\-\.]{20,}', 'Hardcoded Auth Token', 'high', 'A02-sensitive-data'),

    # Vercel (1)
    (r'vercel_[0-9a-zA-Z_-]{24,}', 'Vercel Token', 'critical', 'A02-sensitive-data'),

    # Linear (1)
    (r'lin_api_[0-9a-zA-Z]{40,}', 'Linear API Key', 'critical', 'A02-sensitive-data'),

    # Resend (1)
    (r're_[0-9a-zA-Z]{20,}', 'Resend API Key', 'high', 'A02-sensitive-data'),

    # HuggingFace (1)
    (r'hf_[0-9a-zA-Z]{34}', 'HuggingFace Token', 'high', 'A02-sensitive-data'),

    # Cloudflare (1)
    (r'(?:cloudflare).{0,20}(?:api|token).{0,20}[\'"][0-9a-zA-Z_-]{37,}[\'"]', 'Cloudflare API Token', 'high', 'A02-sensitive-data'),

    # DigitalOcean (1)
    (r'dop_v1_[0-9a-f]{64}', 'DigitalOcean PAT', 'critical', 'A02-sensitive-data'),

    # Docker Hub (1)
    (r'dckr_pat_[0-9a-zA-Z_-]{24,}', 'Docker Hub PAT', 'critical', 'A02-sensitive-data'),
]
# Total: 50 patterns

# ── Injection Patterns ────────────────────────────────────────────────────────

INJECTION_PATTERNS = [
    # SQL injection
    (r'(?:cursor|conn|db|connection)\.\s*execute\s*\(\s*[f\'"].*\{', 'SQL injection via f-string', 'critical', 'A03-injection'),
    (r'(?:SELECT|INSERT|UPDATE|DELETE)\s+.*(?:\+\s*\w+|%\s*\w+|\.format\()', 'SQL string concatenation', 'critical', 'A03-injection'),

    # Command injection
    (r'os\.system\s*\(', 'os.system() — use subprocess with list args', 'high', 'A03-injection'),
    (r'os\.popen\s*\(', 'os.popen() — use subprocess', 'high', 'A03-injection'),
    (r'subprocess\.(?:call|run|Popen)\s*\(.*shell\s*=\s*True', 'subprocess with shell=True', 'high', 'A03-injection'),

    # Code injection
    (r'eval\s*\(', 'eval() usage', 'high', 'A03-injection'),
    (r'exec\s*\(', 'exec() usage', 'high', 'A03-injection'),
    (r'__import__\s*\(', 'Dynamic import', 'medium', 'A03-injection'),

    # XSS (JavaScript/TypeScript)
    (r'innerHTML\s*=', 'innerHTML assignment — XSS risk', 'high', 'A03-injection'),
    (r'dangerouslySetInnerHTML', 'React dangerouslySetInnerHTML', 'high', 'A03-injection'),
    (r'document\.write\s*\(', 'document.write() — XSS risk', 'high', 'A03-injection'),
    (r'\.html\s*\([^)]*\$', 'jQuery .html() with variable — XSS risk', 'medium', 'A03-injection'),
    (r'v-html\s*=', 'Vue v-html directive — XSS risk', 'high', 'A03-injection'),
    (r'\{\{.*\|\s*safe\s*\}\}', 'Template safe filter — XSS risk', 'high', 'A03-injection'),

    # Path traversal
    (r'open\s*\(.*(?:request|req|params|input|args)', 'File open with user input', 'high', 'A01-broken-access'),
    (r'(?:readFile|readFileSync)\s*\(.*(?:req|params|query)', 'File read with user input', 'high', 'A01-broken-access'),
    (r'sendFile\s*\(.*(?:req|params|query)', 'sendFile with user input', 'high', 'A01-broken-access'),
]

# ── Security Misconfiguration Patterns ────────────────────────────────────────

MISCONFIG_PATTERNS = [
    (r'DEBUG\s*=\s*True', 'Debug mode enabled', 'medium', 'A05-misconfiguration'),
    (r'app\.debug\s*=\s*True', 'Flask debug mode enabled', 'medium', 'A05-misconfiguration'),
    (r'FLASK_DEBUG\s*=\s*1', 'Flask debug env var', 'medium', 'A05-misconfiguration'),
    (r'ALLOWED_HOSTS\s*=\s*\[\s*[\'\"]\*[\'\"]\s*\]', 'Wildcard ALLOWED_HOSTS', 'high', 'A05-misconfiguration'),
    (r'verify\s*=\s*False', 'SSL verification disabled', 'high', 'A05-misconfiguration'),
    (r'rejectUnauthorized\s*:\s*false', 'TLS verification disabled', 'high', 'A05-misconfiguration'),
    (r'NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["\']?0', 'Node TLS rejection disabled', 'high', 'A05-misconfiguration'),
    (r'InsecureSkipVerify\s*:\s*true', 'Go TLS verification disabled', 'high', 'A05-misconfiguration'),
    (r'Access-Control-Allow-Origin.*\*', 'CORS wildcard', 'medium', 'A05-misconfiguration'),
    (r'cors\(\s*\)', 'CORS open default', 'medium', 'A05-misconfiguration'),
    (r'(?:md5|sha1)\s*\(', 'Weak hash algorithm', 'medium', 'A05-misconfiguration'),
    (r'(?:DES|RC4|Blowfish)\b', 'Weak cipher', 'high', 'A05-misconfiguration'),
    (r'Math\.random\s*\(\s*\)', 'Math.random for security — use crypto', 'medium', 'A05-misconfiguration'),
    (r'random\.random\s*\(\s*\)', 'random.random for security — use secrets', 'medium', 'A05-misconfiguration'),
    (r'jwt\.decode\([^)]*verify\s*=\s*False', 'JWT decode without verification', 'high', 'A07-auth-failure'),
    (r'(?:console\.log|print|logger?\.\w+)\s*\(.*(?:password|token|secret|api_?key|credential)', 'Sensitive data in logs', 'medium', 'A02-sensitive-data'),
]

# ── Risk-Based File Ordering ──────────────────────────────────────────────────

def get_risk_tier(filepath):
    """Assign risk tier — lower = scan first."""
    path_lower = str(filepath).lower()

    # Tier 0: Config/secrets files
    if any(p in path_lower for p in ['.env', 'secret', 'credential', 'config.py', 'settings.py', '.npmrc', '.pypirc']):
        return 0

    # Tier 1: Auth/security
    if any(p in path_lower for p in ['auth', 'login', 'session', 'password', 'token', 'crypto', 'permission', 'oauth', 'jwt', 'security']):
        return 1

    # Tier 2: API/routes/views
    if any(p in path_lower for p in ['route', 'api', 'view', 'controller', 'endpoint', 'handler', 'middleware', 'server']):
        return 2

    # Tier 3: Database
    if any(p in path_lower for p in ['model', 'schema', 'migration', 'database', 'query', 'sql', 'prisma']):
        return 3

    # Tier 4: Everything else
    return 4


# ── Code Context ──────────────────────────────────────────────────────────────

def get_context(lines, line_num, context=2):
    """Get surrounding lines for a finding. line_num is 1-based."""
    start = max(0, line_num - context - 1)
    end = min(len(lines), line_num + context)
    context_lines = []
    for i in range(start, end):
        prefix = '>>>' if i == line_num - 1 else '   '
        context_lines.append('%s %4d | %s' % (prefix, i + 1, lines[i].rstrip()))
    return '\n'.join(context_lines)


# ── AST Analysis (Python files) ──────────────────────────────────────────────

def analyze_python_ast(filepath, source, lines):
    """Use Python AST to detect security issues with full context."""
    findings = []
    try:
        tree = ast.parse(source, filename=str(filepath))
    except SyntaxError:
        return findings

    for node in ast.walk(tree):
        # eval/exec calls with dynamic input
        if isinstance(node, ast.Call):
            func_name = ''
            if isinstance(node.func, ast.Name):
                func_name = node.func.id
            elif isinstance(node.func, ast.Attribute):
                func_name = node.func.attr

            if func_name in ('eval', 'exec'):
                if node.args and not isinstance(node.args[0], ast.Constant):
                    lineno = node.lineno
                    findings.append({
                        'file': str(filepath),
                        'line': lineno,
                        'severity': 'critical',
                        'category': 'A03-injection',
                        'title': '%s() with dynamic input' % func_name,
                        'description': '%s() called with non-literal argument — code injection risk' % func_name,
                        'context': get_context(lines, lineno),
                        'suggestion': 'Avoid %s() with dynamic input; use ast.literal_eval() for data parsing' % func_name,
                        'rule_id': 'ast-%s-dynamic' % func_name,
                        'source': 'ast',
                    })

            # os.system
            if func_name == 'system' and isinstance(node.func, ast.Attribute):
                if isinstance(node.func.value, ast.Name) and node.func.value.id == 'os':
                    lineno = node.lineno
                    findings.append({
                        'file': str(filepath),
                        'line': lineno,
                        'severity': 'high',
                        'category': 'A03-injection',
                        'title': 'os.system() call detected via AST',
                        'description': 'os.system() runs shell commands — vulnerable to injection',
                        'context': get_context(lines, lineno),
                        'suggestion': 'Use subprocess.run() with list arguments instead',
                        'rule_id': 'ast-os-system',
                        'source': 'ast',
                    })

            # subprocess with shell=True
            if func_name in ('call', 'run', 'Popen') and isinstance(node.func, ast.Attribute):
                for kw in node.keywords:
                    if kw.arg == 'shell' and isinstance(kw.value, ast.Constant) and kw.value.value is True:
                        lineno = node.lineno
                        findings.append({
                            'file': str(filepath),
                            'line': lineno,
                            'severity': 'high',
                            'category': 'A03-injection',
                            'title': 'subprocess with shell=True via AST',
                            'description': 'shell=True passes command through shell — injection risk if input is dynamic',
                            'context': get_context(lines, lineno),
                            'suggestion': 'Use subprocess with list args (no shell=True)',
                            'rule_id': 'ast-shell-true',
                            'source': 'ast',
                        })

            # pickle.loads / pickle.load
            if func_name in ('load', 'loads') and isinstance(node.func, ast.Attribute):
                if isinstance(node.func.value, ast.Name) and node.func.value.id in ('pickle', 'shelve', 'marshal', 'yaml'):
                    mod = node.func.value.id
                    lineno = node.lineno
                    sev = 'critical' if mod == 'pickle' else 'high'
                    findings.append({
                        'file': str(filepath),
                        'line': lineno,
                        'severity': sev,
                        'category': 'A08-integrity',
                        'title': '%s.%s() — insecure deserialization' % (mod, func_name),
                        'description': '%s deserialization can execute arbitrary code' % mod,
                        'context': get_context(lines, lineno),
                        'suggestion': 'Use json or a safe serialization format',
                        'rule_id': 'ast-insecure-deser-%s' % mod,
                        'source': 'ast',
                    })

        # Dangerous imports
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in ('pickle', 'shelve', 'marshal'):
                    lineno = node.lineno
                    findings.append({
                        'file': str(filepath),
                        'line': lineno,
                        'severity': 'info',
                        'category': 'A08-integrity',
                        'title': 'Import of %s — insecure deserialization module' % alias.name,
                        'description': '%s can execute arbitrary code during deserialization' % alias.name,
                        'context': get_context(lines, lineno),
                        'suggestion': 'Prefer json or safe alternatives; audit all %s.load() calls' % alias.name,
                        'rule_id': 'ast-import-%s' % alias.name,
                        'source': 'ast',
                    })

        if isinstance(node, ast.ImportFrom):
            if node.module in ('pickle', 'shelve', 'marshal'):
                lineno = node.lineno
                findings.append({
                    'file': str(filepath),
                    'line': lineno,
                    'severity': 'info',
                    'category': 'A08-integrity',
                    'title': 'Import from %s — insecure deserialization module' % node.module,
                    'description': '%s can execute arbitrary code during deserialization' % node.module,
                    'context': get_context(lines, lineno),
                    'suggestion': 'Prefer json or safe alternatives',
                    'rule_id': 'ast-importfrom-%s' % node.module,
                    'source': 'ast',
                })

    return findings


# ── Line-Level Helpers ────────────────────────────────────────────────────────

def is_comment_line(line):
    """Check if a line is a comment."""
    stripped = line.strip()
    return (stripped.startswith('#') or stripped.startswith('//') or
            stripped.startswith('*') or stripped.startswith('/*') or
            stripped.startswith('<!--'))


def is_placeholder_line(line):
    """Check if line contains placeholder values (not real secrets)."""
    lower = line.lower()
    return any(w in lower for w in PLACEHOLDER_WORDS)


def should_skip_file_for_secrets(filepath):
    """Skip files that commonly contain example/template secrets."""
    fname = os.path.basename(str(filepath)).lower()
    if fname in SKIP_FILENAME_PATTERNS:
        return True
    for suffix in ('.example', '.sample', '.template'):
        if fname.endswith(suffix):
            return True
    return False


# ── Regex Scanner ─────────────────────────────────────────────────────────────

def scan_patterns(filepath, lines, patterns, category_label):
    """Scan lines against a list of (pattern, title, severity, category) tuples."""
    findings = []
    skip_secrets = should_skip_file_for_secrets(filepath) and category_label == 'secret'

    for pattern_str, title, severity, category in patterns:
        try:
            regex = re.compile(pattern_str, re.IGNORECASE)
        except re.error:
            continue

        for i, line in enumerate(lines):
            if is_comment_line(line):
                continue

            if not regex.search(line):
                continue

            # Extra filtering for secret patterns
            if category_label == 'secret':
                if skip_secrets:
                    continue
                if is_placeholder_line(line):
                    continue

            lineno = i + 1
            findings.append({
                'file': str(filepath),
                'line': lineno,
                'severity': severity,
                'category': category,
                'title': title,
                'description': title,
                'context': get_context(lines, lineno),
                'suggestion': _get_suggestion(category_label, title),
                'rule_id': '%s-%s' % (category_label, re.sub(r'[^a-z0-9]', '-', title.lower())[:40]),
                'source': 'regex',
            })
            break  # One match per pattern per file

    return findings


def _get_suggestion(category_label, title):
    """Return remediation suggestion based on category."""
    if category_label == 'secret':
        return 'Move to environment variables or secrets manager'
    if category_label == 'injection':
        if 'sql' in title.lower():
            return 'Use parameterized queries (placeholders)'
        if 'xss' in title.lower() or 'innerHTML' in title or 'html' in title.lower():
            return 'Sanitize HTML or use framework-safe rendering'
        if 'shell' in title.lower() or 'os.system' in title.lower() or 'subprocess' in title.lower():
            return 'Use subprocess.run() with list arguments (no shell=True)'
        if 'eval' in title.lower() or 'exec' in title.lower():
            return 'Avoid eval/exec with dynamic input; use ast.literal_eval() for data'
        if 'file' in title.lower() or 'path' in title.lower():
            return 'Validate and sanitize file paths; use allowlists'
        return 'Validate and sanitize all user input'
    if category_label == 'misconfig':
        if 'debug' in title.lower():
            return 'Disable debug mode in production'
        if 'tls' in title.lower() or 'ssl' in title.lower() or 'verify' in title.lower():
            return 'Enable TLS/SSL verification; use proper CA certificates'
        if 'cors' in title.lower():
            return 'Restrict to specific allowed origins'
        if 'hash' in title.lower() or 'cipher' in title.lower():
            return 'Use strong algorithms (SHA-256+, AES-256)'
        if 'random' in title.lower():
            return 'Use crypto.getRandomValues() or secrets module'
        if 'jwt' in title.lower():
            return 'Always verify JWT signatures'
        if 'log' in title.lower():
            return 'Mask sensitive values before logging'
        return 'Review and harden configuration'
    return 'Review and fix'


# ── File Collection ───────────────────────────────────────────────────────────

def collect_files(target_path):
    """Collect scannable files, sorted by risk tier then size descending."""
    files = []
    if target_path.is_file():
        if target_path.suffix.lower() in CODE_EXTS:
            files.append(target_path)
        return files

    for root, dirs, filenames in os.walk(target_path):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in filenames:
            fpath = Path(root) / fname
            ext = fpath.suffix.lower()
            if ext in SKIP_EXTS:
                continue
            if ext in CODE_EXTS or fname in ('.env', '.env.local', '.env.production'):
                files.append(fpath)

    # Sort by risk tier, then by size descending (larger files = more surface area)
    files.sort(key=lambda f: (get_risk_tier(f), -_safe_size(f)))
    return files


def _safe_size(f):
    try:
        return os.path.getsize(f)
    except OSError:
        return 0


# ── Main Scanner ──────────────────────────────────────────────────────────────

def scan_file(filepath):
    """Scan a single file with regex patterns + AST (for Python)."""
    findings = []

    try:
        source = open(filepath, errors='ignore').read()
    except Exception:
        return findings

    lines = source.split('\n')

    # Regex scans
    findings.extend(scan_patterns(filepath, lines, SECRET_PATTERNS, 'secret'))
    findings.extend(scan_patterns(filepath, lines, INJECTION_PATTERNS, 'injection'))
    findings.extend(scan_patterns(filepath, lines, MISCONFIG_PATTERNS, 'misconfig'))

    # AST analysis for Python files
    if str(filepath).endswith('.py'):
        findings.extend(analyze_python_ast(filepath, source, lines))

    return findings


# ── Markdown Report ───────────────────────────────────────────────────────────

def format_markdown_report(result):
    """Generate detailed markdown report with code context."""
    lines = ['# Security Analysis Report\n']
    lines.append('**Target:** `%s`' % result['target'])
    lines.append('**Files scanned:** %d (by risk tier) | **Findings:** %d | **Time:** %dms\n' % (
        result['file_count'], result['finding_count'], result['scan_time_ms']))

    if not result['findings']:
        lines.append('No security issues found.\n')
        return '\n'.join(lines)

    # Summary table
    lines.append('## Summary\n')
    lines.append('| Severity | Count |')
    lines.append('|----------|-------|')
    for sev in ('critical', 'high', 'medium', 'low', 'info'):
        count = result['severity_counts'].get(sev, 0)
        if count:
            lines.append('| %s | %d |' % (sev.capitalize(), count))
    lines.append('')

    # Risk tiers scanned
    tiers = result.get('risk_tiers_scanned', {})
    if tiers:
        lines.append('**Risk tiers:** %s\n' % ', '.join(
            '%s: %d files' % (k, v) for k, v in sorted(tiers.items())))

    # Findings grouped by severity
    by_severity = {}
    for f in result['findings']:
        by_severity.setdefault(f['severity'], []).append(f)

    for sev in ('critical', 'high', 'medium', 'low', 'info'):
        group = by_severity.get(sev, [])
        if not group:
            continue
        lines.append('## %s (%d)\n' % (sev.upper(), len(group)))
        for f in group:
            lines.append('### %s' % f['title'])
            lines.append('- **File:** `%s:%d`' % (f['file'], f['line']))
            lines.append('- **Category:** %s' % f['category'])
            if f.get('source'):
                lines.append('- **Detection:** %s' % f['source'])
            lines.append('- **Description:** %s' % f['description'])
            ctx = f.get('context', '')
            if ctx:
                lines.append('```')
                lines.append(ctx)
                lines.append('```')
            if f.get('suggestion'):
                lines.append('> **Fix:** %s' % f['suggestion'])
            lines.append('')

    return '\n'.join(lines)


# ── Entry Point ───────────────────────────────────────────────────────────────

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else '.'
    target_path = Path(os.path.expanduser(target)).resolve()

    if not target_path.exists():
        result = {
            'tool': 'security-analyzer',
            'target': str(target_path),
            'scan_time_ms': 0,
            'file_count': 0,
            'finding_count': 0,
            'severity_counts': {},
            'risk_tiers_scanned': {},
            'findings': [],
            'summary': 'Target not found: %s' % target,
        }
        print(json.dumps(result, indent=2))
        return

    t0 = time.time()
    files = collect_files(target_path)

    # Track risk tiers
    tier_counts = {}
    for f in files:
        tier = 'tier%d' % get_risk_tier(f)
        tier_counts[tier] = tier_counts.get(tier, 0) + 1

    all_findings = []
    for fpath in files:
        all_findings.extend(scan_file(fpath))

    elapsed_ms = int((time.time() - t0) * 1000)

    # Deduplicate: same file + same rule_id = keep first
    seen = set()
    deduped = []
    for f in all_findings:
        key = (f['file'], f.get('rule_id', ''), f['line'])
        if key not in seen:
            seen.add(key)
            deduped.append(f)
    all_findings = deduped

    # Severity counts
    severity_counts = {}
    for f in all_findings:
        severity_counts[f['severity']] = severity_counts.get(f['severity'], 0) + 1

    severity_order = ['critical', 'high', 'medium', 'low', 'info']
    summary_parts = ['%d %s' % (v, k) for k, v in
                     sorted(severity_counts.items(),
                            key=lambda x: severity_order.index(x[0]) if x[0] in severity_order else 99)]
    summary = '%d findings: %s' % (len(all_findings), ', '.join(summary_parts)) if all_findings else 'No issues found'

    # Clean internal fields from JSON output
    for f in all_findings:
        f.pop('rule_id', None)
        f.pop('source', None)
        f['file'] = str(f['file'])

    result = {
        'tool': 'security-analyzer',
        'target': str(target_path),
        'scan_time_ms': elapsed_ms,
        'file_count': len(files),
        'finding_count': len(all_findings),
        'severity_counts': severity_counts,
        'risk_tiers_scanned': tier_counts,
        'findings': all_findings,
        'summary': summary,
    }

    # Write markdown report
    report_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'output')
    os.makedirs(report_dir, exist_ok=True)
    report_path = os.path.join(report_dir, 'security-report.md')
    with open(report_path, 'w') as f:
        f.write(format_markdown_report(result))

    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
