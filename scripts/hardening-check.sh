#!/bin/sh
# hardening-check.sh — read-only verification for the Linux admin hardening runbook
#
# This script never changes host state. It reads only:
#   id, getent, sysctl -n, stat, systemctl show, getenforce, findmnt,
#   sudo -n -u <user> test (only with --sudo), and socket/file stat.
#
# It prints PASS / FAIL / UNKNOWN for each probe. A FAIL sets exit status 1;
# UNKNOWN does not, because an uninspectable fact is not a failure and must not
# be reported as a pass either. Run it as the administrator, not as root (the
# euid_not_root probe intentionally fails for root).
#
# It does not verify audit rule contents, the signer's internal policy, the
# plugin, prompts, model, or whether a human read an approval. See
# docs/ADMIN-HARDENING.md for the runbook and docs/SIGNER-PROTOCOL.md for the
# signer contract.
#
# Usage: scripts/hardening-check.sh [options]
#   --help

set -u

AGENT_USER=opencode
SIGNER_USER=teamwork-signer
APPROVER_USER=teamwork-approver
KEY_DIR=/var/lib/teamwork-signer/keys
KEY_FILE=
APPROVAL_DIR=/var/lib/teamwork-approvals
SIGNER_APPROVAL_DIR=/var/lib/teamwork-approvals/signer
SIGNER_PATH=/usr/local/libexec/teamwork/signer
PUBLIC_KEY=/etc/teamwork/signer-ed25519.pub
SOCKET_PATH=/run/teamwork-signer/sign.sock
SOCKET_UNIT=teamwork-signer.socket
SERVICE_UNIT=teamwork-signer@.service
USE_SUDO=0
JSON=0

usage() {
  cat <<'EOF'
hardening-check.sh — read-only Linux hardening probes (PASS/FAIL/UNKNOWN)

Options:
  --agent-user USER       Workload user that runs OpenCode (default: opencode)
  --signer-user USER      Signer service user (default: teamwork-signer)
  --approver-user USER    Owner of the approval directory (default: teamwork-approver)
  --key-dir PATH          Signer key directory (default: /var/lib/teamwork-signer/keys)
  --key-file PATH         Signer private key (default: <key-dir>/signer.pem)
  --approval-dir PATH     External approval directory (default: /var/lib/teamwork-approvals)
  --signer-approval-dir PATH
                          Signer approval directory (default: /var/lib/teamwork-approvals/signer)
  --signer PATH           Root-owned signer executable (default: /usr/local/libexec/teamwork/signer)
  --public-key PATH       Verify-only signer public key (default: /etc/teamwork/signer-ed25519.pub)
  --socket PATH           Signer Unix socket (default: /run/teamwork-signer/sign.sock)
  --socket-unit UNIT      systemd socket unit (default: teamwork-signer.socket)
  --service-unit UNIT     systemd service unit (default: teamwork-signer@.service)
  --sudo                  Run read-only `sudo -n -u USER test ...` probes
  --json                  Machine-readable output
  --help                  This text

Checks and their exact read probes:
  euid_not_root           id -u (must not be 0)
  agent_user              getent passwd <agent-user>
  agent_groups            id -Gn <agent-user>; hard groups and wheel/sudo policy
  ptrace_scope            sysctl -n kernel.yama.ptrace_scope
  proc_hidepid            findmnt -no OPTIONS /proc
  auditd_active           systemctl show -p LoadState -p ActiveState auditd.service
  key_dir                 stat -c '%u %g %a %F' <key-dir>
  key_file                stat -c '%u %g %a %F' <key-file>
  approval_dir            stat -c '%u %g %a %F' <approval-dir>
  signer_approval_dir     stat -c '%u %g %a %F' <signer-approval-dir>
  public_key              stat -c '%u %g %a %F' <public-key>
  signer_code             stat on <signer> and each parent directory
  signer_service          systemctl show hardening directives on <service-unit>
  signer_socket           systemctl show <socket-unit> and stat <socket>
  selinux                 getenforce
  selinux_contexts        stat -c '%C' on the key, approval, signer and socket paths
  agent_key_read          sudo -n -u <agent-user> test -r <key-dir>
  agent_approval_write    sudo -n -u <agent-user> test -w <approval-dir>
  agent_signer_approval_read
                          sudo -n -u <agent-user> test -r <signer-approval-dir> (must fail)
  agent_signer_write      sudo -n -u <agent-user> test -w <signer>

Exit status: 0 when no FAIL (UNKNOWN is reported but is not a pass);
1 when any FAIL; 2 on a usage error.

This script is Linux-specific. On macOS/Windows the Linux-only probes report
UNKNOWN, and the result is not a parity claim. See docs/ADMIN-HARDENING.md.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent-user) AGENT_USER=${2:?--agent-user needs a value}; shift 2 ;;
    --signer-user) SIGNER_USER=${2:?--signer-user needs a value}; shift 2 ;;
    --approver-user) APPROVER_USER=${2:?--approver-user needs a value}; shift 2 ;;
    --key-dir) KEY_DIR=${2:?--key-dir needs a value}; shift 2 ;;
    --key-file) KEY_FILE=${2:?--key-file needs a value}; shift 2 ;;
    --approval-dir) APPROVAL_DIR=${2:?--approval-dir needs a value}; shift 2 ;;
    --signer-approval-dir) SIGNER_APPROVAL_DIR=${2:?--signer-approval-dir needs a value}; shift 2 ;;
    --signer) SIGNER_PATH=${2:?--signer needs a value}; shift 2 ;;
    --public-key) PUBLIC_KEY=${2:?--public-key needs a value}; shift 2 ;;
    --socket) SOCKET_PATH=${2:?--socket needs a value}; shift 2 ;;
    --socket-unit) SOCKET_UNIT=${2:?--socket-unit needs a value}; shift 2 ;;
    --service-unit) SERVICE_UNIT=${2:?--service-unit needs a value}; shift 2 ;;
    --sudo) USE_SUDO=1; shift ;;
    --json) JSON=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'hardening-check: unknown option %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$KEY_FILE" ]; then
  KEY_FILE=$KEY_DIR/signer.pem
