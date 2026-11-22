"""Send an already signed Bleynar APK to a draft release through GitHub Actions."""
import argparse
import base64
import hashlib
import http.client
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode

REPOSITORY_ID = 1467567653
PACKAGE = "ru.bleynar.channel"
CERTIFICATE = "f16643f2d5d9688d87bbb49864451b7aaea5c90f9b643e8976a2d090a8256bd4"
EVENT = "bleynar-release-apk"
WORKFLOW = "bleynar-release.yml"


def gh(path, *, method="GET", data=None, raw=False):
    args = ["gh", "api", "--hostname", "github.com", "--method", method, path]
    if raw:
        args += ["-H", "Accept: application/octet-stream"]
    if data is not None:
        args += ["--input", "-"]
    result = subprocess.run(args, input=json.dumps(data).encode() if data is not None else None,
                            capture_output=True, timeout=150)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace").strip() or "GitHub request failed")
    if raw:
        return result.stdout
    return json.loads(result.stdout) if result.stdout.strip() else None


def android_tool(name):
    for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        if os.environ.get(key):
            candidates = [p for p in (Path(os.environ[key]) / "build-tools").glob("*/" + name)
                          if re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", p.parent.name)]
            if candidates:
                return max(candidates, key=lambda p: tuple(map(int, p.parent.name.split("."))))
    tool = shutil.which(name)
    if not tool:
        raise ValueError("Install Android SDK Build Tools or set ANDROID_HOME for " + name)
    return tool


def apk_filename(apk, release):
    signer = android_tool("apksigner")
    info = subprocess.check_output([signer, "verify", "--print-certs-pem", apk], text=True)
    pem_blocks = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", info, re.S)
    fingerprints = {hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest() for pem in pem_blocks}
    if fingerprints != {CERTIFICATE}:
        raise ValueError(f"Unexpected APK certificate ({signer}): {sorted(fingerprints)}")
    badging = subprocess.check_output([android_tool("aapt"), "dump", "badging", apk], text=True)
    package = re.search(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'", badging, re.M)
    if not package or package[1] != PACKAGE or int(package[2]) < 1:
        raise ValueError("Unexpected Android package or version code")
    version = package[3]
    if not re.fullmatch(r"[0-9][0-9A-Za-z.+_-]{0,47}", version):
        raise ValueError("Invalid APK version name")
    tag = re.escape("v" + version)
    if release["prerelease"]:
        tag += r"(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?"
    if not re.fullmatch(tag, release["tag_name"]):
        raise ValueError("The release tag differs from the signed APK version")
    return f"Bleynar-{version}.apk"


def correct_asset(repo, release, name, digest, size):
    for asset in release["assets"]:
        if asset["name"] != name:
            continue
        if asset["state"] != "uploaded" or asset["size"] != size:
            raise ValueError("An unfinished or different file already has this asset name")
        actual = asset.get("digest")
        if not actual:
            contents = gh(f"{repo}/releases/assets/{asset['id']}", raw=True)
            actual = "sha256:" + hashlib.sha256(contents).hexdigest()
        if actual != "sha256:" + digest:
            raise ValueError("An asset with this name has a different checksum")
        return asset
    return None


def release_path(repo, release_id):
    if type(release_id) is not int or release_id <= 0:
        raise ValueError("Expected a positive GitHub release ID")
    return f"{repo}/releases/{release_id}"


def attach(repo):
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if event.get("action") != EVENT or event["repository"]["id"] != REPOSITORY_ID:
        raise ValueError("Unexpected dispatch event or repository")
    payload = event["client_payload"]
    sha, digest = payload["blob"], payload["sha256"]
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid blob ID or SHA-256")
    path = release_path(repo, payload["release_id"])
    blob = gh(f"{repo}/git/blobs/{sha}")
    content = base64.b64decode(blob["content"])
    if blob["sha"] != sha or len(content) != blob["size"] or hashlib.sha256(content).hexdigest() != digest:
        raise ValueError("The staged bytes differ from the requested APK")
    with tempfile.TemporaryDirectory() as tmp:
        apk = Path(tmp) / "release.apk"
        apk.write_bytes(content)
        release = gh(path)
        name = apk_filename(apk, release)
        existing = correct_asset(repo, release, name, digest, len(content))
        if existing:
            print("Verified existing asset", existing["id"], name)
            return
        if not release["draft"]:
            raise ValueError("Only draft releases accept new assets through this workflow")
        url = "https://uploads.github.com/" + path + "/assets"
        if release["upload_url"].split("{")[0] != url:
            raise ValueError("GitHub returned an unexpected release upload endpoint")
        connection = http.client.HTTPSConnection("uploads.github.com", timeout=120)
        try:
            connection.request("POST", "/" + path + "/assets?" + urlencode({"name": name}), body=content,
                               headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                                        "Content-Type": "application/vnd.android.package-archive",
                                        "Accept": "application/vnd.github+json", "User-Agent": "Bleynar-Releases"})
            response = connection.getresponse()
            status = response.status
            response.read()
        finally:
            connection.close()
        if status != 201 and not correct_asset(repo, gh(path), name, digest, len(content)):
            raise ValueError(f"GitHub rejected the release attachment (HTTP {status})")
        if not correct_asset(repo, gh(path), name, digest, len(content)):
            raise ValueError("GitHub did not return the uploaded asset")
        print("Verified uploaded asset", name, digest)


def dispatch(repo, args):
    path = release_path(repo, args.release_id)
    release = gh(path)
    apk = args.apk.resolve()
    name = apk_filename(apk, release)
    content = apk.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if correct_asset(repo, release, name, digest, len(content)):
        print("Already attached and verified", name, digest)
        return
    if not release["draft"]:
        raise ValueError("Select a draft release")
    workflow = gh(f"{repo}/actions/workflows/{WORKFLOW}")
    if workflow["state"] != "active":
        raise ValueError("The upload workflow is disabled")
    blob = gh(f"{repo}/git/blobs", method="POST",
              data={"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"})
    oid = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
    if blob["sha"] != oid:
        raise ValueError("GitHub returned a different Git blob ID")
    request_id = uuid.uuid4().hex
    gh(f"{repo}/dispatches", method="POST", data={"event_type": EVENT, "client_payload": {
        "release_id": args.release_id, "blob": oid, "sha256": digest, "request_id": request_id}})
    print("Dispatched", name, "request", request_id, flush=True)
    run = None
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        if run is None:
            listing = gh(f"{repo}/actions/workflows/{WORKFLOW}/runs?event=repository_dispatch&per_page=50")
            run = next((r for r in listing["workflow_runs"]
                        if r["display_title"] == "Bleynar APK · " + request_id), None)
            if run:
                print("Workflow", run["html_url"], flush=True)
        else:
            run = gh(f"{repo}/actions/runs/{run['id']}")
        if run and run["status"] == "completed":
            if run["conclusion"] != "success":
                raise ValueError("Workflow " + str(run["conclusion"]) + ": " + run["html_url"])
            if correct_asset(repo, gh(path), name, digest, len(content)):
                print("Attached and verified", name, digest)
                return
            raise ValueError("The job completed without the expected asset")
        time.sleep(8)
    raise TimeoutError("GitHub has not finished the upload; check Actions before retrying")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    sender = commands.add_parser("dispatch", help="Verify and attach an APK from this computer")
    sender.add_argument("release_id", type=int, help="Numeric ID of an existing draft release")
    sender.add_argument("apk", type=Path)
    commands.add_parser("attach", help="GitHub Actions worker")
    args = parser.parse_args()
    project = gh(f"repositories/{REPOSITORY_ID}")
    repo = "repos/" + project["full_name"]
    if args.command == "dispatch":
        dispatch(repo, args)
    elif os.environ.get("GITHUB_REPOSITORY_ID") == str(REPOSITORY_ID):
        attach(repo)
    else:
        raise ValueError("The attach command runs in the distribution repository's Actions job")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, TimeoutError, subprocess.SubprocessError) as exc:
        sys.exit(str(exc))
