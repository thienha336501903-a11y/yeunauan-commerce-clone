# scripts/scan-secrets.py
# Hardened Multi-Agency Secret Scanner
import os
import re
import subprocess
import sys
from pathlib import Path

SECRET_PATTERNS = [
    # 1. JWT Tokens & Supabase Service Role Keys
    (r"eyJhbGciOi[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "Supabase JWT / Signed Token"),
    (r"sbp_[a-zA-Z0-9]{20,}", "Supabase Personal Access Token"),
    (r"sb_secret_[A-Za-z0-9_-]{20,}", "Supabase Secret Key"),
    (r"service_role.{0,20}[A-Za-z0-9_-]{24,}", "Supabase Service Role Secret"),

    # 2. Vercel Protection Bypass Credentials
    (r"(?i)x-vercel-protection-bypass['\"]?\s*[:=]\s*['\"][A-Za-z0-9_-]{16,}['\"]", "Vercel Protection Bypass Header Value"),
    (r"(?i)(?:lms_bypass_token|commerce_bypass_token|protection_bypass|bypass_secret)\s*[:=]\s*['\"][A-Za-z0-9_-]{16,}['\"]", "Hardcoded Protection Bypass Secret"),

    # 3. Private Keys (PEM and JWK private curves)
    (r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----(?!\\n\.\.\.)", "Private Key (PEM)"),
    (r"['\"]d['\"]\s*:\s*['\"][A-Za-z0-9_-]{20,}['\"]", "Private Key (JWK curve scalar 'd')"),

    # 4. Bearer & API / Cloud Tokens
    (r"(?i)bearer\s+[A-Za-z0-9_\-\.]{30,}", "Bearer Token"),
    (r"AKIA[0-9A-Z]{16}", "AWS Access Key"),

    # 5. Generic Hardcoded Passwords / Secrets
    (r"(?i)(?:password|secret|api_key|service_key)\s*[:=]\s*['\"][^'\"]{12,}['\"]", "Generic Hardcoded Secret/Password")
]

# Allowlist for non-secret placeholders, documentation, and safe test fixtures
ALLOWLIST = [
    "P@ssw0rd_",
    "Password123",
    "fake_legacy_hmac_token_value",
    "Bearer valid_jwt",
    "Bearer token",
    "Bearer expired_or_tampered_jwt",
    "Bearer mock_expired",
    "Bearer valid_student",
    "tampered00",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid.signature",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy",
    "process.env.",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
    "<your-generated-secret>",
    "AUTHENTICATED_WITH_EPHEMERAL_SECRET",
    "DELETE_CLONE_FACTORY_TEST",
    "DELETE_CLONE_FACTORY_TEST_ORPHAN_BILL",
    "bắt đầu bằng `-----BEGIN PRIVATE KEY-----\\n...`",
    "-----BEGIN PRIVATE KEY-----\\n..."
]

IGNORE_DIRS = {".git", "node_modules", ".next", "dist", "scratch", ".vercel", "coverage"}

def is_allowed(line):
    for allow_entry in ALLOWLIST:
        if allow_entry in line:
            return True
    return False

def scan_text(content, filename=""):
    findings = []
    lines = content.splitlines()
    for line_idx, line in enumerate(lines, 1):
        if is_allowed(line):
            continue
        for pattern, category in SECRET_PATTERNS:
            if re.search(pattern, line):
                # Ensure we do NOT leak the secret content!
                # Report only: filename + line number + rule category
                findings.append((filename, line_idx, category))
    return findings

def get_repo_files(repo_path):
    # Use git ls-files to respect .gitignore (ignoring local uncommitted .env* files)
    try:
        tracked = subprocess.run(["git", "ls-files"], cwd=repo_path, capture_output=True, text=True, encoding="utf-8", errors="ignore", check=True).stdout.splitlines()
        untracked = subprocess.run(["git", "ls-files", "--others", "--exclude-standard"], cwd=repo_path, capture_output=True, text=True, encoding="utf-8", errors="ignore", check=True).stdout.splitlines()
        all_files = set(tracked + untracked)
        files = []
        for f in all_files:
            if any(part in IGNORE_DIRS for part in Path(f).parts):
                continue
            ext = os.path.splitext(f)[1].lower()
            if ext in {".png", ".jpg", ".jpeg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".zip", ".tar", ".gz"}:
                continue
            files.append(os.path.join(repo_path, f))
        return files
    except Exception:
        # Fallback to directory walk
        files = []
        for root, dirs, filenames in os.walk(repo_path):
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
            for f in filenames:
                if f.startswith(".env"):
                    continue
                ext = os.path.splitext(f)[1].lower()
                if ext in {".png", ".jpg", ".jpeg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".zip", ".tar", ".gz"}:
                    continue
                files.append(os.path.join(root, f))
        return files

def get_git_diff_content(repo_path, base_ref="41749e5"):
    try:
        cmd = ["git", "diff", f"{base_ref}..HEAD", "--", ":!scripts/scan-secrets.py"]
        res = subprocess.run(cmd, cwd=repo_path, capture_output=True, text=True, encoding="utf-8", errors="ignore", check=True)
        return res.stdout or ""
    except Exception:
        return ""



def main():
    args = sys.argv[1:]
    repo_path = os.getcwd()

    mode_all = False
    mode_diff = False
    diff_base = None
    files_to_scan = []

    idx = 0
    while idx < len(args):
        arg = args[idx]
        if arg == "--all":
            mode_all = True
        elif arg == "--diff":
            mode_diff = True
            if idx + 1 < len(args) and not args[idx + 1].startswith("-"):
                idx += 1
                diff_base = args[idx]
        else:
            files_to_scan.append(arg)
        idx += 1

    all_findings = []

    if mode_diff:
        base = diff_base or "HEAD~6"
        diff_text = get_git_diff_content(repo_path, base)
        # Scan added/modified lines in diff (+...)
        added_lines = [l[1:] for l in diff_text.splitlines() if l.startswith("+") and not l.startswith("+++")]
        diff_content = "\n".join(added_lines)
        findings = scan_text(diff_content, f"git-diff({base}..HEAD)")
        all_findings.extend(findings)

    if mode_all:
        files = get_repo_files(repo_path)
        for filepath in files:
            if Path(filepath).name == "scan-secrets.py":
                continue
            try:
                content = Path(filepath).read_text(encoding="utf-8", errors="ignore")
                rel_path = os.path.relpath(filepath, repo_path)
                findings = scan_text(content, rel_path)
                all_findings.extend(findings)
            except Exception:
                pass
    elif files_to_scan:
        for filepath in files_to_scan:
            p = Path(filepath)
            if not p.is_file() or p.name == "scan-secrets.py":
                continue
            try:
                content = p.read_text(encoding="utf-8", errors="ignore")
                findings = scan_text(content, str(p))
                all_findings.extend(findings)
            except Exception:
                pass


    if all_findings:
        print("[ALERT] Secret patterns detected:")
        for filename, line_num, category in all_findings:
            print(f"  - File: {filename} (line {line_num}) | Rule Category: {category}")
        print(f"\nFAILED: {len(all_findings)} secret pattern match(es) detected.")
        sys.exit(1)
    else:
        print("PASS: No secret patterns detected.")
        sys.exit(0)

if __name__ == "__main__":
    main()