fi

PASS_N=0
FAIL_N=0
UNKNOWN_N=0
JSON_FIRST=1

have() {
  command -v "$1" >/dev/null 2>&1
}

json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/	/\\t/g' -e 's/\r//g' -e 's/[[:cntrl:]]//g' \
    | tr -d '\n'
}

emit() {
  # emit STATUS NAME MESSAGE PROBE
  _status=$1
  _name=$2
  _message=$3
  _probe=$4
  case "$_status" in
    PASS) PASS_N=$((PASS_N + 1)) ;;
    FAIL) FAIL_N=$((FAIL_N + 1)) ;;
    UNKNOWN) UNKNOWN_N=$((UNKNOWN_N + 1)) ;;
  esac
  if [ "$JSON" -eq 1 ]; then
    if [ "$JSON_FIRST" -eq 1 ]; then
      JSON_FIRST=0
    else
      printf ','
    fi
    printf '{"name":"%s","status":"%s","message":"%s","probe":"%s"}' \
      "$(json_escape "$_name")" "$_status" "$(json_escape "$_message")" "$(json_escape "$_probe")"
  else
    printf '%-7s %-24s %s\n' "$_status" "$_name" "$_message"
  fi
}

# GNU stat first, BSD stat as a fallback. Output: uid gid mode type.
if stat -c '%a' / >/dev/null 2>&1; then
  STAT_STYLE=gnu
else
  STAT_STYLE=bsd
fi

stat_info() {
  if [ "$STAT_STYLE" = gnu ]; then
    stat -c '%u %g %a %F' "$1" 2>/dev/null
  else
    stat -f '%u %g %Lp %HT' "$1" 2>/dev/null
  fi
}

uid_of() {
  if have getent; then
    getent passwd "$1" 2>/dev/null | awk -F: 'NR == 1 { print $3 }'
  else
    id -u "$1" 2>/dev/null
  fi
}

user_exists() {
  [ -n "$(uid_of "$1")" ]
}

systemctl_prop() {
  # systemctl_prop UNIT PROPERTY
  systemctl show -p "$2" "$1" 2>/dev/null | sed -n "s/^$2=//p" | head -n 1
}

# ---------------------------------------------------------------- checks

check_euid() {
  _uid=$(id -u 2>/dev/null || true)
  if [ -z "$_uid" ]; then
    emit UNKNOWN euid_not_root "id -u failed" "id -u"
  elif [ "$_uid" = 0 ]; then
    emit FAIL euid_not_root "running as root; root can read every key and rewrite every gate" "id -u"
  else
    emit PASS euid_not_root "euid $_uid is not root" "id -u"
  fi
}

check_agent_user() {
  if user_exists "$AGENT_USER"; then
    emit PASS agent_user "user $AGENT_USER exists (uid $(uid_of "$AGENT_USER"))" "getent passwd $AGENT_USER"
  else
    emit UNKNOWN agent_user "user $AGENT_USER not found; pass --agent-user" "getent passwd $AGENT_USER"
  fi
}

check_agent_groups() {
  if ! user_exists "$AGENT_USER"; then
    emit UNKNOWN agent_groups "cannot inspect groups: user $AGENT_USER not found" "id -Gn $AGENT_USER"
    return
  fi
  _groups=$(id -Gn "$AGENT_USER" 2>/dev/null || true)
  if [ -z "$_groups" ]; then
    emit UNKNOWN agent_groups "id -Gn $AGENT_USER returned nothing" "id -Gn $AGENT_USER"
    return
  fi
  _hard=
  _policy=
  _hard_list=" root docker libvirt lxd disk adm systemd-journal "
  _policy_list=" wheel sudo "
  # shellcheck disable=SC2086
  for _g in $_groups; do
    case "$_hard_list" in
      *" $_g "*) _hard="$_hard $_g" ;;
    esac
    case "$_policy_list" in
      *" $_g "*) _policy="$_policy $_g" ;;
    esac
  done
  if [ -n "$_hard" ]; then
    emit FAIL agent_groups "root-equivalent group(s):$_hard; remove and log in again" "id -Gn $AGENT_USER"
  elif [ -n "$_policy" ]; then
    emit UNKNOWN agent_groups "wheel/sudo membership is a policy decision; reported but not failed:$_policy" "id -Gn $AGENT_USER"
  else
    emit PASS agent_groups "no hard root-equivalent group membership in: $_groups" "id -Gn $AGENT_USER"
  fi
}

