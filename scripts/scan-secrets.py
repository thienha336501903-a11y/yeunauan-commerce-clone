# scripts/scan-secrets.py
# Hardened Multi-Agency Secret Scanner
# Milestone M0B.1 / Pre-M0C Remediation V2 Hardening
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
ALLOWLIST_PATTERNS = [
    r"P@ssw0rd_",
    r"Password123",
    r"fake_legacy_hmac_token_value",
    r"Bearer\s+valid_jwt",
    r"Bearer\s+token",
    r"Bearer\s+expired_or_tampered_jwt",
    r"Bearer\s+mock_expired",
    r"Bearer\s+valid_student",
    r"tampered00",
    r"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.invalid\.signature",
    r"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.dummy",
    r"VERCEL_AUTOMATION_BYPASS_SECRET",
    r"<your-generated-secret>",
    r"AUTHENTICATED_WITH_EPHEMERAL_SECRET",
    r"DELETE_CLONE_FACTORY_TEST",
    r"DELETE_CLONE_FACTORY_TEST_ORPHAN_BILL",
    r"-----BEGIN PRIVATE KEY-----\\n\.\.\.",
    r"process\.env\.[A-Za-z0-9_]+"
]

IGNORE_DIRS = {".git", "node_modules", ".next", "dist", "scratch", ".vercel", "coverage"}

def is_match_allowed(matched_str):
    for pattern in ALLOWLIST_PATTERNS:
        if re.search(pattern, matched_str):
            return True
    return False

def scan_text(content, filename=""):
    """
    Scans text line-by-line and match-by-match.
    Phase 9 Rules:
    - Allowlist applies ONLY to the individual matched token, NOT the entire line.
    - Never skip an unrelated literal secret simply because process.env is on the same line.
    - Never leak or print secret values in findings.
    """
    findings = []
    lines = content.splitlines()
    for line_idx, line in enumerate(lines, 1):
        for pattern, category in SECRET_PATTERNS:
            for match in re.finditer(pattern, line):
                matched_str = match.group(0)
                # Check if this specific match is allowed
                if is_match_allowed(matched_str):
                    continue
                # If the match contains generic pattern but is just process.env reference, ignore
                if re.fullmatch(r"(?i)(?:password|secret|api_key|service_key)\s*[:=]\s*process\.env\.[A-Za-z0-9_]+", matched_str.strip()):
                    continue
                # Record finding: file + line number + rule category ONLY (NO secret content!)
                findings.append((filename, line_idx, category))
    return findings

def get_repo_files(repo_path):
    try:
        tracked = subprocess.run(
            ["git", "ls-files"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
            check=True
        ).stdout.splitlines()
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
            check=True
        ).stdout.splitlines()
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
    except Exception as e:
        print(f"ERROR: Failed to list git files in repo {repo_path}: {e}", file=sys.stderr)
        sys.exit(1)

def get_git_diff_content(repo_path, base_ref="HEAD~6"):
    """
    Phase 9 Rule:
    - Git command failure => scanner FAIL.
    - Nonexistent base ref => FAIL.
    - Do not silently swallow exceptions or return empty strings on failure.
    """
    cmd = ["git", "diff", f"{base_ref}..HEAD", "--", ":!scripts/scan-secrets.py"]
    res = subprocess.run(
        cmd,
        cwd=repo_path,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore"
    )
    if res.returncode != 0:
        raise RuntimeError(f"Git command failed (return code {res.returncode}): {res.stderr.strip()}")
    return res.stdout or ""

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
        try:
            diff_text = get_git_diff_content(repo_path, base)
        except Exception as e:
            print(f"FAILED: Git diff execution error: {e}", file=sys.stderr)
            sys.exit(1)

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
            except Exception as e:
                print(f"ERROR reading file {filepath}: {e}", file=sys.stderr)
                sys.exit(1)
    elif files_to_scan:
        for filepath in files_to_scan:
            p = Path(filepath)
            if not p.is_file() or p.name == "scan-secrets.py":
                continue
            try:
                content = p.read_text(encoding="utf-8", errors="ignore")
                findings = scan_text(content, str(p))
                all_findings.extend(findings)
            except Exception as e:
                print(f"ERROR reading file {filepath}: {e}", file=sys.stderr)
                sys.exit(1)

    if all_findings:
        print("[ALERT] Secret patterns detected:")
        for filename, line_num, category in all_findings:
            # Secret content is NEVER printed
            print(f"  - File: {filename} (line {line_num}) | Rule Category: {category}")
        print(f"\nFAILED: {len(all_findings)} secret pattern match(es) detected.")
        sys.exit(1)
    else:
        print("PASS: No secret patterns detected.")
        sys.exit(0)

if __name__ == "__main__":
    main()
