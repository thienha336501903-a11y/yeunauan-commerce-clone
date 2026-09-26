# scripts/scan-secrets.py
import re
import sys
from pathlib import Path

SECRET_PATTERNS = [
    (r"eyJhbGciOi[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "JWT Token"),
    (r"sbp_[a-zA-Z0-9]{20,}", "Supabase Personal Access Token"),
    (r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----", "Private Key"),
    (r"AKIA[0-9A-Z]{16}", "AWS Access Key"),
    (r"(?i)(?:password|secret|service_role_key|service_key)\s*[:=]\s*['\"][^'\"]{8,}['\"]", "Hardcoded Secret/Password")
]

# Allow dummy or placeholder values in tests
ALLOWLIST = [
    "P@ssw0rd_",
    "Password123",
    "fake_legacy_hmac_token_value",
    "Bearer valid_jwt",
    "Bearer token",
    "Bearer expired_or_tampered_jwt",
    "tampered00",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid.signature"
]

def scan_file(filepath):
    content = filepath.read_text(encoding="utf-8", errors="ignore")
    findings = []
    for pattern, desc in SECRET_PATTERNS:
        matches = re.finditer(pattern, content)
        for match in matches:
            matched_str = match.group(0)
            if any(allowed in matched_str for allowed in ALLOWLIST):
                continue
            findings.append((desc, matched_str[:20] + "..."))
    return findings

def main():
    files_to_scan = sys.argv[1:]
    if not files_to_scan:
        print("Usage: python scan-secrets.py <file1> <file2> ...")
        sys.exit(0)

    total_findings = 0
    for f in files_to_scan:
        p = Path(f)
        if not p.is_file():
            continue
        findings = scan_file(p)
        if findings:
            print(f"[ALERT] Secrets found in {p}:")
            for desc, snippet in findings:
                print(f"  - {desc}: {snippet}")
            total_findings += len(findings)

    if total_findings > 0:
        print(f"\nFAILED: {total_findings} potential secret(s) found.")
        sys.exit(1)
    else:
        print("PASS: No secret patterns detected.")
        sys.exit(0)

if __name__ == "__main__":
    main()