check_ptrace_scope() {
  if ! have sysctl; then
    emit UNKNOWN ptrace_scope "sysctl is unavailable" "sysctl -n kernel.yama.ptrace_scope"
    return
  fi
  _scope=$(sysctl -n kernel.yama.ptrace_scope 2>/dev/null || true)
  if [ -z "$_scope" ]; then
    emit UNKNOWN ptrace_scope "Yama ptrace_scope is unavailable (non-Linux kernel or no Yama)" "sysctl -n kernel.yama.ptrace_scope"
    return
  fi
  case "$_scope" in
    2) emit PASS ptrace_scope "ptrace_scope=2 (admin-only attach)" "sysctl -n kernel.yama.ptrace_scope" ;;
    3) emit PASS ptrace_scope "ptrace_scope=3 (no attach)" "sysctl -n kernel.yama.ptrace_scope" ;;
    0) emit FAIL ptrace_scope "ptrace_scope=0: any same-UID process can attach and read memory" "sysctl -n kernel.yama.ptrace_scope" ;;
    1) emit FAIL ptrace_scope "ptrace_scope=1 still permits an ancestor (the shell that started OpenCode) to trace; use 2" "sysctl -n kernel.yama.ptrace_scope" ;;
    *) emit UNKNOWN ptrace_scope "unrecognised ptrace_scope=$_scope" "sysctl -n kernel.yama.ptrace_scope" ;;
  esac
}

check_hidepid() {
  if ! have findmnt; then
    emit UNKNOWN proc_hidepid "findmnt is unavailable" "findmnt -no OPTIONS /proc"
    return
  fi
  _opts=$(findmnt -no OPTIONS /proc 2>/dev/null || true)
  if [ -z "$_opts" ]; then
    emit UNKNOWN proc_hidepid "could not read /proc mount options" "findmnt -no OPTIONS /proc"
    return
  fi
  case "$_opts" in
    *hidepid=2*|*hidepid=invisible*)
      emit PASS proc_hidepid "hidepid is set; this hides other users' processes, not same-UID processes" "findmnt -no OPTIONS /proc"
      ;;
    *)
      emit UNKNOWN proc_hidepid "hidepid is not set; marginal for this threat and not a same-UID control" "findmnt -no OPTIONS /proc"
      ;;
  esac
}

check_auditd() {
  if ! have systemctl; then
    emit UNKNOWN auditd_active "systemctl is unavailable" "systemctl show -p LoadState -p ActiveState auditd.service"
    return
  fi
  _load=$(systemctl_prop auditd.service LoadState)
  _active=$(systemctl_prop auditd.service ActiveState)
  if [ -z "$_load" ] || [ "$_load" = not-found ]; then
    emit UNKNOWN auditd_active "auditd.service is not loaded; rule contents are not inspected by this probe" "systemctl show -p LoadState -p ActiveState auditd.service"
  elif [ "$_active" = active ]; then
    emit PASS auditd_active "auditd is active; verify rules separately with auditctl -l" "systemctl show -p LoadState -p ActiveState auditd.service"
  else
    emit FAIL auditd_active "auditd.service is $_active; audit events are not being recorded" "systemctl show -p LoadState -p ActiveState auditd.service"
  fi
}

check_key_dir() {
  if ! have stat; then
    emit UNKNOWN key_dir "stat is unavailable" "stat -c '%u %g %a %F' $KEY_DIR"
    return
  fi
  _info=$(stat_info "$KEY_DIR") || {
    emit UNKNOWN key_dir "$KEY_DIR does not exist or cannot be stat'ed" "stat -c '%u %g %a %F' $KEY_DIR"
    return
  }
  # shellcheck disable=SC2086
  set -- $_info
  _uid=$1 _gid=$2 _mode=$3 _type=$4
  case "$_type" in Directory) _type=directory ;; esac
  if [ "$_type" != directory ]; then
    emit FAIL key_dir "$KEY_DIR is not a directory ($_type)" "stat -c '%u %g %a %F' $KEY_DIR"
    return
  fi
  _mode=$((0$_mode))
  if [ "$_mode" -ne $((0700)) ]; then
    emit FAIL key_dir "mode $(printf '%04o' "$_mode") is not 0700 (uid $_uid)" "stat -c '%u %g %a %F' $KEY_DIR"
    return
  fi
  _agent_uid=$(uid_of "$AGENT_USER")
  if [ -n "$_agent_uid" ] && [ "$_uid" = "$_agent_uid" ]; then
    emit FAIL key_dir "owned by the workload uid $_uid; the signer key must not be in the agent's UID" "stat -c '%u %g %a %F' $KEY_DIR"
    return
  fi
  _signer_uid=$(uid_of "$SIGNER_USER")
  if [ -n "$_signer_uid" ] && [ "$_uid" != "$_signer_uid" ]; then
    emit UNKNOWN key_dir "mode 0700 but owner uid $_uid is not $SIGNER_USER (uid $_signer_uid)" "stat -c '%u %g %a %F' $KEY_DIR"
    return
  fi
  emit PASS key_dir "mode 0700, owner uid $_uid" "stat -c '%u %g %a %F' $KEY_DIR"
}

