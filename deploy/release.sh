#!/usr/bin/env bash
# Run on the Linux host from an extracted `git archive <revision>`.
set -euo pipefail
revision=${1:?Usage: deploy/release.sh FULL_GIT_SHA}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full Git commit SHA' >&2; exit 2; }
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
test -f /etc/stripsearch/runtime.env
mkdir -p /opt/stripsearch /var/lib/stripsearch /var/backups/stripsearch
# Only one release may stop/switch this service at a time.
exec 9>/opt/stripsearch/deploy.lock
flock -n 9 || { echo 'Another StripSearch release is active' >&2; exit 1; }
chown 1000:1000 /var/lib/stripsearch
chmod 700 /var/lib/stripsearch /var/backups/stripsearch
image="stripsearch:$revision"
docker build --build-arg "REVISION=$revision" -t "$image" .
previous=''
if test -f /opt/stripsearch/image.env; then
    previous=$(sed -n 's/^STRIPSEARCH_IMAGE=//p' /opt/stripsearch/image.env)
fi
compose=(docker compose -p stripsearch --env-file /opt/stripsearch/image.env -f /opt/stripsearch/compose.yml)
snapshot=''
if test -n "$previous"; then
    test -f /var/lib/stripsearch/stripsearch.sqlite || { echo 'Prior image has no persistent database; refusing release.' >&2; exit 1; }
    "${compose[@]}" stop web
fi
if test -f /var/lib/stripsearch/stripsearch.sqlite; then
    if ! snapshot_output=$(python3 deploy/backup.py); then
        if test -n "$previous"; then "${compose[@]}" up -d --wait --wait-timeout 90; fi
        exit 1
    fi
    snapshot_name=${snapshot_output#Backup verified: }
    [[ "$snapshot_name" =~ ^[0-9]{8}T[0-9]{6}\.[0-9]{6}Z$ ]] || { echo 'Invalid backup receipt; service remains stopped.' >&2; exit 1; }
    snapshot="/var/backups/stripsearch/$snapshot_name"
    test -f "$snapshot/complete"
    printf '%s\n' "$snapshot_output"
fi
install -m 644 deploy/compose.yml /opt/stripsearch/compose.yml
printf 'STRIPSEARCH_IMAGE=%s\n' "$image" > /opt/stripsearch/image.env
rollback() {
    echo 'New release failed; stopping its writers before restoring prior data and image.' >&2
    "${compose[@]}" stop web || return 1
    if test -n "$snapshot"; then
        python3 deploy/restore.py "$snapshot" "$revision" || return 1
    elif test -n "$previous"; then
        echo 'No verified pre-release snapshot; refusing old-image startup.' >&2
        return 1
    fi
    if test -n "$previous"; then
        printf 'STRIPSEARCH_IMAGE=%s\n' "$previous" > /opt/stripsearch/image.env
        "${compose[@]}" up -d --force-recreate --wait --wait-timeout 90
    else
        "${compose[@]}" down
    fi
}
if ! "${compose[@]}" up -d --wait --wait-timeout 90; then
    rollback
    exit 1
fi
if ! "${compose[@]}" exec -T web node -e 'fetch("http://127.0.0.1:4392/release.json").then(r=>r.json()).then(j=>{if(j.revision!==process.argv[1])process.exit(1)}).catch(()=>process.exit(1))' "$revision"; then
    rollback
    exit 1
fi
mkdir -p /opt/stripsearch/ops
install -m 755 deploy/backup.py /opt/stripsearch/ops/backup.py
install -m 644 deploy/stripsearch-backup.service deploy/stripsearch-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now stripsearch-backup.timer
printf '%s\n' "$revision" > /opt/stripsearch/deployed-revision
printf 'Deployed and healthy: %s\n' "$revision"