check_key_file() {
  if ! have stat; then
    emit UNKNOWN key_file "stat is unavailable" "stat -c '%u %g %a %F' $KEY_FILE"
    return
  fi
  _info=$(stat_info "$KEY_FILE") || {
    emit UNKNOWN key_file "$KEY_FILE does not exist (or the signer uses a different name); pass --key-file" "stat -c '%u %g %a %F' $KEY_FILE"
    return
  }
  # shellcheck disable=SC2086
  set -- $_info
  _uid=$1 _gid=$2 _mode=$3 _type=$4
  case "$_type" in
    Directory) _type=directory ;;
    "Regular File") _type=regular ;;
    "Symbolic Link") _type=symlink ;;
  esac
  if [ "$_type" != regular ]; then
    emit FAIL key_file "$KEY_FILE is not a regular file ($_type)" "stat -c '%u %g %a %F' $KEY_FILE"
    return
  fi
  _mode=$((0$_mode))
  if [ $((_mode & 0077)) -ne 0 ]; then
    emit FAIL key_file "mode $(printf '%04o' "$_mode") grants group/other access; expected 0600 or 0400" "stat -c '%u %g %a %F' $KEY_FILE"
    return
  fi
  _agent_uid=$(uid_of "$AGENT_USER")
  if [ -n "$_agent_uid" ] && [ "$_uid" = "$_agent_uid" ]; then
    emit FAIL key_file "owned by the workload uid $_uid" "stat -c '%u %g %a %F' $KEY_FILE"
    return
  fi
  emit PASS key_file "mode $(printf '%04o' "$_mode"), owner uid $_uid" "stat -c '%u %g %a %F' $KEY_FILE"
}

check_approval_dir() {
  if ! have stat; then
    emit UNKNOWN approval_dir "stat is unavailable" "stat -c '%u %g %a %F' $APPROVAL_DIR"
    return
  fi
  _info=$(stat_info "$APPROVAL_DIR") || {
    emit UNKNOWN approval_dir "$APPROVAL_DIR does not exist or cannot be stat'ed" "stat -c '%u %g %a %F' $APPROVAL_DIR"
    return
  }
  # shellcheck disable=SC2086
  set -- $_info
  _uid=$1 _gid=$2 _mode=$3 _type=$4
  case "$_type" in
    Directory) _type=directory ;;
    "Symbolic Link") _type=symlink ;;
  esac
  if [ "$_type" != directory ]; then
    emit FAIL approval_dir "$APPROVAL_DIR is not a real directory ($_type)" "stat -c '%u %g %a %F' $APPROVAL_DIR"
    return
  fi
  _mode=$((0$_mode))
  if [ $((_mode & 0007)) -ne 0 ]; then
    emit FAIL approval_dir "mode $(printf '%04o' "$_mode") grants other access; expected 0750 or stricter" "stat -c '%u %g %a %F' $APPROVAL_DIR"
    return
  fi
  if [ $((_mode & 0022)) -ne 0 ]; then
    emit FAIL approval_dir "mode $(printf '%04o' "$_mode") is group/other writable" "stat -c '%u %g %a %F' $APPROVAL_DIR"
    return
  fi
  _agent_uid=$(uid_of "$AGENT_USER")
  if [ -n "$_agent_uid" ] && [ "$_uid" = "$_agent_uid" ]; then
    emit FAIL approval_dir "owned by the workload uid $_uid; approvals must come from a different principal" "stat -c '%u %g %a %F' $APPROVAL_DIR"
    return
  fi
  _approver_uid=$(uid_of "$APPROVER_USER")
  if [ -n "$_approver_uid" ] && [ "$_uid" != "$_approver_uid" ]; then
    emit UNKNOWN approval_dir "owner uid $_uid is not $APPROVER_USER (uid $_approver_uid) but is not the workload" "stat -c '%u %g %a %F' $APPROVAL_DIR"
    return
  fi
  emit PASS approval_dir "mode $(printf '%04o' "$_mode"), owner uid $_uid differs from the workload" "stat -c '%u %g %a %F' $APPROVAL_DIR"
}

check_signer_approval_dir() {
  if ! have stat; then
    emit UNKNOWN signer_approval_dir "stat is unavailable" "stat -c '%u %g %a %F' $SIGNER_APPROVAL_DIR"
    return
  fi
  _info=$(stat_info "$SIGNER_APPROVAL_DIR") || {
    emit UNKNOWN signer_approval_dir "$SIGNER_APPROVAL_DIR does not exist or cannot be stat'ed" "stat -c '%u %g %a %F' $SIGNER_APPROVAL_DIR"
    return
  }
  # shellcheck disable=SC2086
  set -- $_info
  _uid=$1 _gid=$2 _mode=$3 _type=$4
  case "$_type" in
    Directory) _type=directory ;;
    "Symbolic Link") _type=symlink ;;
  esac
  if [ "$_type" != directory ]; then
    emit FAIL signer_approval_dir "$SIGNER_APPROVAL_DIR is not a real directory ($_type)" "stat -c '%u %g %a %F' $SIGNER_APPROVAL_DIR"
    return
  fi
  _mode=$((0$_mode))
  if [ $((_mode & 0007)) -ne 0 ]; then
    emit FAIL signer_approval_dir "mode $(printf '%04o' "$_mode") grants other access; the workload must not read signer approvals" "stat -c '%u %g %a %F' $SIGNER_APPROVAL_DIR"
    return
  fi
  if [ $((_mode & 0022)) -ne 0 ]; then
    emit FAIL signer_approval_dir "mode $(printf '%04o' "$_mode") is group/other writable" "stat -c '%u %g %a %F' $SIGNER_APPROVAL_DIR"
    return
  fi
  _agent_uid=$(uid_of "$AGENT_USER")
  if [ -n "$_agent_uid" ] && [ "$_uid" = "$_agent_uid" ]; then
    emit FAIL signer_approval_dir "owned by the workload uid $_uid; signer approvals must come from a different principal" "stat -c '%u %g %a %F' $SIGNER_APPROVAL_DIR"
    return
  fi
  _approver_uid=$(uid_of "$APPROVER_USER")
  if [ -n "$_approver_uid" ] && [ "$_uid" != "$_approver_uid" ]; then
    emit UNKNOWN signer_approval_dir "owner uid $_uid is not $APPROVER_USER (uid $_approver_uid) but is not the workload" "stat -c '%u %g %a %F' $SIGNER_APPROVAL_DIR"
    return
  fi
  emit PASS signer_approval_dir "mode $(printf '%04o' "$_mode"), owner uid $_uid differs from the workload; layout is <dir>/<runId>/<sha256(path)>.json" "stat -c '%u %g %a %F' $SIGNER_APPROVAL_DIR"
}

check_public_key() {
  if ! have stat; then
    emit UNKNOWN public_key "stat is unavailable" "stat -c '%u %g %a %F' $PUBLIC_KEY"
    return
  fi
  _info=$(stat_info "$PUBLIC_KEY") || {
    emit UNKNOWN public_key "$PUBLIC_KEY does not exist" "stat -c '%u %g %a %F' $PUBLIC_KEY"
    return
  }
  # shellcheck disable=SC2086
  set -- $_info
  _uid=$1 _gid=$2 _mode=$3 _type=$4
  case "$_type" in "Regular File") _type=regular ;; esac
  if [ "$_type" != regular ]; then
    emit FAIL public_key "$PUBLIC_KEY is not a regular file ($_type)" "stat -c '%u %g %a %F' $PUBLIC_KEY"
    return
  fi
  _mode=$((0$_mode))
  if [ $((_mode & 0022)) -ne 0 ]; then
    emit FAIL public_key "mode $(printf '%04o' "$_mode") is group/other writable; a replaced public key changes what verifies" "stat -c '%u %g %a %F' $PUBLIC_KEY"
    return
  fi
  if [ "$_mode" -eq $((0644)) ]; then
    emit PASS public_key "mode 0644, owner uid $_uid" "stat -c '%u %g %a %F' $PUBLIC_KEY"
  else
    emit UNKNOWN public_key "mode $(printf '%04o' "$_mode"), expected 0644" "stat -c '%u %g %a %F' $PUBLIC_KEY"
  fi
}

check_signer_code() {
  if ! have stat; then
    emit UNKNOWN signer_code "stat is unavailable" "stat on $SIGNER_PATH and each parent directory"
    return
  fi
  _info=$(stat_info "$SIGNER_PATH") || {
    emit UNKNOWN signer_code "$SIGNER_PATH does not exist" "stat -c '%u %g %a %F' $SIGNER_PATH"
    return
  }
  # shellcheck disable=SC2086
  set -- $_info
  _uid=$1 _gid=$2 _mode=$3 _type=$4
  case "$_type" in "Regular File") _type=regular ;; esac
  if [ "$_type" != regular ]; then
    emit FAIL signer_code "$SIGNER_PATH is not a regular file ($_type)" "stat -c '%u %g %a %F' $SIGNER_PATH"
    return
  fi
  _mode=$((0$_mode))
  if [ "$_uid" -ne 0 ]; then
    emit FAIL signer_code "owner uid $_uid (not root); a writable signer is replaceable by its owner" "stat -c '%u %g %a %F' $SIGNER_PATH"
    return
  fi
  if [ $((_mode & 0022)) -ne 0 ]; then
    emit FAIL signer_code "mode $(printf '%04o' "$_mode") is group/other writable" "stat -c '%u %g %a %F' $SIGNER_PATH"
    return
  fi
  _parent=$(dirname "$SIGNER_PATH")
  while [ "$_parent" != / ] && [ "$_parent" != . ]; do
    _pinfo=$(stat_info "$_parent") || {
      emit UNKNOWN signer_code "cannot stat parent $_parent" "stat on $SIGNER_PATH and each parent directory"
      return
    }
    # shellcheck disable=SC2086
    set -- $_pinfo
    _puid=$1 _pgid=$2 _pmode=$3 _ptype=$4
    _pmode=$((0$_pmode))
    if [ $((_pmode & 0022)) -ne 0 ]; then
      emit FAIL signer_code "parent directory $_parent is group/other writable" "stat on $SIGNER_PATH and each parent directory"
      return
    fi
    _parent=$(dirname "$_parent")
  done
  emit PASS signer_code "root-owned, not group/other writable; parent chain is not group/other writable" "stat on $SIGNER_PATH and each parent directory"
}

check_signer_service() {
  if ! have systemctl; then
    emit UNKNOWN signer_service "systemctl is unavailable" "systemctl show -p LoadState=... $SERVICE_UNIT"
    return
  fi
  _load=$(systemctl_prop "$SERVICE_UNIT" LoadState)
  if [ -z "$_load" ] || [ "$_load" = not-found ]; then
    emit UNKNOWN signer_service "unit $SERVICE_UNIT is not loaded" "systemctl show -p LoadState=... $SERVICE_UNIT"
    return
  fi
  _active=$(systemctl_prop "$SERVICE_UNIT" ActiveState)
  case "$SERVICE_UNIT" in
    *@.service) _template=1 ;;
    *) _template=0 ;;
  esac
  if [ "$_template" -eq 0 ] && [ "$_active" != active ]; then
    emit FAIL signer_service "unit $SERVICE_UNIT is $_active" "systemctl show -p LoadState=... $SERVICE_UNIT"
    return
  fi
  _user=$(systemctl_prop "$SERVICE_UNIT" User)
  _nnp=$(systemctl_prop "$SERVICE_UNIT" NoNewPrivileges)
  _ps=$(systemctl_prop "$SERVICE_UNIT" ProtectSystem)
  _ph=$(systemctl_prop "$SERVICE_UNIT" ProtectHome)
  _pt=$(systemctl_prop "$SERVICE_UNIT" PrivateTmp)
  _raf=$(systemctl_prop "$SERVICE_UNIT" RestrictAddressFamilies)
  _mdwe=$(systemctl_prop "$SERVICE_UNIT" MemoryDenyWriteExecute)
  _scf=$(systemctl_prop "$SERVICE_UNIT" SystemCallFilter)
  _exec=$(systemctl_prop "$SERVICE_UNIT" ExecStart)

  _missing=
  if [ -z "$_user" ]; then
    _missing="$_missing User=unset(root)"
  else
    _svc_uid=$(uid_of "$_user")
    _agent_uid=$(uid_of "$AGENT_USER")
    _signer_uid=$(uid_of "$SIGNER_USER")
    if [ -n "$_agent_uid" ] && [ "$_svc_uid" = "$_agent_uid" ]; then
      emit FAIL signer_service "service runs as the workload user $_user" "systemctl show -p User=... $SERVICE_UNIT"
      return
    fi
    if [ -n "$_signer_uid" ] && [ "$_svc_uid" != "$_signer_uid" ]; then
      _missing="$_missing User=$_user(not $SIGNER_USER)"
    fi
  fi
  [ "$_nnp" = yes ] || _missing="$_missing NoNewPrivileges"
  case "$_ps" in strict|full) ;; *) _missing="$_missing ProtectSystem" ;; esac
  case "$_ph" in yes|read-only|tmpfs) ;; *) _missing="$_missing ProtectHome" ;; esac
  [ "$_pt" = yes ] || _missing="$_missing PrivateTmp"
  case "$_raf" in *AF_UNIX*) ;; *) _missing="$_missing RestrictAddressFamilies=AF_UNIX" ;; esac
  [ "$_mdwe" = yes ] || _missing="$_missing MemoryDenyWriteExecute"
  [ -n "$_scf" ] || _missing="$_missing SystemCallFilter"
  case "$_exec" in
    *node*)
      case "$_exec" in
        *--jitless*) ;;
        *) _missing="$_missing NodeJIT(MDWE+node without --jitless)" ;;
      esac
      ;;
  esac

  if [ -n "$_missing" ]; then
    emit FAIL signer_service "missing/incorrect:$_missing" "systemctl show -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp -p RestrictAddressFamilies -p MemoryDenyWriteExecute -p SystemCallFilter $SERVICE_UNIT"
    return
  fi
  if [ "$_template" -eq 1 ]; then
    emit PASS signer_service "template directives present; per-connection instances and socket state checked separately" "systemctl show -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp -p RestrictAddressFamilies -p MemoryDenyWriteExecute -p SystemCallFilter $SERVICE_UNIT"
  else
    emit PASS signer_service "active with the expected hardening directives" "systemctl show -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp -p RestrictAddressFamilies -p MemoryDenyWriteExecute -p SystemCallFilter $SERVICE_UNIT"
  fi
}

check_signer_socket() {
  if ! have systemctl; then
    emit UNKNOWN signer_socket "systemctl is unavailable" "systemctl show -p LoadState -p ActiveState $SOCKET_UNIT"
    return
  fi
  _load=$(systemctl_prop "$SOCKET_UNIT" LoadState)
  _active=$(systemctl_prop "$SOCKET_UNIT" ActiveState)
  if [ -z "$_load" ] || [ "$_load" = not-found ]; then
    emit UNKNOWN signer_socket "socket unit $SOCKET_UNIT is not loaded" "systemctl show -p LoadState -p ActiveState $SOCKET_UNIT"
    return
  fi
  if [ "$_active" != active ]; then
    emit FAIL signer_socket "socket unit $SOCKET_UNIT is $_active" "systemctl show -p LoadState -p ActiveState $SOCKET_UNIT"
    return
  fi
  _info=$(stat_info "$SOCKET_PATH") || {
    emit FAIL signer_socket "socket unit is active but $SOCKET_PATH is missing" "stat -c '%u %g %a %F' $SOCKET_PATH"
    return
  }
  # shellcheck disable=SC2086
  set -- $_info
  _uid=$1 _gid=$2 _mode=$3 _type=$4
  case "$_type" in Socket) _type=socket ;; esac
  if [ "$_type" != socket ]; then
    emit FAIL signer_socket "$SOCKET_PATH is not a socket ($_type)" "stat -c '%u %g %a %F' $SOCKET_PATH"
    return
  fi
  _mode=$((0$_mode))
  if [ $((_mode & 0007)) -ne 0 ]; then
    emit FAIL signer_socket "socket mode $(printf '%04o' "$_mode") grants other access; expected 0660 or 0600" "stat -c '%u %g %a %F' $SOCKET_PATH"
    return
  fi
  _agent_uid=$(uid_of "$AGENT_USER")
  if [ -n "$_agent_uid" ] && [ "$_uid" = "$_agent_uid" ]; then
    emit FAIL signer_socket "socket is owned by the workload uid $_uid" "stat -c '%u %g %a %F' $SOCKET_PATH"
    return
  fi
  _signer_uid=$(uid_of "$SIGNER_USER")
  if [ -n "$_signer_uid" ] && [ "$_uid" != "$_signer_uid" ]; then
    emit UNKNOWN signer_socket "socket mode $(printf '%04o' "$_mode") but owner uid $_uid is not $SIGNER_USER (uid $_signer_uid)" "stat -c '%u %g %a %F' $SOCKET_PATH"
    return
  fi
  emit PASS signer_socket "active, mode $(printf '%04o' "$_mode"), owner uid $_uid" "systemctl show -p LoadState -p ActiveState $SOCKET_UNIT; stat -c '%u %g %a %F' $SOCKET_PATH"
}

check_selinux() {
  if ! have getenforce; then
    emit UNKNOWN selinux "getenforce is unavailable (not an SELinux host)" "getenforce"
    return
  fi
  _mode=$(getenforce 2>/dev/null || true)
  case "$_mode" in
    Enforcing) emit PASS selinux "SELinux Enforcing; labels/domains are not inspected by this probe" "getenforce" ;;
    Permissive) emit UNKNOWN selinux "SELinux Permissive records but does not deny" "getenforce" ;;
    Disabled) emit UNKNOWN selinux "SELinux Disabled" "getenforce" ;;
    *) emit UNKNOWN selinux "getenforce returned '$_mode'" "getenforce" ;;
  esac
}

check_selinux_contexts() {
  if [ "$STAT_STYLE" != gnu ]; then
    emit UNKNOWN selinux_contexts "this probe needs GNU stat -c %C" "stat -c '%C' <key-dir> <approval-dir> <signer> <socket>"
    return
  fi
  if ! have getenforce || [ "$(getenforce 2>/dev/null || true)" != Enforcing ]; then
    emit UNKNOWN selinux_contexts "SELinux is not Enforcing; file contexts are not a control" "stat -c '%C' <key-dir> <approval-dir> <signer> <socket>"
    return
  fi
  _contexts=
  for _p in "$KEY_DIR" "$APPROVAL_DIR" "$SIGNER_PATH" "$SOCKET_PATH"; do
    _ctx=$(stat -c '%C' "$_p" 2>/dev/null || true)
    if [ -n "$_ctx" ]; then
      _contexts="$_contexts $_ctx"
      case "$_ctx" in
        *:unconfined_t:*|*:unconfined_service_t:*)
          emit UNKNOWN selinux_contexts "path $_p has an unconfined domain label; Enforcing does not separate two same-UID unconfined processes ($_ctx)" "stat -c '%C' <key-dir> <approval-dir> <signer> <socket>"
          return
          ;;
      esac
    fi
  done
  if [ -z "$_contexts" ]; then
    emit UNKNOWN selinux_contexts "no SELinux contexts were readable" "stat -c '%C' <key-dir> <approval-dir> <signer> <socket>"
    return
  fi
  emit PASS selinux_contexts "contexts reported; this does not prove the agent is confined:$_contexts" "stat -c '%C' <key-dir> <approval-dir> <signer> <socket>"
}

sudo_ready() {
  [ "$USE_SUDO" -eq 1 ] || return 1
  have sudo || return 1
  sudo -n -u "$AGENT_USER" test -d / >/dev/null 2>&1
}

check_agent_key_read() {
  if ! user_exists "$AGENT_USER"; then
    emit UNKNOWN agent_key_read "user $AGENT_USER not found" "sudo -n -u $AGENT_USER test -r $KEY_DIR"
    return
  fi
  if [ "$USE_SUDO" -eq 0 ]; then
    emit UNKNOWN agent_key_read "not run; pass --sudo for the read-only sudo probe" "sudo -n -u $AGENT_USER test -r $KEY_DIR"
    return
  fi
  if ! sudo_ready; then
    emit UNKNOWN agent_key_read "sudo -n -u $AGENT_USER test -d / failed; no usable NOPASSWD test probe" "sudo -n -u $AGENT_USER test -r $KEY_DIR"
    return
  fi
  if sudo -n -u "$AGENT_USER" test -r "$KEY_DIR" 2>/dev/null; then
    emit FAIL agent_key_read "workload user can read $KEY_DIR" "sudo -n -u $AGENT_USER test -r $KEY_DIR"
  else
    emit PASS agent_key_read "workload user cannot read $KEY_DIR (test -r false; absence/inaccessibility is not distinguished)" "sudo -n -u $AGENT_USER test -r $KEY_DIR"
  fi
}

check_agent_approval_write() {
  if ! user_exists "$AGENT_USER"; then
    emit UNKNOWN agent_approval_write "user $AGENT_USER not found" "sudo -n -u $AGENT_USER test -w $APPROVAL_DIR"
    return
  fi
  if [ "$USE_SUDO" -eq 0 ]; then
    emit UNKNOWN agent_approval_write "not run; pass --sudo for the read-only sudo probe" "sudo -n -u $AGENT_USER test -w $APPROVAL_DIR"
    return
  fi
  if ! sudo_ready; then
    emit UNKNOWN agent_approval_write "sudo -n -u $AGENT_USER test -d / failed; no usable NOPASSWD test probe" "sudo -n -u $AGENT_USER test -w $APPROVAL_DIR"
    return
  fi
  if sudo -n -u "$AGENT_USER" test -w "$APPROVAL_DIR" 2>/dev/null; then
    emit FAIL agent_approval_write "workload user can write $APPROVAL_DIR" "sudo -n -u $AGENT_USER test -w $APPROVAL_DIR"
  else
    emit PASS agent_approval_write "workload user cannot write $APPROVAL_DIR (test -w false; absence/inaccessibility is not distinguished)" "sudo -n -u $AGENT_USER test -w $APPROVAL_DIR"
  fi
}

check_agent_signer_approval_read() {
  if ! user_exists "$AGENT_USER"; then
    emit UNKNOWN agent_signer_approval_read "user $AGENT_USER not found" "sudo -n -u $AGENT_USER test -r $SIGNER_APPROVAL_DIR"
    return
  fi
  if [ "$USE_SUDO" -eq 0 ]; then
    emit UNKNOWN agent_signer_approval_read "not run; pass --sudo for the read-only sudo probe" "sudo -n -u $AGENT_USER test -r $SIGNER_APPROVAL_DIR"
    return
  fi
  if ! sudo_ready; then
    emit UNKNOWN agent_signer_approval_read "sudo -n -u $AGENT_USER test -d / failed; no usable NOPASSWD test probe" "sudo -n -u $AGENT_USER test -r $SIGNER_APPROVAL_DIR"
    return
  fi
  if sudo -n -u "$AGENT_USER" test -r "$SIGNER_APPROVAL_DIR" 2>/dev/null; then
    emit FAIL agent_signer_approval_read "workload user can read $SIGNER_APPROVAL_DIR; signer approvals are policy input for the signer only" "sudo -n -u $AGENT_USER test -r $SIGNER_APPROVAL_DIR"
  else
    emit PASS agent_signer_approval_read "workload user cannot read $SIGNER_APPROVAL_DIR (test -r false; absence/inaccessibility is not distinguished)" "sudo -n -u $AGENT_USER test -r $SIGNER_APPROVAL_DIR"
  fi
}

check_agent_signer_write() {
  if ! user_exists "$AGENT_USER"; then
    emit UNKNOWN agent_signer_write "user $AGENT_USER not found" "sudo -n -u $AGENT_USER test -w $SIGNER_PATH"
    return
  fi
  if [ "$USE_SUDO" -eq 0 ]; then
    emit UNKNOWN agent_signer_write "not run; pass --sudo for the read-only sudo probe" "sudo -n -u $AGENT_USER test -w $SIGNER_PATH"
    return
  fi
  if ! sudo_ready; then
    emit UNKNOWN agent_signer_write "sudo -n -u $AGENT_USER test -d / failed; no usable NOPASSWD test probe" "sudo -n -u $AGENT_USER test -w $SIGNER_PATH"
    return
  fi
  if [ ! -f "$SIGNER_PATH" ]; then
    emit UNKNOWN agent_signer_write "$SIGNER_PATH is absent" "sudo -n -u $AGENT_USER test -w $SIGNER_PATH"
    return
  fi
  if sudo -n -u "$AGENT_USER" test -w "$SIGNER_PATH" 2>/dev/null; then
    emit FAIL agent_signer_write "workload user can write the signer executable" "sudo -n -u $AGENT_USER test -w $SIGNER_PATH"
  else
    emit PASS agent_signer_write "workload user cannot write the signer executable (test -w false)" "sudo -n -u $AGENT_USER test -w $SIGNER_PATH"
  fi
}

# ---------------------------------------------------------------- run

if [ "$JSON" -eq 1 ]; then
  printf '{"checks":['
else
  printf 'hardening-check: read-only probes (UNKNOWN is not a pass)\n'
  printf '%-7s %-24s %s\n' RESULT CHECK DETAIL
fi

check_euid
check_agent_user
check_agent_groups
check_ptrace_scope
check_hidepid
check_auditd
check_key_dir
check_key_file
check_approval_dir
check_signer_approval_dir
check_public_key
check_signer_code
check_signer_service
check_signer_socket
check_selinux
check_selinux_contexts
check_agent_key_read
check_agent_approval_write
check_agent_signer_approval_read
check_agent_signer_write

if [ "$JSON" -eq 1 ]; then
  _ok=false
  [ "$FAIL_N" -eq 0 ] && _ok=true
  printf '],"summary":{"pass":%d,"fail":%d,"unknown":%d},"ok":%s}\n' \
    "$PASS_N" "$FAIL_N" "$UNKNOWN_N" "$_ok"
else
  printf '\n%d pass, %d fail, %d unknown.\n' "$PASS_N" "$FAIL_N" "$UNKNOWN_N"
  if [ "$FAIL_N" -gt 0 ]; then
    printf 'Hardening is not satisfied: fix the FAIL probes. UNKNOWN probes were not verified.\n'
  elif [ "$UNKNOWN_N" -gt 0 ]; then
    printf 'No FAIL, but %d probe(s) are UNKNOWN and are not evidence of hardening.\n' "$UNKNOWN_N"
  else
    printf 'All probes passed. This is still not proof that the plugin, prompts, model or signer policy are unmodified.\n'
  fi
fi

[ "$FAIL_N" -eq 0 ] || exit 1
exit 0
